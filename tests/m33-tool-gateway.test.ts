// M33 工具网关健壮性 — 真实 PostgreSQL/HTTP。
// 实测走查发现：工具内 SQL 失败（如模型传入非法 UUID）会中止整个 withTeam 事务，
// invokeTool 的 record("error") 连带失败，整轮运行以 "current transaction is aborted"
// 崩溃且不留调用记录。修复：SAVEPOINT 隔离工具执行。本文件钉死该行为，
// 并覆盖 asset.getRevision 缺省 revisionId 读取最新修订的新契约、
// 以及 /sessions/:id/runs 返回 context_refs（@ 引用的时间线重建依赖）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";

const PORT = 4114;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const runId = randomBytes(4).toString("hex");

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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** 夹具播种：真实提交（测试体用的只读校验另开连接）。 */
async function seedInTeam<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

async function readInTeam<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

describe("M33 工具网关 SAVEPOINT 隔离与契约补强（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "", sessionId = "", assetId = "", runIdFix = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m33-${runId}@t.dev`, password: "password-123", displayName: "M33验证员", teamName: `M33团队-${runId}` }),
    });
    expect(reg.status).toBe(201);
    admin = sessionOf(reg);
    teamId = ((await reg.json()) as { teamId: string }).teamId;

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M33项目", code: `m33-${runId}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "网关验证", visibility: "project" },
    });
    sessionId = sess.json.sessionId;

    const me = await call("GET", "/auth/me", { session: admin });
    const userId = me.json.userId as string;

    // 真实资产（getRevision 正向用例）
    const typeRes = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docType = (typeRes.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "网关验证资产", typeVersionId: docType.id,
        properties: { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "网关" } },
    });
    assetId = asset.json.assetId;

    // 真实运行行（tool_invocations 有外键指向 agent_runs）
    runIdFix = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [teamId, runIdFix, sessionId, projectId, "夹具运行",
         JSON.stringify(["资产「网关验证资产」(id: " + assetId + ", 类型 document v1.0.0)"]),
         JSON.stringify(["asset.search", "asset.getRevision", "relation.query"]),
         JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), userId]
      );
    });
  });

  afterAll(async () => { await app.close(); });

  const ctx = () => ({ teamId, userId: randomUUID(), projectId, runId: runIdFix });

  it("工具内 SQL 错误被 SAVEPOINT 隔离：如实记录 error，同事务后续调用不受影响", async () => {
    // 非法 UUID 会在工具查询时触发 PG 错误；修复前此处整事务中止、记录写不进、运行崩溃
    const res = await seedInTeam(teamId, async (c) => {
      const bad = await invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), "call-bad", "asset.getRevision",
        JSON.stringify({ assetId: "not-a-uuid" }));
      // 同一事务继续正常执行：修复前此处抛 "current transaction is aborted"
      const good = await invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), "call-good", "asset.search", "{}");
      return { bad, good };
    });
    expect(res.bad.status).toBe("error");
    expect(res.bad.error).toMatch(/uuid|invalid/i);
    expect(res.good.status).toBe("ok");

    // 两条调用记录都真实落库（修复前 error 记录随事务回滚丢失）
    const rows = await readInTeam(teamId, async (c) => {
      const { rows } = await c.query<{ call_id: string; status: string; error: string }>(
        `SELECT call_id, status, error FROM tool_invocations WHERE team_id = $1 AND run_id = $2 ORDER BY created_at`,
        [teamId, runIdFix]
      );
      return rows;
    });
    expect(rows.find((r) => r.call_id === "call-bad")?.status).toBe("error");
    expect(rows.find((r) => r.call_id === "call-bad")?.error).toMatch(/uuid|invalid/i);
    expect(rows.find((r) => r.call_id === "call-good")?.status).toBe("ok");
  });

  it("asset.getRevision 缺省 revisionId 时读取最新修订；不存在则如实 error", async () => {
    const res = await seedInTeam(teamId, async (c) => {
      const head = await invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), "call-head", "asset.getRevision",
        JSON.stringify({ assetId }));
      const missing = await invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), "call-missing", "asset.getRevision",
        JSON.stringify({ assetId, revisionId: "00000000-0000-0000-0000-000000000000" }));
      return { head, missing };
    });
    expect(res.head.status).toBe("ok");
    expect((res.head.result as { seq: number }).seq).toBe(1);
    expect(res.missing.status).toBe("error");
    expect(res.missing.error).toContain("修订不存在");
  });

  it("会话运行历史返回 context_refs（@ 引用时间线重建依赖）", async () => {
    const res = await call("GET", `/sessions/${sessionId}/runs?teamId=${teamId}`, { session: admin });
    expect(res.status).toBe(200);
    const run = (res.json as { id: string; context_refs?: string[] }[]).find((r) => r.id === runIdFix);
    expect(run).toBeTruthy();
    expect(run!.context_refs).toEqual([`资产「网关验证资产」(id: ${assetId}, 类型 document v1.0.0)`]);
  });
});
