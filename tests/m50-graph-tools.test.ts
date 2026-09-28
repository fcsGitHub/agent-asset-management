// M50 Agent 图检索工具测试 — 真实 PostgreSQL + Memgraph + 工具网关，无 mock。
// graph.assetsByType（类闭包检索，离线回落 SQL 如实标注）、graph.path（名称/ID 两用，
// 歧义与未命中如实报错）、graph.neighbors（多跳邻域）、离线诚实报错、调用留痕落库、
// 租户隔离（他团队资产解析不到）。工具经 invokeTool 真实网关执行（SAVEPOINT 隔离同 m33）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";

const PORT = 4150;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const REAL_GRAPH_URL = process.env.GRAPHDB_URL ?? "bolt://127.0.0.1:7687";
process.env.GRAPHDB_URL = REAL_GRAPH_URL;
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

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, "注册失败").toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

const BASE_SCHEMA = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
const CHILD_SCHEMA = {
  type: "object", required: ["name", "format"],
  properties: { name: { type: "string" }, format: { type: "string" } },
};

describe("M50 Agent 图检索工具（真实网关 + 图数据库）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let adminUserId = "";
  let teamId = "", projectId = "", sessionId = "", runRowId = "";
  let parentKey = "", childKey = "";
  let A = "", B = "", C = "", D = "", amb1 = "", amb2 = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m50-${runId}@t.dev`, "M50管理员", `M50图工具团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const me = await call("GET", "/auth/me", { session: admin });
    adminUserId = me.json.userId as string;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M50项目-${runId}`, code: `m50${runId.slice(0, 6)}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M50工具验证", visibility: "project" } });
    sessionId = sess.json.sessionId;

    // 类型层次 + 资产 + 关系（C -partOf→ A -partOf→ B；D 孤立；两个模糊前缀资产）
    parentKey = `m50base.${runId}`; childKey = `m50child.${runId}`;
    const pt = await call("POST", "/types", { session: admin, body: { teamId, typeKey: parentKey, version: "1.0.0", title: "M50基类", jsonSchema: BASE_SCHEMA } });
    const ct = await call("POST", "/types", { session: admin, body: { teamId, typeKey: childKey, version: "1.0.0", title: "M50子类", jsonSchema: CHILD_SCHEMA, parentTypeVersionId: pt.json.typeVersionId } });
    const childTypeId = ct.json.typeVersionId;
    const mk = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: childTypeId, properties: { name, format: "md" } } });
      expectOk(r.status === 201, r.json, `建资产 ${name} 失败`);
      return r.json.assetId as string;
    };
    A = await mk(`M50轨道分析-${runId}`);
    B = await mk(`M50热控报告-${runId}`);
    C = await mk(`M50天线报告-${runId}`);
    D = await mk(`M50孤立资产-${runId}`);
    amb1 = await mk(`M50模糊甲-${runId}`);
    amb2 = await mk(`M50模糊乙-${runId}`);

    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const partOf = relTypes.json.find((r: { type_key: string }) => r.type_key === "partOf");
    const r1 = await call("POST", "/relations", { session: admin, body: { teamId, relationTypeVersionId: partOf.id, sourceAssetId: C, targetAssetId: A } });
    const r2 = await call("POST", "/relations", { session: admin, body: { teamId, relationTypeVersionId: partOf.id, sourceAssetId: A, targetAssetId: B } });
    expectOk(r1.status === 201, r1.json, "建关系 C→A 失败");
    expectOk(r2.status === 201, r2.json, "建关系 A→B 失败");

    // 同步图投影
    const sync = await call("POST", "/graph/sync", { session: admin, body: { teamId } });
    expectOk(sync.status === 200, sync.json, "图同步失败");

    // 真实运行行（tool_invocations 外键指向 agent_runs，同 m33）
    runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [teamId, runRowId, sessionId, projectId, "M50 工具验证",
         JSON.stringify([]),
         JSON.stringify(["graph.assetsByType", "graph.path", "graph.neighbors"]),
         JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), adminUserId]
      );
    });
  });

  afterAll(async () => {
    process.env.GRAPHDB_URL = REAL_GRAPH_URL;
    await app.close();
  });

  const ctx = () => ({ teamId, userId: adminUserId, projectId, runId: runRowId });
  // 工具调用与留痕写入须提交（readInTeam 结尾 ROLLBACK 会丢记录，m33 同款教训）
  const invoke = (name: string, args: unknown) =>
    seedInTeam(teamId, (c) => invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), `m50-${name}`, name, JSON.stringify(args)));

  it("graph.assetsByType：类闭包含子类资产，engine=graph；名称过滤生效", async () => {
    const r = await invoke("graph.assetsByType", { typeKey: parentKey });
    expect(r.status).toBe("ok");
    const result = r.result as { engine: string; keys: string[]; count: number; assets: { id: string; type_key: string }[] };
    expect(result.engine).toBe("graph");
    expect(new Set(result.keys)).toEqual(new Set([parentKey, childKey]));
    const ids = result.assets.map((x) => x.id).sort();
    expect(ids).toEqual([A, B, C, D, amb1, amb2].sort());
    const f = await invoke("graph.assetsByType", { typeKey: parentKey, q: "热控" });
    expect((f.result as { assets: { id: string }[] }).assets.map((x) => x.id)).toEqual([B]);
  });

  it("graph.assetsByType：includeSubclasses=false 只查精确类型（engine=sql）", async () => {
    const r = await invoke("graph.assetsByType", { typeKey: childKey, includeSubclasses: false });
    expect(r.status).toBe("ok");
    const result = r.result as { engine: string; keys: string[]; count: number };
    expect(result.engine).toBe("sql");
    expect(result.keys).toEqual([childKey]);
    expect(result.count).toBe(6);
  });

  it("graph.assetsByType：非法 typeKey 如实报错并被网关记录", async () => {
    const r = await invoke("graph.assetsByType", { typeKey: "9bad key!" });
    expect(r.status).toBe("error");
    expect(r.error).toContain("typeKey 非法");
  });

  it("graph.path：名称解析 + 链路与跳数正确；歧义名列出候选；未命中如实报错", async () => {
    const p = await invoke("graph.path", { fromName: `M50天线报告-${runId}`, toName: `M50热控报告-${runId}` });
    expect(p.status).toBe("ok");
    const result = p.result as { found: boolean; hops: number; nodes: { name: string }[] };
    expect(result.found).toBe(true);
    expect(result.hops).toBe(2);
    expect(result.nodes.map((n) => n.name.replace(`-${runId}`, ""))).toEqual(["M50天线报告", "M50轨道分析", "M50热控报告"]);

    const amb = await invoke("graph.path", { fromName: `M50模糊`, toName: `M50热控报告-${runId}` });
    expect(amb.status).toBe("error");
    expect(amb.error).toContain("命中多个资产");
    expect(amb.error).toContain("请改用 assetId");

    const miss = await invoke("graph.path", { fromName: "不存在的资产XYZ", toName: `M50热控报告-${runId}` });
    expect(miss.status).toBe("error");
    expect(miss.error).toContain("未命中任何本团队资产");

    const byId = await invoke("graph.path", { fromAssetId: C, toAssetId: B });
    expect((byId.result as { found: boolean; hops: number }).hops).toBe(2);

    const same = await invoke("graph.path", { fromAssetId: A, toAssetId: A });
    expect(same.status).toBe("error");
    expect(same.error).toContain("同一资产");

    const nf = await invoke("graph.path", { fromAssetId: A, toAssetId: D });
    expect((nf.result as { found: boolean }).found).toBe(false);
  });

  it("graph.neighbors：深度 2 含链上资产、不含孤立 D", async () => {
    const r = await invoke("graph.neighbors", { name: `M50轨道分析-${runId}`, depth: 2 });
    expect(r.status).toBe("ok");
    const result = r.result as { found: boolean; depth: number; nodes: { id?: string; assetId: string }[]; edges: unknown[] };
    expect(result.found).toBe(true);
    expect(result.depth).toBe(2);
    const ids = result.nodes.map((n) => n.assetId).sort();
    expect(ids).toEqual([A, B, C].sort());
    expect(result.edges.length).toBe(2);
  });

  it("租户隔离：他团队同名资产在本团队上下文解析不到", async () => {
    const other = await register(`m50other-${runId}@t.dev`, "M50他队", `M50他队-${runId}`);
    await call("POST", "/projects", { session: other.session, body: { teamId: other.teamId, name: "M50他队项目", code: `m50o${runId.slice(0, 6)}` } });
    const types = await call("GET", `/types?teamId=${other.teamId}`, { session: other.session });
    const docType = types.json.find((t: { type_key: string }) => t.type_key === "document");
    await call("POST", "/assets", { session: other.session, body: { teamId: other.teamId, name: `M50热控报告-${runId}`, typeVersionId: docType.id, properties: { name: `M50热控报告-${runId}`, docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m50" } } });

    // 本团队上下文里按同名解析：解析到的是本团队资产（id = 本团队 B），绝不串队
    const p = await invoke("graph.path", { fromName: `M50天线报告-${runId}`, toName: `M50热控报告-${runId}` });
    expect(p.status).toBe("ok");
    expect((p.result as { to: { id: string } }).to.id).toBe(B);
  });

  it("图库离线：assetsByType 回落 sql-fallback 如实标注；path/neighbors 如实报错；恢复后自愈", async () => {
    process.env.GRAPHDB_URL = "bolt://127.0.0.1:9";
    try {
      const byType = await invoke("graph.assetsByType", { typeKey: parentKey });
      expect(byType.status).toBe("ok");
      expect((byType.result as { engine: string }).engine).toBe("sql-fallback");
      expect((byType.result as { count: number }).count).toBeGreaterThan(0);

      const path = await invoke("graph.path", { fromAssetId: C, toAssetId: B });
      expect(path.status).toBe("error");
      expect(path.error).toContain("图数据库不可用");

      const nb = await invoke("graph.neighbors", { assetId: A });
      expect(nb.status).toBe("error");
      expect(nb.error).toContain("图数据库不可用");
    } finally {
      process.env.GRAPHDB_URL = REAL_GRAPH_URL;
    }
    const ok = await invoke("graph.assetsByType", { typeKey: parentKey });
    expect((ok.result as { engine: string }).engine).toBe("graph");
  });

  it("调用留痕：ok 与 error 全部真实落库（含图工具名）", async () => {
    const rows = await readInTeam(teamId, async (c) => {
      const { rows } = await c.query<{ name: string; status: string }>(
        `SELECT name, status FROM tool_invocations WHERE team_id = $1 AND run_id = $2 ORDER BY created_at`,
        [teamId, runRowId]
      );
      return rows;
    });
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(rows.filter((r) => r.name === "graph.assetsByType" && r.status === "ok").length).toBeGreaterThanOrEqual(3);
    expect(rows.filter((r) => r.name === "graph.path" && r.status === "error").length).toBeGreaterThanOrEqual(3);
    expect(rows.filter((r) => r.name === "graph.neighbors" && r.status === "ok").length).toBeGreaterThanOrEqual(1);
  });
});
