// M20 测试 — 活动流历史键集分页（同微秒时间戳跨源边界不丢不重）+ 提案批量审核
// （逐条独立判定、逐条如实回执）。SQL 直接造数（多源、精确时间戳含同 instant 跨源
// 并列），避免真实模型时序抖动；全部真实集成，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "@taw/agent-adapter/env";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomBytes(4).toString("hex");
loadEnvFile();
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

interface Session { cookie: string; csrf: string }
function sessionOf(res: Response): Session {
  let cookie = "";
  let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { cookie, csrf };
}

function caller(base: string) {
  return async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      headers["x-csrf-token"] = opts.session.csrf;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

const PORT = 4128;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M20 活动流历史分页 + 提案批量审核", () => {
  let app: FastifyInstance;
  let adminPool: Pool;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let teamId = "";
  let projectId = "";
  let sessionId = "";
  let userId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = async (email: string, name: string, team: string) => {
      const res = await fetch(`${BASE}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
      });
      expect(res.status === 201, `注册失败 ${email}`).toBe(true);
      return { session: sessionOf(res), body: (await res.json()) as { teamId: string; userId: string } };
    };
    const a = await reg(`m20-${runId}@t.dev`, "M20队长", `M20团队-${runId}`);
    admin = a.session; teamId = a.body.teamId; userId = a.body.userId;
    const m = await reg(`m20member-${runId}@t.dev`, "M20审核员", `M20成员团队-${runId}`);
    member = m.session;
    const joinRes = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m20member-${runId}@t.dev`, role: "member" } });
    expectOk(joinRes.status === 201, joinRes.json, "加成员失败");
    const o = await reg(`m20other-${runId}@t.dev`, "M20外团队", `M20外团队-${runId}`);
    outsider = o.session;

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M20项目-${runId}`, code: `m20${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: `M20会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;

    // 多源造数：3 个运行 + 7 条审计；run2 与一条审计**同一时刻**（跨源同 instant 并列）
    const runs: Array<[string, string]> = [
      [randomUUID(), "2026-09-20 10:01:00+00"],
      [randomUUID(), "2026-09-20 10:03:00+00"],
      [randomUUID(), "2026-09-20 10:05:00+00"],
    ];
    for (const [rid, ts] of runs) {
      await adminPool.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by, created_at)
         VALUES ($1,$2,$3,$4,'completed',$5,$6,$7::timestamptz)`,
        [teamId, rid, sessionId, projectId, `M20 分页测试运行 ${rid.slice(0, 6)}`, userId, ts]
      );
    }
    const auditTimes = [
      "2026-09-20 10:00:00+00", "2026-09-20 10:02:00+00",
      "2026-09-20 10:03:00+00", // 与 run2 同一 instant
      "2026-09-20 10:04:00+00", "2026-09-20 10:06:00+00", "2026-09-20 10:07:00+00", "2026-09-20 10:08:00+00",
    ];
    for (const ts of auditTimes) {
      await adminPool.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at)
         VALUES ($1,$2,'asset.archive','asset',jsonb_build_object('note','M20 分页测试'),$3::timestamptz)`,
        [teamId, userId, ts]
      );
    }

    // 3 个待审提案（挂在 run1 下）
    for (let i = 0; i < 3; i++) {
      await adminPool.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'asset_registration',jsonb_build_object('name',$5::text,'typeKey','document'))`,
        [teamId, randomUUID(), runs[0]![0], projectId, `M20 提案 ${i + 1}`]
      );
    }
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("活动流键集分页：逐页翻完恰为 DB 全集，无重复无遗漏，页间单调不越界", async () => {
    // DB 真实全集（含 setup 期间 API 动作产生的审计）
    const dbAudits = await adminPool.query<{ id: string }>(`SELECT id::text AS id FROM audit_events WHERE team_id=$1`, [teamId]);
    const dbRuns = await adminPool.query<{ id: string }>(`SELECT id::text AS id FROM agent_runs WHERE team_id=$1`, [teamId]);
    const expected = new Set<string>([
      ...dbAudits.rows.map((r) => `audit:${r.id}`),
      ...dbRuns.rows.map((r) => `agent:${r.id}`),
    ]);
    expect(expected.size >= 10, `造数应至少 10 条：${expected.size}`).toBe(true);

    const seen = new Map<string, number>();
    let cursor: { before: string; beforeKind: string; beforeId: string } | null = null;
    let pages = 0;
    let lastTsOfPrevPage: string | null = null;
    for (;;) {
      const q = new URLSearchParams({ teamId, limit: "3" });
      if (cursor) {
        q.set("before", cursor.before);
        q.set("beforeKind", cursor.beforeKind);
        q.set("beforeId", cursor.beforeId);
      }
      const r = await call("GET", `/activity?${q}`, { session: admin });
      expectOk(r.status === 200, r.json, `第 ${pages + 1} 页读取失败`);
      const items = r.json.items as Array<{ key: string; ts: string }>;
      if (pages > 0) {
        expect(items.every((x) => x.ts <= lastTsOfPrevPage!), `页间必须单调不越界：${items.map((x) => x.ts)}`).toBe(true);
      }
      for (const item of items) {
        seen.set(item.key, (seen.get(item.key) ?? 0) + 1);
      }
      pages += 1;
      lastTsOfPrevPage = items[items.length - 1]?.ts ?? lastTsOfPrevPage;
      cursor = r.json.next;
      if (!cursor) break;
      expect(pages < 30, `分页未收敛`).toBe(true);
    }

    expect(pages === Math.ceil(expected.size / 3), `页数应为 ceil(n/3)：${pages}`).toBe(true);
    expect(seen.size === expected.size, `应恰好覆盖全集：seen=${seen.size} expected=${expected.size}`).toBe(true);
    for (const key of expected) {
      expect(seen.get(key) === 1, `每个条目应恰好出现一次：${key} 出现 ${seen.get(key)} 次`).toBe(true);
    }
  });

  it("游标校验：格式不合法如实 422，不静默从头重放", async () => {
    const bad1 = await call("GET", `/activity?teamId=${teamId}&limit=3&before=not-a-time&beforeKind=audit&beforeId=123`, { session: admin });
    expect(bad1.status === 422, `坏时间戳应 422，实际 ${bad1.status}`).toBe(true);
    const bad2 = await call("GET", `/activity?teamId=${teamId}&limit=3&before=2026-09-20T10:00:00Z`, { session: admin });
    expect(bad2.status === 422, `缺 beforeKind 应 422，实际 ${bad2.status}`).toBe(true);
    const bad3 = await call("GET", `/activity?teamId=${teamId}&limit=3&before=2026-09-20T10:00:00Z&beforeKind=audit&beforeId=abc`, { session: admin });
    expect(bad3.status === 422, `audit 游标带非数字 id 应 422，实际 ${bad3.status}`).toBe(true);
  });

  it("提案批量审核：逐条回执，重复/不存在条目如实标注且不中断；越权 404；单条路径不回归", async () => {
    const list = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=pending`, { session: admin });
    expectOk(list.status === 200, list.json, "读提案失败");
    const ids = (list.json as Array<{ id: string }>).map((p) => p.id);
    expect(ids.length >= 3, `应至少 3 个待审提案：${ids.length}`).toBe(true);
    const [p1, p2, ghost] = [ids[0]!, ids[1]!, randomUUID()];

    const batch = await call("POST", `/projects/${projectId}/proposals/batch-review`, {
      session: member,
      body: {
        teamId,
        items: [
          { proposalId: p1, decision: "accepted", note: "M20 批量通过" },
          { proposalId: p2, decision: "rejected" },
          { proposalId: ghost, decision: "accepted" },
          { proposalId: p1, decision: "rejected" }, // 同一批内重复：先成功后冲突
        ],
      },
    });
    expectOk(batch.status === 200, batch.json, "批量审核应 200（逐条回执不整单报错）");
    expect(batch.json.reviewed === 2, `应成功 2 条：${batch.json.reviewed}`).toBe(true);
    const results = batch.json.results as Array<{ proposalId: string; ok: boolean; code?: string; status?: string }>;
    expect(results[0]!.ok && results[0]!.status === "accepted", "p1 应接受成功").toBe(true);
    expect(results[1]!.ok && results[1]!.status === "rejected", "p2 应拒绝成功").toBe(true);
    expect(results[2]!.ok === false && results[2]!.code === "NOT_FOUND", `幽灵 id 应如实回执：${JSON.stringify(results[2])}`).toBe(true);
    expect(results[3]!.ok === false && results[3]!.code === "PROPOSAL_NOT_PENDING",
      `同批重复审核应如实回执冲突：${JSON.stringify(results[3])}`).toBe(true);

    // 状态落地与审核留痕
    const accepted = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=accepted`, { session: admin });
    const accRows = accepted.json as Array<{ id: string; reviewed_by_name: string | null; payload: { review?: { note?: string } } }>;
    const p1row = accRows.find((x) => x.id === p1);
    expect(!!p1row && p1row.reviewed_by_name === "M20审核员", `审核人应如实留痕：${JSON.stringify(p1row?.reviewed_by_name)}`).toBe(true);
    expect(p1row?.payload.review?.note === "M20 批量通过", "批量审核备注应合并进 payload.review").toBe(true);
    const rejected = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=rejected`, { session: admin });
    expect((rejected.json as Array<{ id: string }>).some((x) => x.id === p2), "p2 应在已忽略列表").toBe(true);

    // 越权：非成员批量审核 404，数据未被改动
    const o = await call("POST", `/projects/${projectId}/proposals/batch-review`, {
      session: outsider, body: { teamId, items: [{ proposalId: ids[2]!, decision: "accepted" }] },
    });
    expect(o.status === 404, `非成员应 404，实际 ${o.status}`).toBe(true);
    const still = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=pending`, { session: admin });
    expect((still.json as Array<{ id: string }>).some((x) => x.id === ids[2]), "越权尝试后该提案仍应待审").toBe(true);

    // 超限 422
    const many = Array.from({ length: 51 }, () => ({ proposalId: randomUUID(), decision: "accepted" }));
    const over = await call("POST", `/projects/${projectId}/proposals/batch-review`, { session: admin, body: { teamId, items: many } });
    expect(over.status === 422, `超限应 422，实际 ${over.status}`).toBe(true);

    // 单条路径不回归：note 合并 + 409 状态机
    const p4 = ids[2]!;
    const single = await call("POST", `/proposals/${p4}/review`, { session: admin, body: { teamId, decision: "accepted", note: "单条审核" } });
    expectOk(single.status === 200, single.json, "单条审核应成功");
    const again = await call("POST", `/proposals/${p4}/review`, { session: admin, body: { teamId, decision: "rejected" } });
    expect(again.status === 409, `重复单条审核应 409，实际 ${again.status}`).toBe(true);
  });
});
