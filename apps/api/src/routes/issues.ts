// /api/v1/issues — 问题与讨论（设计 12/16 章：Issue 锁定报告所针对的版本）。
// 越权修复（M57）：withTeam 只设置 RLS 租户上下文，不校验调用者归属——teamId 来自
// 请求体时必须先显式验证成员身份，否则任何登录用户可伪造他团队 teamId 读写下发
// （与 M56 集合路由同类缺陷，跨租户走查扫描发现）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

export async function issueRoutes(app: FastifyInstance): Promise<void> {
  app.post("/issues", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        projectId: z.string().uuid(),
        title: z.string().min(1).max(200),
        body: z.string().max(16000).default(""),
        assetId: z.string().uuid().optional(),
        reportedRevisionId: z.string().uuid().optional(),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      if (body.reportedRevisionId) {
        if (!body.assetId) throw ERR.INVALID("reportedRevisionId 必须与 assetId 同时提供");
        const { rows } = await client.query(
          `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND id = $2 AND asset_id = $3`,
          [body.teamId, body.reportedRevisionId, body.assetId]
        );
        if (!rows[0]) throw ERR.INVALID("报告修订与资产不匹配");
      }
      await client.query(
        `INSERT INTO issues (team_id, id, project_id, asset_id, reported_revision_id, title, body, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [body.teamId, id, body.projectId, body.assetId ?? null, body.reportedRevisionId ?? null, body.title, body.body, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, issueId: id });
  });

  app.get("/projects/:projectId/issues", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();
    return withTeam(teamId, async (client) => {
      const { rows: issues } = await client.query(
        `SELECT i.id, i.title, i.body, i.status, i.asset_id, i.reported_revision_id,
                a.name AS asset_name, i.created_at, u.display_name AS created_by_name
           FROM issues i
           LEFT JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           JOIN users u ON u.id = i.created_by
          WHERE i.team_id = $1 AND i.project_id = $2 ORDER BY i.created_at DESC`,
        [teamId, projectId]
      );
      return issues;
    });
  });

  app.post("/issues/:issueId/status", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { issueId } = req.params as { issueId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), status: z.enum(["open", "in_progress", "resolved", "closed"]) }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ created_by: string }>(
        `SELECT created_by FROM issues WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, issueId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      // 报告人与团队成员都可推进状态（日常协作不需审批，设计 2 章）
      await client.query(`UPDATE issues SET status = $3 WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        issueId,
        body.status,
      ]);
      void rows;
    });
    return { ok: true };
  });

  app.post("/issues/:issueId/comments", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { issueId } = req.params as { issueId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), content: z.string().min(1).max(8000) }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM issues WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        issueId,
      ]);
      if (!rows[0]) throw ERR.NOT_FOUND();
      await client.query(
        `INSERT INTO comments (team_id, id, target_kind, target_id, author_id, content)
         VALUES ($1, $2, 'issue', $3, $4, $5)`,
        [body.teamId, id, issueId, auth.userId, body.content]
      );
    });
    return reply.code(201).send({ commentId: id });
  });

  app.get("/issues/:issueId/comments", async (req) => {
    const auth = requireAuth(req);
    const { issueId } = req.params as { issueId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();
    return withTeam(teamId, async (client) => {
      const { rows: comments } = await client.query(
        `SELECT c.id, c.content, c.created_at, u.display_name AS author
           FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.team_id = $1 AND c.target_kind = 'issue' AND c.target_id = $2 ORDER BY c.created_at`,
        [teamId, issueId]
      );
      return comments;
    });
  });
}
