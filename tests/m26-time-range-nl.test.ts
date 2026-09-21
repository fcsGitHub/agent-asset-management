// M26 时间范围 + NL 动态过滤意图测试 — since/until 闭区间与游标组合（窗口内键集翻页），
// 列表与导出同源、盖章如实记录范围；NL L1 确定性句式与 L2 真实 DeepSeek 白名单
// （activityAction 七选一，越表值视为未通过校验）。全部真实集成，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
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

const PORT = 4133;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M26 时间范围（同源闭区间）+ NL 动态过滤意图", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let projectId = "";
  let adminPool: Pool;
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m26-${runId}@t.dev`, password: "password-123", displayName: "M26队长", teamName: `M26团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M26项目-${runId}`, code: `m26${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "M26 会话", visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");

    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    const { rows: u } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m26-${runId}@t.dev`]);
    const uid = u[0]!.id;
    // 归档 10:00/10:02/10:04 + 运行 10:03（窗口与跨源并列）
    for (const ts of ["2026-09-21 10:00:00+00", "2026-09-21 10:02:00+00", "2026-09-21 10:04:00+00"]) {
      await adminPool.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at)
         VALUES ($1,$2,'asset.archive','audit','{}'::jsonb,$3::timestamptz)`,
        [teamId, uid, ts]
      );
    }
    const { rows: s } = await adminPool.query<{ id: string }>(`SELECT id FROM sessions WHERE team_id = $1 LIMIT 1`, [teamId]);
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by, created_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,'2026-09-21 10:03:00+00')`,
      [teamId, randomUUID(), s[0]!.id, projectId, `M26 运行 ${runId}`, uid]
    );
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("时间范围：闭区间命中跨源集合，与游标组合为窗口内精确翻页，非法参数如实 422", async () => {
    // [10:01, 10:03] → 运行 10:03 + 归档 10:02（DESC：run 先）
    const w = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:01:00Z")}&until=${encodeURIComponent("2026-09-21T10:03:00Z")}`, { session: admin });
    expectOk(w.status === 200, w.json, "窗口查询失败");
    const keys = (w.json.items as Array<{ kind: string; action: string }>).map((i) => `${i.kind}:${i.action}`);
    expect(w.json.items.length === 2, `窗口应 2 条：${JSON.stringify(keys)}`).toBe(true);
    expect(JSON.stringify(keys) === JSON.stringify(["agent:agent.run.completed", "audit:asset.archive"]), `窗口内容应精确：${JSON.stringify(keys)}`).toBe(true);

    // 只给一侧：since=10:03 → [10:04, 10:03]；until=10:02 → [10:02, 10:00]
    const s1 = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:03:00Z")}`, { session: admin });
    expect(s1.json.items.length === 2, `since-only 应 2 条：${s1.json.items.length}`).toBe(true);
    expect((s1.json.items as Array<{ ts: string }>)[0]!.ts.startsWith("2026-09-21T10:04"), `since-only 首条应 10:04：${s1.json.items[0]!.ts}`).toBe(true);
    const u1 = await call("GET", `/activity?teamId=${teamId}&until=${encodeURIComponent("2026-09-21T10:02:00Z")}`, { session: admin });
    expect(u1.json.items.length === 2, `until-only 应 2 条：${u1.json.items.length}`).toBe(true);

    // 窗口 + 键集翻页（limit=1）：next 语义为"页满即可能有更多"，翻到空页确认到底；
    // 各页并集恰为窗口全集，无重复无越界
    const p1 = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:01:00Z")}&until=${encodeURIComponent("2026-09-21T10:03:00Z")}&limit=1`, { session: admin });
    expect(p1.json.items.length === 1 && !!p1.json.next, "第一页应 1 条且有游标").toBe(true);
    const c = p1.json.next;
    const p2 = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:01:00Z")}&until=${encodeURIComponent("2026-09-21T10:03:00Z")}&limit=1&before=${encodeURIComponent(c.before)}&beforeKind=${c.beforeKind}&beforeId=${c.beforeId}`, { session: admin });
    expect(p2.json.items.length === 1, "第二页应 1 条").toBe(true);
    expect(p1.json.items[0]!.key !== p2.json.items[0]!.key, "两页不得重复").toBe(true);
    const c2 = p2.json.next;
    const p3 = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:01:00Z")}&until=${encodeURIComponent("2026-09-21T10:03:00Z")}&limit=1&before=${encodeURIComponent(c2.before)}&beforeKind=${c2.beforeKind}&beforeId=${c2.beforeId}`, { session: admin });
    expect(p3.json.items.length === 0 && !p3.json.next, `第三页应空且到底：${JSON.stringify(p3.json.items)}`).toBe(true);

    const bad = await call("GET", `/activity?teamId=${teamId}&since=昨天`, { session: admin });
    expect(bad.status === 422, `非法 since 应 422：${bad.status}`).toBe(true);
    const inverted = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent("2026-09-21T10:05:00Z")}&until=${encodeURIComponent("2026-09-21T10:01:00Z")}`, { session: admin });
    expect(inverted.status === 422, `until<since 应 422：${inverted.status}`).toBe(true);
  });

  it("导出与列表同源：JSON 元数据回显范围，CSV 行数一致，盖章如实记录 since/until", async () => {
    const since = "2026-09-21T10:01:00Z";
    const until = "2026-09-21T10:03:00Z";
    const lst = await call("GET", `/activity?teamId=${teamId}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`, { session: admin });
    const listKeys = (lst.json.items as Array<{ key: string }>).map((i) => i.key);

    const jres = await fetch(`${BASE}/activity/export?teamId=${teamId}&format=json&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`, { headers: { cookie: admin.cookie } });
    expect(jres.status === 200, "JSON 导出应 200").toBe(true);
    const j = (await jres.json()) as { total: number; since: string | null; until: string | null; truncated: boolean; items: Array<{ entryId: string }> };
    expect(j.total === 2 && j.items.length === 2, `窗口导出应 2 条：${j.total}`).toBe(true);
    expect(j.since === since && j.until === until, `元数据应回显范围：${JSON.stringify({ since: j.since, until: j.until })}`).toBe(true);
    expect(j.truncated === false, "不应截断").toBe(true);
    expect(JSON.stringify((j.items as Array<{ entryId: string }>).map((i) => i.entryId).sort()) === JSON.stringify([...listKeys].sort()),
      `导出与列表应同源：${JSON.stringify({ listKeys, exportIds: j.items.map((i) => i.entryId) })}`).toBe(true);

    const cres = await fetch(`${BASE}/activity/export?teamId=${teamId}&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`, { headers: { cookie: admin.cookie } });
    expect((cres.headers.get("content-type") ?? "").startsWith("text/csv"), "缺省应 text/csv").toBe(true);
    const csvText = (await cres.text()).replace(/^\uFEFF/, "");
    const lines = csvText.trim().split("\r\n");
    expect(lines.length === 3, `CSV 应为表头+2 行：${lines.length}`).toBe(true);

    const { rows: stamps } = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE team_id = $1 AND action = 'audit.export' AND detail ? 'format'
        ORDER BY created_at DESC LIMIT 2`,
      [teamId]
    );
    expect(stamps.length === 2, `应有 2 条导出章：${stamps.length}`).toBe(true);
    expect(stamps[0]!.detail.since === since && stamps[0]!.detail.until === until, `最新章（csv）应记录范围：${JSON.stringify(stamps[0]!.detail)}`).toBe(true);
    expect(stamps[1]!.detail.since === since && stamps[1]!.detail.count === 2, `JSON 章应记录范围与条数：${JSON.stringify(stamps[1]!.detail)}`).toBe(true);
  });

  it("NL 动态过滤意图：L1 确定性句式直中，搜索句式不被劫持；L2 真实 DeepSeek 白名单命中", { timeout: 120000 }, async () => {
    const parse = (text: string) => call("POST", "/nl/parse", { session: admin, body: { teamId, text, page: "dashboard" } });

    const l1cases: Array<[string, string | undefined]> = [
      ["看归档记录", "asset.archive"],
      ["查看导出审计记录", "audit.export"],
      ["Agent 运行记录", "agent"],
      ["回滚历史", "release_rollback"],
      ["恢复动态", "asset.restore"],
    ];
    for (const [text, want] of l1cases) {
      const r = await parse(text);
      expectOk(r.status === 200, r.json, `解析失败：${text}`);
      expect(r.json.intent === "navigate" && r.json.params.page === "activity" && r.json.params.activityAction === want,
        `${text} 应直达 activity+${want}：${JSON.stringify(r.json)}`).toBe(true);
      expect(r.json.parser.kind === "rules", `${text} 应走 L1 规则：${JSON.stringify(r.json.parser)}`).toBe(true);
    }
    // 页面规则不受影响；搜索句式不被劫持
    const plain = await parse("打开动态");
    expect(plain.json.intent === "navigate" && plain.json.params.page === "activity" && plain.json.params.activityAction === undefined,
      `「打开动态」应无 action：${JSON.stringify(plain.json)}`).toBe(true);
    const sr = await parse("搜索归档资产");
    expect(sr.json.intent === "search_assets", `搜索句式不应被过滤规则劫持：${JSON.stringify(sr.json)}`).toBe(true);

    // L2：真实 DeepSeek，提示词白名单内的表述（非 L1 前缀句式）
    const l2 = await parse("帮我看看发布到通道的历史记录都有哪些");
    expectOk(l2.status === 200, l2.json, "L2 解析失败");
    expect(l2.json.parser.kind === "llm", `应走真实 LLM：${JSON.stringify(l2.json.parser)}`).toBe(true);
    expect(l2.json.intent === "navigate" && l2.json.params.page === "activity" && l2.json.params.activityAction === "release_published",
      `L2 应命中白名单 release_published：${JSON.stringify(l2.json)}`).toBe(true);
  });
});
