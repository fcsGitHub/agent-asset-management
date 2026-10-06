// /api/v1/projects + sessions — 项目与项目会话（设计 4/16 章）。
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
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

  // 添加项目成员（实测走查 M32 发现的产品缺口：团队邀请之外，普通成员此前没有任何
  // UI/API 途径进入项目——project_members 唯一写入点是创建者 lead，各轮实测都以 DB
  // 播种绕过）。口径：团队管理员或项目 lead 可添加；目标必须是本团队成员；重复添加
  // 409；添加是治理动作，如实盖章审计。
  app.post("/projects/:projectId/members", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    if (!/^[0-9a-f-]{36}$/.test(projectId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        email: z.string().email(),
        role: z.enum(["lead", "member"]).default("member"),
      }),
      req.body
    );
    const actorTeamRole = await assertTeamMember(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const { rows: pm } = await client.query<{ role: string }>(
        `SELECT role FROM project_members WHERE team_id = $1 AND project_id = $2 AND user_id = $3`,
        [body.teamId, projectId, auth.userId]
      );
      if (actorTeamRole !== "admin" && pm[0]?.role !== "lead") throw ERR.FORBIDDEN();
      const { rows: target } = await client.query<{ id: string; display_name: string }>(
        `SELECT u.id, u.display_name FROM users u
           JOIN team_members tm ON tm.team_id = $1 AND tm.user_id = u.id
          WHERE u.email = $2`,
        [body.teamId, body.email]
      );
      if (!target[0]) throw ERR.INVALID("目标用户不存在或尚未加入本团队，请先邀请其加入团队");
      const { rows: dupe } = await client.query(
        `SELECT 1 FROM project_members WHERE team_id = $1 AND project_id = $2 AND user_id = $3`,
        [body.teamId, projectId, target[0].id]
      );
      if (dupe[0]) throw ERR.CONFLICT("ALREADY_MEMBER", "该用户已是项目成员");
      await client.query(
        `INSERT INTO project_members (team_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)`,
        [body.teamId, projectId, target[0].id, body.role]
      );
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, detail)
         VALUES ($1, $2, 'project.member.add', 'project', $3, $4)`,
        [body.teamId, auth.userId, projectId,
         JSON.stringify({ email: body.email, member: target[0].display_name, memberRole: body.role })]
      );
      return { userId: target[0].id };
    }).then((added) => {
      reply.code(201).send({ teamId: body.teamId, projectId, userId: added.userId, role: body.role });
    });
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

  // 会话维护：改名 / 归档（创建者或团队管理员；归档不删除数据，仅移出默认列表）
  app.patch("/sessions/:sessionId", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        archived: z.boolean().optional(),
      }).refine((b) => b.title !== undefined || b.archived !== undefined, { message: "至少提供 title 或 archived" }),
      req.body
    );
    const role = await assertTeamMember(auth.userId, body.teamId);
    return withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ title: string; archived: boolean; created_by: string }>(
        `SELECT title, archived, created_by FROM sessions WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, sessionId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      if (rows[0].created_by !== auth.userId && role !== "admin") {
        throw ERR.FORBIDDEN("只有会话创建者或团队管理员可以修改会话");
      }
      const sets: string[] = [];
      const vals: unknown[] = [body.teamId, sessionId];
      if (body.title !== undefined) { sets.push(`title = $${vals.length + 1}`); vals.push(body.title); }
      if (body.archived !== undefined) { sets.push(`archived = $${vals.length + 1}`); vals.push(body.archived); }
      await client.query(`UPDATE sessions SET ${sets.join(", ")} WHERE team_id = $1 AND id = $2`, vals);
      return {
        teamId: body.teamId,
        sessionId,
        title: body.title ?? rows[0].title,
        archived: body.archived ?? rows[0].archived,
      };
    });
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
    "asset.deprecate": "弃用资产",
    "asset.undeprecate": "取消弃用",
    "asset.lineage_materialize": "物化血缘关联",
    "asset.labels_propagate": "沿血缘传播标签",
    "asset.sbom": "导出 SBOM",
    "collection.snapshot_create": "创建分享快照",
    "collection.snapshot_revoke": "吊销分享快照",
    "review_prepared": "准备审核快照",
    "release_published": "发布到通道",
    "release_rollback": "通道回滚",
    "audit.export": "导出审计",
    "asset.export": "导出资产清单",
    "semantic.queue.export": "导出语义队列",
    "relation.withdraw": "撤回关系断言",
    "project.member.add": "添加项目成员",
  };
  // 动态页 action 过滤选项（M24）：Agent 运行是一组（不分状态），其余按审计动作精确匹配。
  // 随 /activity 响应下发，前端下拉与服务端标签同源，不硬编码副本。
  const ACTIVITY_FILTERS = [
    { value: "agent", label: "Agent 运行" },
    ...Object.entries(ACTION_LABELS).map(([value, label]) => ({ value, label })),
  ];

  // action 过滤解析（列表与导出共用）："agent" 仅 Agent 运行；其余按审计动作精确匹配；空/缺省不过滤
  const parseActionFilter = (raw: unknown): string | null => {
    const v = String(raw ?? "").trim();
    if (!v) return null;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(v)) throw ERR.INVALID("action 过滤参数不合法");
    return v;
  };

  // 时间范围解析（M26，列表与导出共用）：since/until 为完整时间戳（与游标同格式正则），
  // 边界闭区间 [since, until]；只给一侧则只约束该侧；until < since 如实 422
  const parseRange = (sinceRaw: unknown, untilRaw: unknown): { since: string | null; until: string | null } => {
    const tsRe = /^\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]{8,40}$/;
    const since = String(sinceRaw ?? "").trim();
    const until = String(untilRaw ?? "").trim();
    if (since && !tsRe.test(since)) throw ERR.INVALID("since 时间戳格式不合法");
    if (until && !tsRe.test(until)) throw ERR.INVALID("until 时间戳格式不合法");
    if (since && until && since > until) throw ERR.INVALID("until 不得早于 since");
    return { since: since || null, until: until || null };
  };

  // 操作者过滤解析（M30）：团队成员 user uuid 精确匹配（审计 actor_id / 运行 created_by）；
  // 空/缺省不过滤；非 uuid 如实 422
  const parseActorFilter = (raw: unknown): string | null => {
    const v = String(raw ?? "").trim();
    if (!v) return null;
    if (!/^[0-9a-f-]{36}$/.test(v)) throw ERR.INVALID("actorId 过滤参数不合法");
    return v;
  };

  // 活动条目（含导出用的精确时间戳文本；列表响应原样携带，额外字段对客户端无害）
  interface ExportActivityItem {
    key: string;
    ts: string;
    tsExact: string;
    kind: "audit" | "agent";
    action: string;
    summary: string;
    actor: string;
    objectId: string | null;
    project?: string;
  }

  // 活动流分页查询核心（列表 /activity 与导出 /activity/export 共用，保证同源）：
  // 合并全序 (ts DESC, kind [audit 先于 agent], id DESC)，游标语义见 /activity 注释。
  // actionFilter（M24）：null 不过滤；"agent" 仅 Agent 运行；其余按审计动作精确匹配
  // （此时不含任何 Agent 运行）。range（M26）：闭区间 [since, until] 静态边界，
  // 与游标组合 = 窗口内键集翻页。过滤先于游标生效，翻页边界语义不变。
  const queryActivityPage = async (
    client: PoolClient,
    teamId: string,
    filterProjectId: string | null,
    limit: number,
    cursor: { ts: string | null; auditId: number | null; runId: string | null },
    actionFilter: string | null,
    range: { since: string | null; until: string | null } = { since: null, until: null },
    actorId: string | null = null
  ): Promise<{ items: ExportActivityItem[]; next: { before: string; beforeKind: string; beforeId: string } | null }> => {
    const { rows: audits } = await client.query<{
      id: string;
      ts: string;
      ts_exact: string;
      action: string;
      object_kind: string;
      object_id: string | null;
      actor: string | null;
      project_name: string | null;
      detail: Record<string, unknown>;
    }>(
      `SELECT a.id::text AS id, a.created_at AS ts, to_jsonb(a.created_at)#>>'{}' AS ts_exact,
              a.action, a.object_kind, a.object_id, u.display_name AS actor,
              p.name AS project_name, a.detail
         FROM audit_events a
         LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN projects p ON p.team_id = a.team_id AND p.id = a.project_id
        WHERE a.team_id = $1 AND ($3::uuid IS NULL OR a.project_id = $3::uuid)
          AND ($6::text IS NULL OR ($6::text <> 'agent' AND a.action = $6::text))
          AND ($7::timestamptz IS NULL OR a.created_at >= $7::timestamptz)
          AND ($8::timestamptz IS NULL OR a.created_at <= $8::timestamptz)
          AND ($9::uuid IS NULL OR a.actor_id = $9::uuid)
          AND (
            $4::timestamptz IS NULL
            OR a.created_at < $4::timestamptz
            OR ($5::bigint IS NOT NULL AND a.created_at = $4::timestamptz AND a.id < $5::bigint)
          )
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $2`,
      [teamId, limit + 1, filterProjectId, cursor.ts, cursor.auditId, actionFilter, range.since, range.until, actorId]
    );
    const { rows: agentRuns } = await client.query<{
      id: string;
      ts: string;
      ts_exact: string;
      prompt: string;
      status: string;
      actor: string | null;
      project_name: string | null;
      session_title: string | null;
    }>(
      `SELECT r.id::text AS id, r.created_at AS ts, to_jsonb(r.created_at)#>>'{}' AS ts_exact,
              r.prompt, r.status, u.display_name AS actor,
              p.name AS project_name, s.title AS session_title
         FROM agent_runs r
         LEFT JOIN users u ON u.id = r.created_by
         LEFT JOIN projects p ON p.team_id = r.team_id AND p.id = r.project_id
         LEFT JOIN sessions s ON s.team_id = r.team_id AND s.id = r.session_id
        WHERE r.team_id = $1 AND ($3::uuid IS NULL OR r.project_id = $3::uuid)
          AND ($7::text IS NULL OR $7::text = 'agent')
          AND ($8::timestamptz IS NULL OR r.created_at >= $8::timestamptz)
          AND ($9::timestamptz IS NULL OR r.created_at <= $9::timestamptz)
          AND ($10::uuid IS NULL OR r.created_by = $10::uuid)
          AND (
            $4::timestamptz IS NULL
            OR r.created_at < $4::timestamptz
            OR ($5::bigint IS NOT NULL AND r.created_at = $4::timestamptz)
            OR ($6::uuid IS NOT NULL AND r.created_at = $4::timestamptz AND r.id < $6::uuid)
          )
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $2`,
      [teamId, limit + 1, filterProjectId, cursor.ts, cursor.auditId, cursor.runId, actionFilter, range.since, range.until, actorId]
    );
    const items: ExportActivityItem[] = [
      ...audits.map((a): ExportActivityItem => ({
        key: `audit:${a.id}`,
        ts: a.ts,
        tsExact: a.ts_exact,
        kind: "audit",
        action: a.action,
        summary: ACTION_LABELS[a.action] ?? a.action,
        actor: a.actor ?? "系统",
        objectId: a.object_id,
        project: a.project_name ?? undefined,
      })),
      ...agentRuns.map((r): ExportActivityItem => ({
        key: `agent:${r.id}`,
        ts: r.ts,
        tsExact: r.ts_exact,
        kind: "agent",
        action: `agent.run.${r.status}`,
        summary: r.prompt.length > 80 ? `${r.prompt.slice(0, 80)}…` : r.prompt,
        actor: r.actor ?? "Agent",
        objectId: null,
        project: r.project_name ?? undefined,
      })),
    ]
      // 全序：ts DESC，同 ts 时 audit 先于 agent（数组构造序 + 稳定排序必须以 0 表相等，
      // 否则不一致比较器会同 ts 跨源乱序，破坏键集分页的边界语义）
      .sort((x, y) => (x.ts < y.ts ? 1 : x.ts > y.ts ? -1 : 0))
      .slice(0, limit);
    const boundary = items[items.length - 1];
    const next =
      items.length === limit && boundary
        ? {
            before: boundary.tsExact,
            beforeKind: boundary.kind,
            beforeId: boundary.key.split(":")[1] ?? "",
          }
        : null;
    return { items, next };
  };
  // 活动流历史分页（键集分页）：游标 = 页尾条目的（精确时间戳, kind, id）。
  // 合并序为 (ts DESC, kind [audit 先于 agent], id DESC)；同 ts 跨源的边界语义：
  //   边界是 audit → 同 ts 的 agent 全部落入下一页；边界是 agent → 同 ts 的 audit 已全部加载。
  // ts 用 Postgres 原生文本往返（to_jsonb），避免 JS Date 毫秒截断丢失微秒导致漏项。
  app.get("/activity", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as {
      teamId?: string; limit?: string; projectId?: string; action?: string;
      since?: string; until?: string; actorId?: string;
      before?: string; beforeKind?: string; beforeId?: string;
    };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertTeamMember(auth.userId, teamId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    // 项目过滤语义：项目级动作（审核准备/发布/回滚、Agent 运行）带 project_id；
    // 团队级动作（资产归档/恢复等）为 NULL——按项目过滤时仅显示该项目内的动作。
    const filterProjectId = /^[0-9a-f-]{36}$/.test(String(query.projectId ?? "")) ? String(query.projectId) : null;
    const actionFilter = parseActionFilter(query.action);
    const range = parseRange(query.since, query.until);
    const actorId = parseActorFilter(query.actorId);

    // 游标解析：字段齐全才生效；字段不合法如实 422（不静默从头重放）
    const rawBefore = String(query.before ?? "");
    const beforeKind = query.beforeKind === "audit" || query.beforeKind === "agent" ? query.beforeKind : null;
    const rawBeforeId = String(query.beforeId ?? "");
    let cursorTs: string | null = null;
    let cursorAuditId: number | null = null;
    let cursorRunId: string | null = null;
    if (rawBefore || beforeKind || rawBeforeId) {
      if (!/^\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]{8,40}$/.test(rawBefore)) throw ERR.INVALID("before 游标格式不合法");
      if (!beforeKind) throw ERR.INVALID("beforeKind 游标缺失");
      if (beforeKind === "audit" && !/^\d{1,20}$/.test(rawBeforeId)) throw ERR.INVALID("beforeId 游标不合法");
      if (beforeKind === "agent" && !/^[0-9a-f-]{36}$/.test(rawBeforeId)) throw ERR.INVALID("beforeId 游标不合法");
      cursorTs = rawBefore;
      if (beforeKind === "audit") cursorAuditId = Number(rawBeforeId);
      else cursorRunId = rawBeforeId;
    }

    const { items, next } = await withTeam(teamId, async (client) =>
      queryActivityPage(client, teamId, filterProjectId, limit, {
        ts: cursorTs,
        auditId: cursorAuditId,
        runId: cursorRunId,
      }, actionFilter, range, actorId)
    );
    // 本团队出现过操作者的名单（M30）：供前端按人过滤下拉与服务端标签同源
    const actors = await withTeam(teamId, async (client) => {
      const { rows } = await client.query<{ id: string; label: string }>(
        `SELECT DISTINCT u.id, u.display_name AS label
           FROM audit_events a JOIN users u ON u.id = a.actor_id
          WHERE a.team_id = $1 AND u.id IS NOT NULL
          UNION
         SELECT DISTINCT u.id, u.display_name AS label
           FROM agent_runs r JOIN users u ON u.id = r.created_by
          WHERE r.team_id = $1
          ORDER BY label`,
        [teamId]
      );
      return rows;
    });
    // actions/actors：可用的过滤选项，与服务端标签同源下发
    return { items, next, actions: ACTIVITY_FILTERS, actors };
  });

  // 审计条目详情（M27）：列表只带摘要，治理回执原文（detail jsonb）按需拉取。
  // 团队 scoped（assertTeamMember + withTeam RLS）；运行类条目走既有 GET /runs/:id。
  app.get("/activity/audit/:auditId", async (req) => {
    const auth = requireAuth(req);
    const { auditId } = req.params as { auditId: string };
    const query = (req.query ?? {}) as { teamId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    if (!/^\d{1,20}$/.test(auditId)) throw ERR.INVALID("auditId 不合法");
    await assertTeamMember(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id::text AS id, a.action, a.object_kind, a.object_id, a.detail,
                a.project_id, p.name AS project_name, a.created_at,
                u.display_name AS actor
           FROM audit_events a
           LEFT JOIN users u ON u.id = a.actor_id
           LEFT JOIN projects p ON p.team_id = a.team_id AND p.id = a.project_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, auditId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      return rows[0];
    });
  });

  // 审计导出：复用与列表完全相同的分页查询（同源，含 action 过滤），DESC 遍历后按
  // 时间正序写出。格式 csv（默认，RFC 4180 + BOM）或 json（结构化条目 + 截断标志）。
  // 上限 20000 条：达到上限如实标注截断（CSV 尾行说明 / JSON truncated 字段），不静默截断。
  // 导出本身是敏感可见动作：盖章 audit.export 审计事件（团队级，project_id 为 NULL，
  // 过滤范围与格式记录在 detail 中）；盖章不进入本次导出内容（先取数后盖章）。
  app.get("/activity/export", async (req, reply) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; projectId?: string; action?: string; since?: string; until?: string; actorId?: string; format?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertTeamMember(auth.userId, teamId);
    const filterProjectId = /^[0-9a-f-]{36}$/.test(String(query.projectId ?? "")) ? String(query.projectId) : null;
    const actionFilter = parseActionFilter(query.action);
    const range = parseRange(query.since, query.until);
    const actorId = parseActorFilter(query.actorId);
    const rawFormat = String(query.format ?? "").trim().toLowerCase();
    if (rawFormat && rawFormat !== "csv" && rawFormat !== "json") throw ERR.INVALID("format 仅支持 csv 或 json");
    const format = rawFormat === "json" ? "json" : "csv";

    const EXPORT_BATCH = 500;
    const EXPORT_CAP = 20000;
    const rows: ExportActivityItem[] = [];
    let cursor: { ts: string | null; auditId: number | null; runId: string | null } = { ts: null, auditId: null, runId: null };
    let truncated = false;
    for (;;) {
      const page = await withTeam(teamId, (client) =>
        queryActivityPage(client, teamId, filterProjectId, EXPORT_BATCH, cursor, actionFilter, range, actorId)
      );
      rows.push(...page.items);
      if (!page.next) break;
      cursor = {
        ts: page.next.before,
        auditId: page.next.beforeKind === "audit" ? Number(page.next.beforeId) : null,
        runId: page.next.beforeKind === "agent" ? page.next.beforeId : null,
      };
      if (rows.length >= EXPORT_CAP) {
        truncated = true;
        break;
      }
    }

    await withTeam(teamId, async (client) => {
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, project_id)
         VALUES ($1,$2,'audit.export','audit',$3,NULL)`,
        [teamId, auth.userId,
         JSON.stringify({ format, count: rows.length, truncated, projectId: filterProjectId, action: actionFilter, since: range.since, until: range.until, actorId })]
    );
    });

    const stamp = `taw-audit-${teamId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}`;
    if (format === "json") {
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${stamp}.json"`);
      // 时间正序（遍历为 DESC）；截断以 truncated+total 如实标注，不伪造完整性
      return JSON.stringify({
        teamId,
        projectId: filterProjectId,
        action: actionFilter,
        since: range.since,
        until: range.until,
        actorId,
        format,
        exportedAt: new Date().toISOString(),
        truncated,
        total: rows.length,
        items: [...rows].reverse().map((it) => ({
          entryId: it.key,
          ts: it.tsExact,
          kind: it.kind,
          action: it.action,
          summary: it.summary,
          actor: it.actor,
          project: it.project ?? null,
          objectId: it.objectId,
        })),
      }, null, 2);
    }

    const csvEscape = (v: string): string => `"${v.replace(/"/g, '""')}"`;
    const lines: string[] = ["ts,kind,entry_id,action,summary,actor,project,object_id"];
    for (const it of [...rows].reverse()) {
      lines.push([
        csvEscape(it.tsExact),
        csvEscape(it.kind),
        csvEscape(it.key),
        csvEscape(it.action),
        csvEscape(it.summary),
        csvEscape(it.actor),
        csvEscape(it.project ?? ""),
        csvEscape(it.objectId ?? ""),
      ].join(","));
    }
    if (truncated) lines.push(`# 已达导出上限 ${EXPORT_CAP} 条，更早的记录未包含`);

    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${stamp}.csv"`);
    return "\uFEFF" + lines.join("\r\n");
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
      // resync（M19 自愈）：LISTEN 断链重连后通知有缺口，转发信号让客户端重取历史对齐；
      // 正文无法按 id 补（NOTIFY 只带定位信息，断窗内的通知已丢失），重取是与列表同源的诚实对齐
      if ("resync" in n) {
        reply.raw.write(`event: resync\ndata: {}\n\n`);
        return;
      }
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

  // ---------- Agent 提案审核（proposal.create 落库内容首次开放给人类） ----------
  // issue_triage 是 external.notify 的回执而非提案，列表一律排除。
  app.get("/projects/:projectId/proposals", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const query = (req.query ?? {}) as { teamId?: string; status?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await assertProjectAccess(auth.userId, teamId, projectId);
    const statusFilter = ["pending", "accepted", "rejected"].includes(String(query.status ?? ""))
      ? String(query.status)
      : null;
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT p.id, p.kind, p.payload, p.status, p.created_at,
                r.prompt AS run_prompt, u.display_name AS initiated_by_name,
                ru.display_name AS reviewed_by_name
           FROM agent_proposals p
           JOIN agent_runs r ON r.team_id = p.team_id AND r.id = p.run_id
           LEFT JOIN users u ON u.id = r.created_by
           LEFT JOIN users ru ON ru.id = p.reviewed_by
          WHERE p.team_id = $1 AND p.project_id = $2
            AND p.kind <> 'issue_triage'
            AND ($3::text IS NULL OR p.status = $3)
          ORDER BY p.created_at DESC LIMIT 100`,
        [teamId, projectId, statusFilter]
      );
      return rows;
    });
  });

  app.post("/proposals/:proposalId/review", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { proposalId } = req.params as { proposalId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        decision: z.enum(["accepted", "rejected"]),
        note: z.string().max(2000).optional(),
      }),
      req.body
    );
    await assertTeamMember(auth.userId, body.teamId);
    const result = await withTeam(body.teamId, async (client) => {
      // 项目归属对齐批量端点（M72 审计修复）：assertTeamMember 只证团队成员——
      // 提案必须属于调用者为成员的项目（project_members 受 RLS，须在租户上下文内查）
      const { rows: proj } = await client.query<{ project_id: string }>(
        `SELECT project_id FROM agent_proposals WHERE team_id = $1 AND id = $2`,
        [body.teamId, proposalId]
      );
      if (!proj[0]) throw ERR.NOT_FOUND();
      const { rows: pm } = await client.query(
        `SELECT 1 FROM project_members WHERE team_id = $1 AND project_id = $2 AND user_id = $3`,
        [body.teamId, proj[0].project_id, auth.userId]
      );
      if (!pm[0]) throw ERR.FORBIDDEN();
      return reviewProposal(client, body.teamId, auth.userId, proposalId, body.decision, body.note ?? null);
    });
    return result;
  });

  // 提案批量审核：逐条独立判定，逐条如实回执（已处理条目标 PROPOSAL_NOT_PENDING，不中断其余）
  app.post("/projects/:projectId/proposals/batch-review", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        items: z.array(z.object({
          proposalId: z.string().uuid(),
          decision: z.enum(["accepted", "rejected"]),
          note: z.string().max(2000).optional(),
        })).min(1).max(50),
      }),
      req.body
    );
    await assertProjectAccess(auth.userId, body.teamId, projectId);
    const results = await withTeam(body.teamId, async (client) => {
      const out: Array<{ proposalId: string; ok: boolean; status?: string; code?: string; message?: string }> = [];
      for (const item of body.items) {
        try {
          const r = await reviewProposal(client, body.teamId, auth.userId, item.proposalId, item.decision, item.note ?? null);
          out.push({ proposalId: item.proposalId, ok: true, status: r.status });
        } catch (err) {
          const e = err as { code?: string; message?: string };
          out.push({ proposalId: item.proposalId, ok: false, code: e.code ?? "INTERNAL", message: e.message });
        }
      }
      return out;
    });
    return reply.code(200).send({
      teamId: body.teamId,
      projectId,
      reviewed: results.filter((r) => r.ok).length,
      results,
    });
  });
}

/** 共享审核核心：提案锁 + pending 状态机 + jsonb 合并审核回执（单条与批量同一路径）。 */
async function reviewProposal(
  client: PoolClient,
  teamId: string,
  userId: string,
  proposalId: string,
  decision: "accepted" | "rejected",
  note: string | null
): Promise<{ teamId: string; proposalId: string; status: string }> {
  const { rows } = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM agent_proposals WHERE team_id = $1 AND id = $2 FOR UPDATE`,
    [teamId, proposalId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  if (rows[0].status !== "pending") {
    throw ERR.CONFLICT("PROPOSAL_NOT_PENDING", `提案已处于 ${rows[0].status} 状态`);
  }
  await client.query(
    `UPDATE agent_proposals SET status = $3, reviewed_by = $4,
       payload = payload || jsonb_build_object('review', jsonb_build_object(
         'note', CASE WHEN $5::text IS NULL OR $5::text = '' THEN NULL ELSE $5::text END,
         'reviewed_at', to_jsonb(now()::text)))
     WHERE team_id = $1 AND id = $2`,
    [teamId, proposalId, decision, userId, note]
  );
  return { teamId, proposalId, status: decision };
}
