// M24 动态 action 过滤 + 审计导出 JSON 测试 — 列表/翻页/导出共用 queryActivityPage
// 同源过滤（"agent" 仅运行、其余精确匹配审计动作、过滤先于游标）；JSON 导出与 CSV
// 同源同遍历（时间正序、entry_id 唯一、truncated 如实标注、盖章 detail 带格式与过滤范围）。
// 全部真实集成，无 mock。
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

/** GET 原始 Response（导出用：需要头与原始字节，不走 JSON 解析） */
function rawGet(base: string, path: string, session: Session): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { cookie: session.cookie } });
}

const PORT = 4132;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M24 动态 action 过滤（同源）+ 审计导出 JSON", () => {
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
      body: JSON.stringify({ email: `m24-${runId}@t.dev`, password: "password-123", displayName: "M24队长", teamName: `M24团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M24项目-${runId}`, code: `m24${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "M24 会话", visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");

    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    const { rows: u } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m24-${runId}@t.dev`]);
    const uid = u[0]!.id;
    // 审计：归档×3 + 导出×1 + 发布（项目级）×1；运行：完成/失败 各 1（时间交错覆盖合并序）
    const audits: Array<[string, string, string | null]> = [
      ["2026-09-21 10:00:00+00", "asset.archive", null],
      ["2026-09-21 10:02:00+00", "asset.archive", null],
      ["2026-09-21 10:04:00+00", "asset.archive", null],
      ["2026-09-21 10:06:00+00", "audit.export", null],
      ["2026-09-21 10:08:00+00", "release_published", projectId],
    ];
    for (const [ts, action, pid] of audits) {
      await adminPool.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, project_id, created_at)
         VALUES ($1,$2,$3,'audit',jsonb_build_object('note','M24 种子'),$4::uuid,$5::timestamptz)`,
        [teamId, uid, action, pid, ts]
      );
    }
    const runs: Array<[string, string]> = [
      ["2026-09-21 10:01:00+00", "completed"],
      ["2026-09-21 10:03:00+00", "failed"],
    ];
    const { rows: s } = await adminPool.query<{ id: string }>(`SELECT id FROM sessions WHERE team_id = $1 LIMIT 1`, [teamId]);
    for (const [ts, status] of runs) {
      await adminPool.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz)`,
        [teamId, randomUUID(), s[0]!.id, projectId, status, `M24 运行 ${status} ${runId}`, uid, ts]
      );
    }
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("action 过滤：列表/跨页翻页恰为过滤全集，agent 组与精确动作互斥，actions 选项同源下发", async () => {
    // 精确动作 + 翻页：3 条归档 limit=2 → 2+1，无重复无遗漏
    const p1 = await call("GET", `/activity?teamId=${teamId}&action=asset.archive&limit=2`, { session: admin });
    expectOk(p1.status === 200, p1.json, "过滤列表失败");
    expect(p1.json.items.length === 2, `第一页应 2 条：${p1.json.items.length}`).toBe(true);
    expect(p1.json.items.every((i: { kind: string; action: string }) => i.kind === "audit" && i.action === "asset.archive"),
      "第一页应全为 asset.archive 审计").toBe(true);
    expect(!!p1.json.next, "应有下一页游标").toBe(true);
    const c = p1.json.next;
    const p2 = await call("GET", `/activity?teamId=${teamId}&action=asset.archive&limit=2&before=${encodeURIComponent(c.before)}&beforeKind=${c.beforeKind}&beforeId=${c.beforeId}`, { session: admin });
    expectOk(p2.status === 200, p2.json, "第二页失败");
    expect(p2.json.items.length === 1 && !p2.json.next, `第二页应恰 1 条且到底：${JSON.stringify(p2.json)}`).toBe(true);
    const keys = [...p1.json.items, ...p2.json.items].map((i: { key: string }) => i.key);
    expect(new Set(keys).size === 3, `翻页并集应恰 3 条无重复：${JSON.stringify(keys)}`).toBe(true);

    // agent 组：仅运行（含不同状态），无审计条目
    const ag = await call("GET", `/activity?teamId=${teamId}&action=agent&limit=50`, { session: admin });
    expectOk(ag.status === 200, ag.json, "agent 过滤失败");
    expect(ag.json.items.length === 2, `应 2 条运行：${ag.json.items.length}`).toBe(true);
    expect(ag.json.items.every((i: { kind: string }) => i.kind === "agent"), "agent 过滤应只含运行").toBe(true);
    const acts = ag.json.items.map((i: { action: string }) => i.action).sort();
    expect(JSON.stringify(acts) === JSON.stringify(["agent.run.completed", "agent.run.failed"]), `应含两种状态：${JSON.stringify(acts)}`).toBe(true);

    // 不过滤：7 条（5 审计 + 2 运行）；actions 选项与服务端标签同源下发
    const all = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expectOk(all.status === 200, all.json, "全量列表失败");
    expect(all.json.items.length === 7, `应 7 条：${all.json.items.length}`).toBe(true);
    const opts = (all.json.actions ?? []) as Array<{ value: string; label: string }>;
    expect(opts.some((o) => o.value === "agent" && o.label === "Agent 运行"), `应含 agent 选项：${JSON.stringify(opts)}`).toBe(true);
    expect(opts.some((o) => o.value === "asset.archive" && o.label === "归档资产"), `应含归档选项：${JSON.stringify(opts)}`).toBe(true);

    // 与项目过滤叠加：项目级发布命中；团队级归档在项目视图为空（M16 语义）
    const rel = await call("GET", `/activity?teamId=${teamId}&action=release_published&projectId=${projectId}`, { session: admin });
    expect(rel.json.items.length === 1 && rel.json.items[0]!.action === "release_published", `项目+动作应命中发布：${JSON.stringify(rel.json.items)}`).toBe(true);
    const arcInProj = await call("GET", `/activity?teamId=${teamId}&action=asset.archive&projectId=${projectId}`, { session: admin });
    expect(arcInProj.json.items.length === 0, "团队级归档在项目视图应为空").toBe(true);
  });

  it("JSON 导出与列表同源：正序/唯一/全集，盖章 detail 带格式与过滤范围，CSV 默认不变", async () => {
    const count = async (table: string): Promise<number> => {
      const { rows } = await adminPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE team_id = $1`, [teamId]);
      return Number(rows[0]!.n);
    };
    const expected = (await count("audit_events")) + (await count("agent_runs"));

    const r1 = await rawGet(BASE, `/activity/export?teamId=${teamId}&format=json`, admin);
    expect(r1.status === 200, `JSON 导出应 200：${r1.status}`).toBe(true);
    expect((r1.headers.get("content-type") ?? "").startsWith("application/json"), `content-type 应 json：${r1.headers.get("content-type")}`).toBe(true);
    expect((r1.headers.get("content-disposition") ?? "").includes(".json"), `应为 json 附件：${r1.headers.get("content-disposition")}`).toBe(true);
    const j1 = (await r1.json()) as { total: number; truncated: boolean; action: null; items: Array<{ entryId: string; ts: string; kind: string; action: string }> };
    expect(j1.total === expected && j1.items.length === expected, `应恰为全集 ${expected}：${j1.total}`).toBe(true);
    expect(j1.truncated === false && j1.action === null, "不应截断且无动作过滤").toBe(true);
    const ids = j1.items.map((i) => i.entryId);
    expect(new Set(ids).size === ids.length, "entry_id 应唯一").toBe(true);
    for (let i = 1; i < j1.items.length; i++) {
      expect(j1.items[i]!.ts >= j1.items[i - 1]!.ts, `时间应正序：${j1.items[i]!.ts} < ${j1.items[i - 1]!.ts}`).toBe(true);
    }

    // 带动作过滤的 JSON 导出：恰为过滤全集
    const r2 = await rawGet(BASE, `/activity/export?teamId=${teamId}&format=json&action=asset.archive`, admin);
    expect(r2.status === 200, `过滤导出应 200：${r2.status}`).toBe(true);
    const j2 = (await r2.json()) as { total: number; action: string | null; items: Array<{ action: string }> };
    expect(j2.total === 3 && j2.action === "asset.archive", `应恰 3 条归档：${JSON.stringify({ total: j2.total, action: j2.action })}`).toBe(true);
    expect(j2.items.every((i) => i.action === "asset.archive"), "全部条目应为归档").toBe(true);

    // 缺省格式仍是 CSV：text/csv + BOM（M22 契约不回退）
    const r3 = await rawGet(BASE, `/activity/export?teamId=${teamId}`, admin);
    expect((r3.headers.get("content-type") ?? "").startsWith("text/csv"), "缺省应 text/csv").toBe(true);
    const buf = new Uint8Array(await r3.arrayBuffer());
    expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "CSV 应带 UTF-8 BOM").toBe(true);

    // 盖章：三次导出各落一条 audit.export，detail 如实带格式/条数/过滤范围（先取数后盖章，章不进本次导出）。
    // 只认带 detail.format 的真实章（种子的 audit.export 行无 format，且其种子时间戳晚于当前时刻）
    const { rows: stamps } = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE team_id = $1 AND action = 'audit.export' AND detail ? 'format'
        ORDER BY created_at DESC LIMIT 3`,
      [teamId]
    );
    expect(stamps.length === 3, `应有 3 条导出章：${stamps.length}`).toBe(true);
    const [csvStamp, arcStamp, fullStamp] = stamps.map((r) => r.detail);
    expect(csvStamp.format === "csv" && csvStamp.action === null && csvStamp.count === expected + 2, `CSV 章应如实：${JSON.stringify(csvStamp)}`).toBe(true);
    expect(arcStamp.format === "json" && arcStamp.action === "asset.archive" && arcStamp.count === 3, `过滤章应如实：${JSON.stringify(arcStamp)}`).toBe(true);
    expect(fullStamp.format === "json" && fullStamp.action === null && fullStamp.count === expected, `全量章应如实：${JSON.stringify(fullStamp)}`).toBe(true);

    // 过滤出的导出章在动态页可见（action=audit.export）
    const view = await call("GET", `/activity?teamId=${teamId}&action=audit.export&limit=50`, { session: admin });
    expect(view.json.items.length === 4, `应 4 条导出动作（1 种子 + 3 章）：${view.json.items.length}`).toBe(true);
    expect(view.json.items.every((i: { summary: string }) => i.summary === "导出审计"), "摘要应为中文标签").toBe(true);
  });

  it("截断如实标注 + 参数校验 + 越权", { timeout: 120000 }, async () => {
    // 批量种 20001 条（单语句），无过滤导出应 cap 20000 且 truncated=true
    const { rows: u } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m24-${runId}@t.dev`]);
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at)
       SELECT $1, $2, 'm24bulk', 'audit', '{}'::jsonb, now() - (g || ' seconds')::interval
         FROM generate_series(1, 20001) g`,
      [teamId, u[0]!.id]
    );
    const r = await rawGet(BASE, `/activity/export?teamId=${teamId}&format=json`, admin);
    expect(r.status === 200, `导出应 200：${r.status}`).toBe(true);
    const j = (await r.json()) as { total: number; truncated: boolean; items: unknown[] };
    expect(j.truncated === true, "达上限应如实标注截断").toBe(true);
    expect(j.total === 20000 && j.items.length === 20000, `应恰 20000 条：${j.total}`).toBe(true);

    const badFormat = await rawGet(BASE, `/activity/export?teamId=${teamId}&format=xml`, admin);
    expect(badFormat.status === 422, `非法格式应 422：${badFormat.status}`).toBe(true);
    const badAction = await call("GET", `/activity?teamId=${teamId}&action=${encodeURIComponent("bad action!")}`, { session: admin });
    expect(badAction.status === 422, `非法 action 应 422：${badAction.status}`).toBe(true);

    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m24other-${runId}@t.dev`, password: "password-123", displayName: "M24外团队", teamName: `M24外团队-${runId}` }),
    });
    const other = sessionOf(o);
    const foreign = await rawGet(BASE, `/activity/export?teamId=${teamId}&format=json`, other);
    expect(foreign.status === 404, `非成员导出应 404：${foreign.status}`).toBe(true);
  });
});
