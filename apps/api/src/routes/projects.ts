// /api/v1/projects + sessions — 项目与项目会话（设计 4/16 章）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, withTeam, withTx } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { subscribeActivity } from "../activityHub.js";

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

  // ---------- 项目总览（仪表盘统计，一次聚合查询；AgentPM Dashboard 范式） ----------
  app.get("/projects/:projectId/overview", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertProjectAccess(auth.userId, teamId, projectId);
    return withTeam(teamId, async (client) => {
      const { rows: proj } = await client.query<{ id: string; name: string; code: string; status: string; created_at: string }>(
        `SELECT id, name, code, status, created_at FROM projects WHERE team_id = $1 AND id = $2`,
        [teamId, projectId]
      );
      if (!proj[0]) throw ERR.NOT_FOUND();

      // 分支与变更请求（项目域）
      const { rows: branchCounts } = await client.query<{ open: string; total: string }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::text AS open, count(*)::text AS total
           FROM branches WHERE team_id = $1 AND project_id = $2`,
        [teamId, projectId]
      );
      const { rows: crCounts } = await client.query<{
        open: string;
        awaiting: string;
        changes_requested: string;
        merged: string;
      }>(
        `SELECT count(*) FILTER (WHERE status = 'open')::text AS open,
                count(*) FILTER (WHERE status = 'awaiting_review')::text AS awaiting,
                count(*) FILTER (WHERE status = 'changes_requested')::text AS changes_requested,
                count(*) FILTER (WHERE status = 'merged')::text AS merged
           FROM change_requests WHERE team_id = $1 AND project_id = $2`,
        [teamId, projectId]
      );
      // 发布（项目域，经通道归属；近 30 天口径）
      const { rows: releaseCounts } = await client.query<{ total: string; last30d: string }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE rs.created_at > now() - interval '30 days')::text AS last30d
           FROM release_sets rs
           JOIN change_requests cr ON cr.team_id = rs.team_id AND cr.id = rs.change_request_id
          WHERE rs.team_id = $1 AND cr.project_id = $2`,
        [teamId, projectId]
      );

      // 资产库与关系（团队域，如实标注）
      const { rows: assetCounts } = await client.query<{ active: string; archived: string }>(
        `SELECT count(*) FILTER (WHERE lifecycle = 'archived')::text AS archived,
                count(*) FILTER (WHERE lifecycle <> 'archived')::text AS active
           FROM assets WHERE team_id = $1`,
        [teamId]
      );
      const { rows: revisionCounts } = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM asset_revisions WHERE team_id = $1`,
        [teamId]
      );
      const { rows: relationCounts } = await client.query<{ confirmed: string; proposed: string }>(
        `SELECT count(*) FILTER (WHERE status = 'confirmed')::text AS confirmed,
                count(*) FILTER (WHERE status = 'proposed')::text AS proposed
           FROM relation_assertions WHERE team_id = $1`,
        [teamId]
      );

      const n = (v: string | undefined): number => Number(v ?? "0");
      return {
        project: proj[0],
        projectScope: {
          branches: { open: n(branchCounts[0]?.open), total: n(branchCounts[0]?.total) },
          changeRequests: {
            open: n(crCounts[0]?.open),
            awaitingReview: n(crCounts[0]?.awaiting),
            changesRequested: n(crCounts[0]?.changes_requested),
            merged: n(crCounts[0]?.merged),
          },
          releases: { total: n(releaseCounts[0]?.total), last30d: n(releaseCounts[0]?.last30d) },
        },
        teamScope: {
          assets: { active: n(assetCounts[0]?.active), archived: n(assetCounts[0]?.archived) },
          revisions: n(revisionCounts[0]?.total),
          relations: { confirmed: n(relationCounts[0]?.confirmed), proposed: n(relationCounts[0]?.proposed) },
        },
      };
    });
  });

  // ---------- 团队活动流（事件溯源红利：直接读审计 + Agent 运行，零新表） ----------
  // audit_events = 人的治理动作（归档/发布/审核准备/回滚…）；
  // agent_runs = Agent 动作（人机混排时间线，参考 AgentPM 活动页）。
  const ACTION_LABELS: Record<string, string> = {
    "asset.archive": "归档资产",
    "asset.restore": "恢复资产",
    "review_prepared": "准备审核快照",
    "release_published": "发布到通道",
    "release_rollback": "通道回滚",
  };
  app.get("/activity", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; limit?: string; projectId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertTeamMember(auth.userId, teamId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    // 项目过滤语义：项目级动作（审核准备/发布/回滚、Agent 运行）带 project_id；
    // 团队级动作（资产归档/恢复等）为 NULL——按项目过滤时仅显示该项目内的动作。
    const filterProjectId = /^[0-9a-f-]{36}$/.test(String(query.projectId ?? "")) ? String(query.projectId) : null;
    return withTeam(teamId, async (client) => {
      const { rows: audits } = await client.query<{
        id: string;
        ts: string;
        action: string;
        object_kind: string;
        object_id: string | null;
        actor: string | null;
        detail: Record<string, unknown>;
      }>(
        `SELECT a.id::text AS id, a.created_at AS ts, a.action, a.object_kind, a.object_id, u.display_name AS actor, a.detail
           FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
          WHERE a.team_id = $1 AND ($3::uuid IS NULL OR a.project_id = $3::uuid)
          ORDER BY a.created_at DESC LIMIT $2`,
        [teamId, limit, filterProjectId]
      );
      const { rows: agentRuns } = await client.query<{
        id: string;
        ts: string;
        prompt: string;
        status: string;
        actor: string | null;
        project_name: string | null;
        session_title: string | null;
      }>(
        `SELECT r.id::text AS id, r.created_at AS ts, r.prompt, r.status, u.display_name AS actor,
                p.name AS project_name, s.title AS session_title
           FROM agent_runs r
           LEFT JOIN users u ON u.id = r.created_by
           LEFT JOIN projects p ON p.team_id = r.team_id AND p.id = r.project_id
           LEFT JOIN sessions s ON s.team_id = r.team_id AND s.id = r.session_id
          WHERE r.team_id = $1 AND ($3::uuid IS NULL OR r.project_id = $3::uuid)
          ORDER BY r.created_at DESC LIMIT $2`,
        [teamId, limit, filterProjectId]
      );
      interface ActivityItem {
        key?: string;
        ts: string;
        kind: "audit" | "agent";
        action: string;
        summary: string;
        actor: string;
        objectId: string | null;
        project?: string;
      }
      const items: ActivityItem[] = [
        ...audits.map((a): ActivityItem => ({
          key: `audit:${a.id}`,
          ts: a.ts,
          kind: "audit",
          action: a.action,
          summary: ACTION_LABELS[a.action] ?? a.action,
          actor: a.actor ?? "系统",
          objectId: a.object_id,
        })),
        ...agentRuns.map((r): ActivityItem => ({
          key: `agent:${r.id}`,
          ts: r.ts,
          kind: "agent",
          action: `agent.run.${r.status}`,
          summary: r.prompt.length > 80 ? `${r.prompt.slice(0, 80)}…` : r.prompt,
          actor: r.actor ?? "Agent",
          objectId: null,
          project: r.project_name ?? undefined,
        })),
      ]
        .sort((x, y) => (x.ts < y.ts ? 1 : -1))
        .slice(0, limit);
      return { items };
    });
  });

  // ---------- 活动流实时推送（SSE） ----------
  // 数据链路：0018 触发器在审计/运行落库提交时 pg_notify → activityHub 单例 LISTEN
  // → 按团队扇出到这里的回调；事件正文按 id 实时取（与 GET /activity 同一标签语义），
  // 保证推送与列表接口同源。NOTIFY 只在事务提交后投递——回滚不会产生幻影事件。
  const streamItem = async (
    teamId: string,
    kind: "audit" | "agent",
    id: string,
    filterProjectId: string | null
  ): Promise<Record<string, unknown> | null> =>
    withTeam(teamId, async (client) => {
      if (kind === "audit") {
        const { rows } = await client.query<{
          ts: string; action: string; object_id: string | null; actor: string | null; project_id: string | null;
        }>(
          `SELECT a.created_at AS ts, a.action, a.object_id, a.project_id, u.display_name AS actor
             FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id
            WHERE a.id = $1 AND a.team_id = $2`,
          [id, teamId]
        );
        const a = rows[0];
        if (!a) return null;
        // 项目过滤：团队级动作（无 project_id）不进入项目过滤视图
        if (filterProjectId && a.project_id !== filterProjectId) return null;
        return {
          key: `audit:${id}`, ts: a.ts, kind: "audit", action: a.action,
          summary: ACTION_LABELS[a.action] ?? a.action, actor: a.actor ?? "系统", objectId: a.object_id,
        };
      }
      const { rows } = await client.query<{
        ts: string; prompt: string; status: string; actor: string | null; project_id: string; project_name: string | null;
      }>(
        `SELECT r.created_at AS ts, r.prompt, r.status, r.project_id, u.display_name AS actor,
                p.name AS project_name
           FROM agent_runs r
           LEFT JOIN users u ON u.id = r.created_by
           LEFT JOIN projects p ON p.team_id = r.team_id AND p.id = r.project_id
          WHERE r.id = $1::uuid AND r.team_id = $2`,
        [id, teamId]
      );
      const r = rows[0];
      if (!r) return null;
      if (filterProjectId && r.project_id !== filterProjectId) return null;
      return {
        key: `agent:${id}`, ts: r.ts, kind: "agent", action: `agent.run.${r.status}`,
        summary: r.prompt.length > 80 ? `${r.prompt.slice(0, 80)}…` : r.prompt,
        actor: r.actor ?? "Agent", objectId: null, project: r.project_name ?? undefined,
      };
    });

  app.get("/activity/stream", async (req, reply) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; projectId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertTeamMember(auth.userId, teamId);
    const filterProjectId = /^[0-9a-f-]{36}$/.test(String(query.projectId ?? "")) ? String(query.projectId) : null;

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(`retry: 2000\n\n`);
    let closed = false;
    const heartbeat = setInterval(() => {
      if (!closed) reply.raw.write(`: ping ${Date.now()}\n\n`);
    }, 25000);
    const unsubscribe = await subscribeActivity(teamId, (n) => {
      if (closed) return;
      void streamItem(teamId, n.kind, n.id, filterProjectId)
        .then((item) => {
          if (!item || closed) return;
          reply.raw.write(`event: activity\ndata: ${JSON.stringify(item)}\n\n`);
        })
        .catch(() => undefined);
    });
    await new Promise<void>((resolve) => {
      req.raw.on("close", () => resolve());
      req.raw.on("error", () => resolve());
    });
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    reply.raw.end();
  });
}
