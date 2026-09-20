// /api/v1/projects + sessions — 项目与项目会话（设计 4/16 章）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, withTeam, withTx } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

async function assertTeamMember(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

async function assertProjectAccess(
  userId: string,
  teamId: string,
  projectId: string
): Promise<{ role: string; isMember: boolean }> {
  const role = await assertTeamMember(userId, teamId);
  // project_members 受 RLS，需在租户上下文内查询
  const isMember = await withTeam(teamId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM project_members WHERE team_id = $1 AND project_id = $2 AND user_id = $3`,
      [teamId, projectId, userId]
    );
    return rows.length > 0;
  });
  return { role, isMember };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post("/projects", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().min(1).max(128),
        code: z.string().regex(/^[a-z0-9-]{2,32}$/),
      }),
      req.body
    );
    await assertTeamMember(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(`INSERT INTO entities (team_id, id, kind) VALUES ($1, $2, 'project')`, [
        body.teamId,
        id,
      ]);
      await client.query(
        `INSERT INTO projects (team_id, id, name, code, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [body.teamId, id, body.name, body.code, auth.userId]
      );
      await client.query(
        `INSERT INTO project_members (team_id, project_id, user_id, role) VALUES ($1, $2, $3, 'lead')`,
        [body.teamId, id, auth.userId]
      );
      // main 分支：受保护的正式发布内容视图（设计 12 章）
      await client.query(
        `INSERT INTO branches (team_id, id, project_id, name, created_by) VALUES ($1, $2, $3, 'main', $4)`,
        [body.teamId, newId(), id, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, projectId: id, name: body.name, code: body.code });
  });

  app.get("/projects", async (req) => {
    const auth = requireAuth(req);
    // 服务端从成员关系反查可见项目；RLS 表必须逐团队在租户上下文内查询
    const { rows: teams } = await q<{ team_id: string }>(
      `SELECT team_id FROM team_members WHERE user_id = $1`,
      [auth.userId]
    );
    const all: { teamId: string; projectId: string; name: string; code: string; status: string }[] = [];
    for (const t of teams) {
      // 团队管理员有团队级视野：可见团队全部项目（与发布权一致）；
      // 普通成员仅可见自己参与的项目。
      const { rows: roleRows } = await q<{ role: string }>(
        `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [t.team_id, auth.userId]
      );
      const isAdmin = roleRows[0]?.role === "admin";
      const rows = await withTeam(t.team_id, async (client) =>
        client.query<{ id: string; name: string; code: string; status: string }>(
          `SELECT p.id, p.name, p.code, p.status
             FROM projects p
            WHERE EXISTS (
                    SELECT 1 FROM project_members pm
                     WHERE pm.team_id = p.team_id AND pm.project_id = p.id AND pm.user_id = $1
                  )
               OR $2::boolean
            ORDER BY p.created_at DESC`,
          [auth.userId, isAdmin]
        )
      );
      for (const r of rows.rows) {
        all.push({ teamId: t.team_id, projectId: r.id, name: r.name, code: r.code, status: r.status });
      }
    }
    return all;
  });

  app.post("/projects/:projectId/sessions", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        title: z.string().min(1).max(128),
        visibility: z.enum(["private", "project"]).default("private"),
      }),
      req.body
    );
    await assertProjectAccess(auth.userId, body.teamId, projectId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(
        `INSERT INTO sessions (team_id, id, project_id, title, visibility, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.teamId, id, projectId, body.title, body.visibility, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, sessionId: id, projectId, title: body.title });
  });

  app.get("/projects/:projectId/sessions", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String(req.query ? (req.query as { teamId?: string }).teamId ?? "" : "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertProjectAccess(auth.userId, teamId, projectId);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query<{ id: string; title: string; visibility: string; created_by: string; archived: boolean }>(
        `SELECT id, title, visibility, created_by, archived FROM sessions
          WHERE team_id = $1 AND project_id = $2
            AND (visibility = 'project' OR created_by = $3)
          ORDER BY created_at DESC`,
        [teamId, projectId, auth.userId]
      )
    );
    return rows.map((r) => ({
      sessionId: r.id,
      title: r.title,
      visibility: r.visibility,
      mine: r.created_by === auth.userId,
      archived: r.archived,
    }));
  });
}
