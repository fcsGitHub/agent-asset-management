// M22 测试 — 审计导出 CSV：与列表同源的分页查询全量遍历（时间正序）、RFC 4180 转义
// （逗号/双引号/换行）、项目过滤语义、audit.export 盖章进入审计流、越权拒绝。
// SQL 直接造数（多项目 + 团队级 + 特殊字符），全部真实集成，无 mock。
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
  return async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any; headers: Headers; text: string }> {
    const headers: Record<string, string> = {};
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      headers["x-csrf-token"] = opts.session.csrf;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON（CSV） */ }
    return { status: res.status, json, headers: res.headers, text };
  };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

/** RFC 4180 解析（引号字段、双引号转义、字段内换行）。 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const skipBom = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (i = skipBom; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ",") { row.push(field); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === "" && false));
}

const PORT = 4130;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M22 审计导出 CSV", () => {
  let app: FastifyInstance;
  let adminPool: Pool;
  let admin: Session;
  let outsider: Session;
  let teamId = "";
  let p1 = "";
  let p2 = "";
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
      expect(res.status === 201, `注册失败 ${email}: ${await res.clone().text()}`).toBe(true);
      const body = (await res.json()) as { teamId: string; userId: string };
      return { session: sessionOf(res), body };
    };
    const a = await reg(`m22-${runId}@t.dev`, "M22队长", `M22团队-${runId}`);
    admin = a.session; teamId = a.body.teamId; userId = a.body.userId;
    const o = await reg(`m22other-${runId}@t.dev`, "M22外团队", `M22外团队-${runId}`);
    outsider = o.session;

    const mk = async (name: string, code: string): Promise<string> => {
      const r = await call("POST", "/projects", { session: admin, body: { teamId, name, code } });
      expectOk(r.status === 201, r.json, `建项目失败：${name}`);
      return r.json.projectId;
    };
    p1 = await mk(`M22项目一-${runId}`, `m22a${runId.slice(0, 5)}`);
    p2 = await mk(`M22项目二-${runId}`, `m22b${runId.slice(0, 5)}`);
    const sess = await call("POST", `/projects/${p1}/sessions`, {
      session: admin, body: { teamId, title: `M22会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;

    // 造数：团队级审计 ×2（project_id NULL）、P1 审计 ×2、P2 审计 ×1；
    // 特殊字符动作名（逗号/双引号进入 action 与 summary）；P1 运行一条（prompt 含逗号/引号/换行）
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at) VALUES
         ($1,$2,'custom"a,c','asset',jsonb_build_object('note','escape'), '2026-09-20 10:00:00+00'),
         ($1,$2,'asset.archive','asset',jsonb_build_object('note','t'), '2026-09-20 10:01:00+00')`,
      [teamId, userId]
    );
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, project_id, detail, created_at) VALUES
         ($1,$2,'review_prepared','change_request',$3,jsonb_build_object('note','p1'), '2026-09-20 10:02:00+00'),
         ($1,$2,'release_published','release_set',$3,jsonb_build_object('note','p1'), '2026-09-20 10:04:00+00')`,
      [teamId, userId, p1]
    );
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, project_id, detail, created_at)
       VALUES ($1,$2,'asset.archive','asset',$3,jsonb_build_object('note','p2'), '2026-09-20 10:05:00+00')`,
      [teamId, userId, p2]
    );
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by, created_at)
       VALUES ($1,$2,$3,$4,'completed',$5,$6,'2026-09-20 10:03:00+00')`,
      [teamId, randomUUID(), sessionId, p1, `讨论"A,B"方案,\n第二行继续`, userId]
    );
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("全量导出：时间正序、恰为 DB 全集（含特殊字符完整转义）、每次导出盖 audit.export 章", async () => {
    const before = await adminPool.query<{ n: string; m: string }>(
      `SELECT (SELECT count(*) FROM audit_events WHERE team_id=$1) AS n,
              (SELECT count(*) FROM agent_runs WHERE team_id=$1) AS m`,
      [teamId]
    );
    const total = Number(before.rows[0]!.n) + Number(before.rows[0]!.m);

    const res = await fetch(`${BASE}/activity/export?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    expectOk(res.status === 200, res.status, "导出应 200");
    expect(String(res.headers.get("content-type")).includes("text/csv"), `应为 CSV：${res.headers.get("content-type")}`).toBe(true);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, "应以 UTF-8 BOM 字节开头（Excel 兼容）").toBe(true);
    const r1 = { headers: res.headers, text: new TextDecoder("utf-8").decode(bytes) };
    const parsed = parseCsv(r1.text);
    expect(parsed[0]!.join(",") === "ts,kind,entry_id,action,summary,actor,project,object_id",
      `表头应完整：${parsed[0]!.join(",")}`).toBe(true);
    const dataRows = parsed.slice(1);
    expect(dataRows.length === total, `导出应恰为全量：${dataRows.length} vs ${total}`).toBe(true);
    // 时间正序
    for (let i = 1; i < dataRows.length; i++) {
      expect(dataRows[i]![0]! >= dataRows[i - 1]![0]!, `应时间正序：${dataRows[i - 1]![0]} > ${dataRows[i]![0]}`).toBe(true);
    }
    // 特殊字符完整保真（转义往返）
    const tricky = dataRows.find((r) => r[2]!.startsWith("audit:"))!;
    expect(dataRows.some((r) => r[3] === `custom"a,c`), `action 含引号逗号应完整保真：${JSON.stringify(dataRows.map((r) => r[3]))}`).toBe(true);
    expect(dataRows.some((r) => r[4] === `讨论"A,B"方案,\n第二行继续`), `运行摘要含逗号/引号/换行应完整保真`).toBe(true);
    expect(!!tricky, "应有 audit 条目").toBe(true);

    // 第一次导出的章不进入本次导出，但已落库；第二次导出应包含它（summary 为中文标签）
    const stamped = await adminPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_events WHERE team_id=$1 AND action='audit.export'`, [teamId]
    );
    expect(Number(stamped.rows[0]!.n) === 1, "导出应盖一次 audit.export 章").toBe(true);
    const r2 = await call("GET", `/activity/export?teamId=${teamId}`, { session: admin });
    const rows2 = parseCsv(r2.text).slice(1);
    expect(rows2.length === total + 1, `第二次导出应含导出章：${rows2.length} vs ${total + 1}`).toBe(true);
    expect(rows2.some((r) => r[3] === "audit.export" && r[4] === "导出审计"), `导出章应可见：${JSON.stringify(rows2.slice(0, 2))}`).toBe(true);
    // entry_id 全局唯一
    const ids = rows2.map((r) => r[2]!);
    expect(new Set(ids).size === ids.length, "entry_id 应唯一").toBe(true);
  });

  it("项目过滤导出：仅该项目内动作；团队级与其它项目不出现（M16 语义一致）", async () => {
    const r = await call("GET", `/activity/export?teamId=${teamId}&projectId=${p1}`, { session: admin });
    expectOk(r.status === 200, r.status, "项目过滤导出应 200");
    const rows = parseCsv(r.text).slice(1);
    const db = await adminPool.query<{ n: string; m: string }>(
      `SELECT (SELECT count(*) FROM audit_events WHERE team_id=$1 AND project_id=$2) AS n,
              (SELECT count(*) FROM agent_runs WHERE team_id=$1 AND project_id=$2) AS m`,
      [teamId, p1]
    );
    const total = Number(db.rows[0]!.n) + Number(db.rows[0]!.m);
    expect(rows.length === total, `过滤导出应恰为该项目全集：${rows.length} vs ${total}`).toBe(true);
    expect(rows.every((r) => r[6] === `M22项目一-${runId}`), `project 列应一致：${JSON.stringify(rows.map((r) => r[6]))}`).toBe(true);
    expect(!rows.some((r) => r[3] === "asset.archive" && r[6] === ""), "团队级动作不应出现在项目过滤导出").toBe(true);
  });

  it("越权：非成员 404，匿名 401", async () => {
    const o = await call("GET", `/activity/export?teamId=${teamId}`, { session: outsider });
    expect(o.status === 404, `非成员应 404，实际 ${o.status}`).toBe(true);
    const anon = await call("GET", `/activity/export?teamId=${teamId}`, {});
    expect(anon.status === 401, `匿名应 401，实际 ${anon.status}`).toBe(true);
  });
});
