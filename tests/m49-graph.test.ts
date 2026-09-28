// M49 图数据库本体检索层测试 — 真实 Memgraph + PostgreSQL + HTTP，无 mock。
// 主线（图库在线）：种子类型层次/资产/关系 → 手动同步 → 闭包检索（图引擎）→
// 按类检索 → 多跳邻域 → 最短路径 → 撤回关系后投影如实收敛 → 团队隔离。
// 降级线（图库离线）：status 如实 reachable=false、闭包回落 SQL（engine 标注）、
// 邻域/路径 503 DEPENDENCY_UNAVAILABLE——核心目录流程不受影响。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { graphPing } from "@taw/graph";

const PORT = 4149;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const REAL_GRAPH_URL = process.env.GRAPHDB_URL ?? "bolt://127.0.0.1:7687";
process.env.GRAPHDB_URL = REAL_GRAPH_URL;
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const runId = randomBytes(4).toString("hex");

// 图库可达性必须在模块收集期确定：it.runIf 在 describe 收集时求值，
// beforeAll 里的运行时值为时已晚（vitest 条件测试陷阱）。
const graphUp = await graphPing();

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

describe("M49 图数据库本体检索", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let parentKey = "", childKey = "";
  let parentTypeId = "", childTypeId = "";
  let partOfRelTypeId = "";
  let A = "", B = "", C = "", D = "";
  let relAB = "", relBC = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m49-${runId}@t.dev`, "M49管理员", `M49图团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    await call("POST", "/projects", { session: admin, body: { teamId, name: `M49项目-${runId}`, code: `m49${runId.slice(0, 6)}` } });

    // 类型层次：parent（新基类）← child（收窄继承）
    parentKey = `m49base.${runId}`; childKey = `m49child.${runId}`;
    const pt = await call("POST", "/types", { session: admin, body: { teamId, typeKey: parentKey, version: "1.0.0", title: "M49 基类", jsonSchema: BASE_SCHEMA } });
    expectOk(pt.status === 201, pt.json, "注册父类型失败");
    parentTypeId = pt.json.typeVersionId;
    const ct = await call("POST", "/types", { session: admin, body: { teamId, typeKey: childKey, version: "1.0.0", title: "M49 子类", jsonSchema: CHILD_SCHEMA, parentTypeVersionId: parentTypeId } });
    expectOk(ct.status === 201, ct.json, "注册子类型失败");
    childTypeId = ct.json.typeVersionId;

    // 关系类型：播种默认表，取 partOf（requiresRevision=false，免修订绑定）
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    expectOk(relTypes.status === 200, relTypes.json, "取关系类型失败");
    const partOf = relTypes.json.find((r: { type_key: string }) => r.type_key === "partOf");
    expectOk(Boolean(partOf), relTypes.json, "默认 partOf 关系类型缺失");
    partOfRelTypeId = partOf.id;

    // 资产：A -partOf→ B -partOf→ C；D 孤立
    const mkAsset = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: childTypeId, properties: { name, format: "md" } } });
      expectOk(r.status === 201, r.json, `建资产 ${name} 失败`);
      return r.json.assetId as string;
    };
    A = await mkAsset(`M49资产A-${runId}`);
    B = await mkAsset(`M49资产B-${runId}`);
    C = await mkAsset(`M49资产C-${runId}`);
    D = await mkAsset(`M49资产D-${runId}`);
    const r1 = await call("POST", "/relations", { session: admin, body: { teamId, relationTypeVersionId: partOfRelTypeId, sourceAssetId: A, targetAssetId: B } });
    const r2 = await call("POST", "/relations", { session: admin, body: { teamId, relationTypeVersionId: partOfRelTypeId, sourceAssetId: B, targetAssetId: C } });
    expectOk(r1.status === 201, r1.json, "建关系 A→B 失败");
    expectOk(r2.status === 201, r2.json, "建关系 B→C 失败");
    relAB = r1.json.relationId; relBC = r2.json.relationId;
  });

  afterAll(async () => {
    process.env.GRAPHDB_URL = REAL_GRAPH_URL;
    await app.close();
  });

  it("状态端点：图库在线时可达性如实为 true", async () => {
    const st = await call("GET", `/graph/status?teamId=${teamId}`, { session: admin });
    expectOk(st.status === 200, st.json, "status 失败");
    expect(st.json.graphDb.reachable).toBe(graphUp);
  });

  it.runIf(graphUp)("手动同步：投影计数与漂移口径一致", async () => {
    const sync = await call("POST", "/graph/sync", { session: admin, body: { teamId } });
    expectOk(sync.status === 200, sync.json, "同步失败");
    expect(sync.json.nodes).toBe(sync.json.types + sync.json.assets);
    expect(sync.json.relations).toBe(2);
    const st = await call("GET", `/graph/status?teamId=${teamId}`, { session: admin });
    expect(st.json.drift.inSync).toBe(true);
    expect(st.json.projection.pendingSync).toBe(false);
  });

  it.runIf(graphUp)("类闭包检索（图引擎）：父类闭包含子类", async () => {
    const cl = await call("GET", `/ontology/type-closure?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
    expectOk(cl.status === 200, cl.json, "闭包失败");
    expect(cl.json.engine).toBe("graph");
    expect(new Set(cl.json.keys)).toEqual(new Set([parentKey, childKey]));
  });

  it.runIf(graphUp)("按类检索资产：闭包内类型命中的资产全部返回", async () => {
    const r = await call("GET", `/ontology/assets-by-type?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
    expectOk(r.status === 200, r.json, "按类检索失败");
    expect(r.json.engine).toBe("graph");
    const ids = r.json.assets.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual([A, B, C, D].sort());
    // 名称过滤
    const f = await call("GET", `/ontology/assets-by-type?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}&q=${encodeURIComponent(`资产A`)}`, { session: admin });
    expect(f.json.assets.map((a: { id: string }) => a.id)).toEqual([A]);
  });

  it.runIf(graphUp)("多跳邻域（深度2）：含 A/B/C，不含孤立 D", async () => {
    const r = await call("GET", `/graph/neighborhood?teamId=${teamId}&assetId=${A}&depth=2`, { session: admin });
    expectOk(r.status === 200 && r.json.found, r.json, "邻域失败");
    const nodeIds = r.json.nodes.map((n: { assetId: string }) => n.assetId);
    expect(nodeIds.sort()).toEqual([A, B, C].sort());
    expect(nodeIds).not.toContain(D);
    const edgeIds = r.json.edges.map((e: { relId: string }) => e.relId).sort();
    expect(edgeIds).toEqual([relAB, relBC].sort());
  });

  it.runIf(graphUp)("最短路径：A→C 经 B 两跳；A→D 无路径如实 found=false", async () => {
    const p1 = await call("GET", `/graph/path?teamId=${teamId}&from=${A}&to=${C}`, { session: admin });
    expectOk(p1.status === 200, p1.json, "路径查询失败");
    expect(p1.json.found).toBe(true);
    expect(p1.json.nodes.map((n: { assetId: string }) => n.assetId)).toEqual([A, B, C]);
    expect(p1.json.edges.map((e: { relId: string }) => e.relId)).toEqual([relAB, relBC]);

    const p2 = await call("GET", `/graph/path?teamId=${teamId}&from=${A}&to=${D}`, { session: admin });
    expectOk(p2.status === 200, p2.json, "无路径查询失败");
    expect(p2.json.found).toBe(false);
  });

  it.runIf(graphUp)("撤回关系后：脏标记 + 同步 → 投影如实收敛（路径断开）", async () => {
    const w = await call("POST", `/relations/${relBC}/withdraw`, { session: admin, body: { teamId, reason: "M49 投影收敛验证撤回" } });
    expectOk(w.status === 200, w.json, "撤回失败");
    const stBefore = await call("GET", `/graph/status?teamId=${teamId}`, { session: admin });
    expect(stBefore.json.projection.pendingSync).toBe(true);

    const sync = await call("POST", "/graph/sync", { session: admin, body: { teamId } });
    expectOk(sync.status === 200, sync.json, "再同步失败");
    expect(sync.json.relations).toBe(1);

    const p = await call("GET", `/graph/path?teamId=${teamId}&from=${A}&to=${C}`, { session: admin });
    expect(p.json.found).toBe(false);
    const st = await call("GET", `/graph/status?teamId=${teamId}`, { session: admin });
    expect(st.json.drift.inSync).toBe(true);
  });

  it.runIf(graphUp)("团队隔离：他团队资产不出现在本团队邻域/路径/按类检索中", async () => {
    const other = await register(`m49other-${runId}@t.dev`, "M49他队管理员", `M49他队-${runId}`);
    await call("POST", "/projects", { session: other.session, body: { teamId: other.teamId, name: `M49他队项目`, code: `m49o${runId.slice(0, 6)}` } });
    const types = await call("GET", `/types?teamId=${other.teamId}`, { session: other.session });
    const docType = types.json.find((t: { type_key: string }) => t.type_key === "document");
    const x = await call("POST", "/assets", { session: other.session, body: { teamId: other.teamId, name: `M49他队资产X-${runId}`, typeVersionId: docType.id, properties: { name: `M49他队资产X-${runId}`, docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m49" } } });
    expectOk(x.status === 201, x.json, "他队资产创建失败");
    const X = x.json.assetId as string;
    const sync2 = await call("POST", "/graph/sync", { session: other.session, body: { teamId: other.teamId } });
    expectOk(sync2.status === 200, sync2.json, "他队同步失败");

    const nh = await call("GET", `/graph/neighborhood?teamId=${teamId}&assetId=${A}&depth=3`, { session: admin });
    expect(nh.json.nodes.map((n: { assetId: string }) => n.assetId)).not.toContain(X);
    const p = await call("GET", `/graph/path?teamId=${teamId}&from=${A}&to=${X}`, { session: admin });
    expect(p.json.found).toBe(false);
    const byType = await call("GET", `/ontology/assets-by-type?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
    expect(byType.json.assets.map((a: { id: string }) => a.id)).not.toContain(X);
  });

  it("图库离线（指向死端口）：闭包/按类检索回落 SQL 且 engine 如实标注；邻域/路径 503；恢复后可达", async () => {
    process.env.GRAPHDB_URL = "bolt://127.0.0.1:9"; // 死端口：连接立即被拒
    try {
      const st = await call("GET", `/graph/status?teamId=${teamId}`, { session: admin });
      expect(st.status === 200, st.json).toBe(true);
      expect(st.json.graphDb.reachable).toBe(false);

      const cl = await call("GET", `/ontology/type-closure?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
      expect(cl.status, cl.json).toBe(200);
      expect(cl.json.engine).toBe("sql-fallback");
      expect(new Set(cl.json.keys)).toEqual(new Set([parentKey, childKey]));

      const byType = await call("GET", `/ontology/assets-by-type?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
      expect(byType.status, byType.json).toBe(200);
      expect(byType.json.engine).toBe("sql-fallback");
      expect(byType.json.assets.length).toBeGreaterThan(0);

      const nh = await call("GET", `/graph/neighborhood?teamId=${teamId}&assetId=${A}&depth=2`, { session: admin });
      expect(nh.status).toBe(503);
      expect(nh.json.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
      const p = await call("GET", `/graph/path?teamId=${teamId}&from=${A}&to=${C}`, { session: admin });
      expect(p.status).toBe(503);
    } finally {
      process.env.GRAPHDB_URL = REAL_GRAPH_URL;
    }
    // 恢复：driver 按 URL 重建，检索恢复
    const ping = await graphPing();
    expect(ping).toBe(graphUp);
    if (graphUp) {
      const cl = await call("GET", `/ontology/type-closure?teamId=${teamId}&typeKey=${encodeURIComponent(parentKey)}`, { session: admin });
      expect(cl.json.engine).toBe("graph");
    }
  });

  it("未登录访问检索端点：401", async () => {
    const r = await call("GET", `/ontology/type-closure?teamId=${teamId}&typeKey=document`);
    expect(r.status).toBe(401);
  });
});
