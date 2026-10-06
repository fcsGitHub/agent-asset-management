// M71 本体关联轮集成测试（五项）：
// ①目录搜索类闭包展开（Wikidata P279* / Foundry Interfaces 锚点）：type=父类同时命中
//   全部子类 type_key（search/export 同源 queryAssetRows）；子类过滤不向上反渗；未知
//   类型如实空结果（不静默放宽为不过滤）。
// ②本体树端点 GET /ontology/tree：层次（parentKey/children）、闭包计数（closureAssetCount
//   = 选它过滤目录的真实命中数）、模式声明属性键/必填键、关系注册表（domain/range/断言数）。
// ③Agent 本体工具：ontology.types（浏览门类树）/ ontology.typeInfo（类型链必填并集、
//   子类闭包、适用关系 asSource/asTarget）/ asset.search 类型闭包对齐（与人类目录同义）。
// ④属性键发现：facets.propertyKeys = head 修订观测一级键聚合（跨门类公共键可发现）。
// ⑤M70 漏改修复：/ontology/assets-by-type 默认 active 视图应含已弃用资产（弃用可见
//   不隐藏），且弃用排后；@taw/graph SQL 回落闭包子版本同样须 active 版本。
// 纯函数（buildOntologyTree/flattenOntologyTree/relationsForClosure）单测同文件先行。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";
import {
  buildOntologyTree,
  flattenOntologyTree,
  relationsForClosure,
  type OntologyTypeRow,
  type OntologyRelationRow,
} from "@taw/domain/ontology-tree";

const PORT = 4191;
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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 600)}`);
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

// ---------- 纯函数 ----------

describe("M71 纯函数：buildOntologyTree / flattenOntologyTree / relationsForClosure", () => {
  const rows: OntologyTypeRow[] = [
    { key: "sim.base", title: "基类", version: "1.0.0", parentKey: null, assetCount: 2, propertyKeys: ["owner"], requiredKeys: ["owner"], requiresTestEvidence: false },
    { key: "sim.model", title: "模型", version: "1.1.0", parentKey: "sim.base", assetCount: 3, propertyKeys: ["owner", "accuracy"], requiredKeys: ["owner"], requiresTestEvidence: false },
    { key: "sim.model.fmi", title: "FMI 模型", version: "1.0.0", parentKey: "sim.model", assetCount: 5, propertyKeys: ["fmiVersion"], requiredKeys: [], requiresTestEvidence: true },
    { key: "doc", title: "文档", version: "1.0.0", parentKey: null, assetCount: 7, propertyKeys: [], requiredKeys: [], requiresTestEvidence: false },
  ];

  it("层次构建 + 闭包计数：父类闭包资产数 = 自身 + 全部后代；子类清单排序稳定", () => {
    const tree = buildOntologyTree(rows);
    expect(tree.map((n) => n.key).sort()).toEqual(["doc", "sim.base"]);
    const base = tree.find((n) => n.key === "sim.base")!;
    expect(base.children.map((c) => c.key)).toEqual(["sim.model"]);
    expect(base.subclassKeys).toEqual(["sim.model", "sim.model.fmi"]); // 全部后代闭包
    expect(base.closureAssetCount).toBe(2 + 3 + 5); // 闭包计数 = 目录类闭包过滤的真实命中数
    const model = base.children[0]!;
    expect(model.subclassKeys).toEqual(["sim.model.fmi"]);
    expect(model.closureAssetCount).toBe(8);
    expect(model.children[0]!.closureAssetCount).toBe(5);
  });

  it("展平带 depth/parentKey 还原层次；悬空父引用升根并如实标注（不静默丢弃）", () => {
    const withDangling: OntologyTypeRow[] = [
      ...rows,
      { key: "orphan.thing", title: "孤儿", version: "1.0.0", parentKey: "ghost.gone", assetCount: 1, propertyKeys: [], requiredKeys: [], requiresTestEvidence: false },
    ];
    const flat = flattenOntologyTree(buildOntologyTree(withDangling));
    const orphan = flat.find((n) => n.key === "orphan.thing")!;
    expect(orphan.depth).toBe(0); // 父不在行集 → 升为根，不消失
    expect(orphan.danglingParentKey).toBe("ghost.gone"); // 如实标注
    const fmi = flat.find((n) => n.key === "sim.model.fmi")!;
    expect(fmi.depth).toBe(2);
    expect(fmi.parentKey).toBe("sim.model");
  });

  it("relationsForClosure：空 type_keys = 该侧对任意类型开放；非空需闭包交集；asSource/asTarget 分侧", () => {
    const rels: OntologyRelationRow[] = [
      { key: "derivedFrom", title: "派生自", sourceTypeKeys: [], targetTypeKeys: [], assertionCount: 4 },
      { key: "validatedBy", title: "被验证", sourceTypeKeys: ["sim.model"], targetTypeKeys: [], assertionCount: 2 },
      { key: "docOnly", title: "仅文档", sourceTypeKeys: ["doc"], targetTypeKeys: ["doc"], assertionCount: 0 },
    ];
    // sim.model.fmi 的闭包含 sim.model → validatedBy 以 source 侧适用（继承自父类闭包）
    const hit = relationsForClosure(["sim.model.fmi", "sim.model"], rels);
    const byKey = Object.fromEntries(hit.map((r) => [r.key, r]));
    expect(byKey["derivedFrom"]?.asSource && byKey["derivedFrom"]?.asTarget).toBe(true); // 两侧开放
    expect(byKey["validatedBy"]?.asSource).toBe(true); // source 侧限定 sim.model，闭包含它
    expect(byKey["validatedBy"]?.asTarget).toBe(true); // target 侧清单为空 = 对任意类型开放
    expect(byKey["docOnly"]).toBeUndefined(); // 闭包无交集 → 不适用
    // 严格分侧负例：source 限定 doc（闭包无交集 → asSource=false）、target 不限（asTarget=true）
    // → 关系仍适用（可作目标端），但分侧如实标注
    const strict = relationsForClosure(["sim.model"], [
      { key: "strict.rel", title: "严格", sourceTypeKeys: ["doc"], targetTypeKeys: [], assertionCount: 0 },
    ]);
    expect(strict).toEqual([
      { key: "strict.rel", title: "严格", asSource: false, asTarget: true, assertionCount: 0 },
    ]);
  });
});

// ---------- 端到端 ----------

describe("M71 端到端：类闭包目录搜索 + 本体树 + Agent 本体工具 + 属性键发现 + 弃用可见性修复", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let adminUserId = "";
  let projectId = "", sessionId = "", runRowId = "";
  // 本体：基类（1 资产）— 子类（2 资产，其中 1 个已弃用）— 孙类（1 资产）；旁支独立类型（1 资产）
  const baseKey = `m71.base.${runId.slice(0, 4)}`;
  const childKey = `m71.child.${runId.slice(0, 4)}`;
  const grandKey = `m71.grand.${runId.slice(0, 4)}`;
  const otherKey = `m71.other.${runId.slice(0, 4)}`;
  let baseVerId = "", childVerId = "", grandVerId = "", otherVerId = "";
  let aBase = "", aChild1 = "", aChild2 = "", aGrand = "", aOther = "";
  const N = runId.slice(0, 6);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m71admin-${runId}@t.dev`, password: "password-123", displayName: "M71管理员", teamName: `M71团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const me = await call("GET", "/auth/me", { session: admin });
    adminUserId = me.json.userId as string;

    // 本体：base ← child ← grand 三级 + 旁支 other（子类型须是父定义的收窄：只加属性）
    const mkType = async (typeKey: string, parentVersionId: string | undefined, props: Record<string, unknown>, required: string[]) => {
      const r = await call("POST", "/types", {
        session: admin,
        body: {
          teamId, typeKey, version: "1.0.0", title: typeKey,
          ...(parentVersionId ? { parentTypeVersionId: parentVersionId } : {}),
          jsonSchema: { type: "object", properties: props, required },
        },
      });
      expectOk(r.status === 201, r.json, `注册类型 ${typeKey} 失败`);
      return r.json.typeVersionId as string;
    };
    baseVerId = await mkType(baseKey, undefined, { owner: { type: "string" }, frame: { type: "string", enum: ["ECI", "ECEF"] } }, ["owner"]);
    childVerId = await mkType(childKey, baseVerId, { accuracy: { type: "number" } }, []);
    grandVerId = await mkType(grandKey, childVerId, { fmiVersion: { type: "string" } }, []);
    otherVerId = await mkType(otherKey, undefined, { owner: { type: "string" } }, []);

    const mkAsset = async (name: string, typeVersionId: string, properties: Record<string, unknown>) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
      return r.json.assetId as string;
    };
    aBase = await mkAsset(`M71基类资产-${N}`, baseVerId, { owner: "alice", frame: "ECI" });
    aChild1 = await mkAsset(`M71子类资产一-${N}`, childVerId, { owner: "bob", accuracy: 0.93 });
    aChild2 = await mkAsset(`M71子类资产二-${N}`, childVerId, { owner: "carol", accuracy: 0.87 });
    aGrand = await mkAsset(`M71孙类资产-${N}`, grandVerId, { owner: "dave", accuracy: 0.9, fmiVersion: "3.0" });
    aOther = await mkAsset(`M71旁支资产-${N}`, otherVerId, { owner: "erin" });
    // 子类资产二弃用（M70 治理动作）：默认视图应仍可见（弃用不隐藏）且带警示
    const dep = await call("POST", `/assets/${aChild2}/deprecate`, { session: admin, body: { teamId, note: "精度不足，由子类资产一替代", successorRef: `M71子类资产一-${N}` } });
    expectOk(dep.status === 200, dep.json, "弃用失败");

    // Agent 工具断言用的运行行（tool_invocations 外键，同 m50/m70）
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M71项目-${runId}`, code: `m71${N}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M71工具验证", visibility: "project" } });
    sessionId = sess.json.sessionId;
    runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [teamId, runRowId, sessionId, projectId, "M71 工具验证",
         JSON.stringify([]), JSON.stringify(["asset.search", "ontology.types", "ontology.typeInfo"]),
         JSON.stringify({ maxToolCalls: 4, maxTokens: 20000 }), adminUserId]
      );
    });
  });
  afterAll(async () => { await app.close(); });

  const ctx = () => ({ teamId, userId: adminUserId, projectId, runId: runRowId });
  const invoke = (name: string, args: unknown) =>
    seedInTeam(teamId, (c) => invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), `m71-${name}-${randomUUID().slice(0, 8)}`, name, JSON.stringify(args)));

  it("①目录类闭包：type=基类命中基类+子类+孙类（弃用可见），子类过滤不反渗，未知类型空结果，导出同源", async () => {
    // 默认 active 视图：base 闭包 = base(1) + child(2, 含弃用) + grand(1) = 4；旁支不在闭包
    const s = await call("GET", `/assets/search?teamId=${teamId}&type=${baseKey}&limit=50`, { session: admin });
    expectOk(s.status === 200 && s.json.length === 4, s.json.map((r: { name: string }) => r.name), "基类闭包应命中 4 项（含弃用子类资产）");
    const names = (s.json as { name: string; lifecycle: string; type_key: string }[]).map((r) => r.name);
    expect(names).toContain(`M71孙类资产-${N}`); // 孙类也在闭包里（递归）
    const dep2 = (s.json as { name: string; lifecycle: string }[]).find((r) => r.name === `M71子类资产二-${N}`);
    expectOk(dep2?.lifecycle === "deprecated", dep2, "弃用子类资产应在默认视图且如实标注");
    // 行上 type_key 是各自实际类型（跨门类命中可见）
    expect((s.json as { type_key: string }[]).map((r) => r.type_key).sort()).toEqual([baseKey, childKey, childKey, grandKey].sort());
    // 子类过滤：不向上反渗（基类/孙类不在），孙类在（child 闭包含 grand）
    const c = await call("GET", `/assets/search?teamId=${teamId}&type=${childKey}&limit=50`, { session: admin });
    expectOk(c.status === 200 && c.json.length === 3, c.json.map((r: { name: string }) => r.name), "子类闭包应命中 3 项（子类×2 + 孙类）");
    expect((c.json as { type_key: string }[]).every((r) => r.type_key !== baseKey)).toBe(true);
    // 未知类型：如实空（不静默放宽为不过滤）
    const u = await call("GET", `/assets/search?teamId=${teamId}&type=m71.nonexistent.${runId.slice(0, 4)}&limit=50`, { session: admin });
    expectOk(u.status === 200 && u.json.length === 0, u.json, "未知类型应空结果");
    // 导出与目录同源（同一 queryAssetRows 管线）：闭包行数一致（CSV 原始字节抓取，剥 BOM）
    const exp = await fetch(`${BASE}/assets/export?teamId=${teamId}&format=csv&type=${baseKey}`, {
      headers: { cookie: admin.cookie },
    });
    const expText = await exp.text();
    const bodyLines = expText.replace(/^\uFEFF/, "").split("\r\n").filter((l) => l && !l.startsWith("#"));
    expectOk(exp.status === 200 && bodyLines.length === 5, bodyLines, "导出应含表头 + 4 行闭包结果");
    // 闭包可与属性筛选组合（同一候选集上取交集）
    const combo = await call("GET", `/assets/search?teamId=${teamId}&type=${baseKey}&prop=owner=bob`, { session: admin });
    expectOk(combo.status === 200 && combo.json.length === 1 && combo.json[0].name === `M71子类资产一-${N}`, combo.json, "闭包×属性筛选应交集命中");
  });

  it("②本体树：层次/闭包计数/属性键/必填键/关系注册表同端点下发", async () => {
    const t = await call("GET", `/ontology/tree?teamId=${teamId}`, { session: admin });
    expectOk(t.status === 200 && Array.isArray(t.json.tree), t.json, "本体树端点失败");
    const flat = flattenOntologyTree(t.json.tree as Parameters<typeof buildOntologyTree>[0]);
    const base = flat.find((n) => n.key === baseKey)!;
    expectOk(base !== undefined, flat.map((n) => n.key), "基类应在树中");
    expect(base.assetCount).toBe(1);
    expect(base.subclassKeys.sort()).toEqual([childKey, grandKey].sort());
    expect(base.closureAssetCount).toBe(4); // 与①的目录闭包命中数一致（同一语义）
    const child = flat.find((n) => n.key === childKey)!;
    expect(child.parentKey).toBe(baseKey);
    expect(child.propertyKeys).toContain("accuracy"); // 模式声明属性键（本版本）
    expect(base.requiredKeys).toEqual(["owner"]); // 必填键
    // 关系注册表：默认关系类型下发（domain/range 口径）
    const relKeys = (t.json.relations as { key: string }[]).map((r) => r.key);
    expect(relKeys).toContain("derivedFrom");
    // 外人不可见（租户隔离）
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m71other-${runId}@t.dev`, password: "password-123", displayName: "M71外人", teamName: `M71外团队-${runId}` }),
    });
    const outsider = sessionOf(o);
    const t2 = await call("GET", `/ontology/tree?teamId=${teamId}`, { session: outsider });
    expect(t2.status).toBe(404); // 非成员访问他团队 = 不存在（项目惯例：不泄露团队存在性）
  });

  it("③Agent 本体工具：types 浏览（含闭包计数）→ typeInfo（链上必填并集/子类/适用关系）→ asset.search 闭包对齐", async () => {
    const types = await invoke("ontology.types", { q: baseKey });
    expectOk(types.status === "ok" && types.result?.count === 1, types, "ontology.types 应命中基类");
    const node = types.result.types[0];
    expect(node.closureAssetCount).toBe(4); // Agent 看到的闭包计数与目录/本体树一致
    expect(node.subclassKeys.length).toBe(2);
    expect(node.requiredKeys).toEqual(["owner"]);
    // 不存在的类型如实报错并引导
    const miss = await invoke("ontology.typeInfo", { typeKey: `m71.ghost.${runId.slice(0, 4)}` });
    expectOk(miss.status === "error" && /不在本团队本体中/.test(miss.error ?? ""), miss.error, "幽灵类型应报错");
    // typeInfo：孙类的类型链 = 孙→子→基（注册时校验链的浏览面）；必填并集含基类 owner
    const info = await invoke("ontology.typeInfo", { typeKey: grandKey });
    expectOk(info.status === "ok", info, "typeInfo 失败");
    const chainKeys = info.result.chain.map((c: { typeKey: string }) => c.typeKey);
    expect(chainKeys).toEqual([grandKey, childKey, baseKey]);
    expect(info.result.requiredAll).toEqual(["owner"]); // 链上必填并集（登记口径）
    expect(info.result.assetCount).toBe(1);
    expect(info.result.closureAssetCount).toBe(1);
    // 适用关系：derivedFrom 两侧开放（type_keys 空）；asSource/asTarget 如实
    const rels = Object.fromEntries((info.result.relations as { key: string; asSource: boolean; asTarget: boolean }[]).map((r) => [r.key, r]));
    expect(rels["derivedFrom"]?.asSource).toBe(true);
    // asset.search：type=基类 → 闭包命中 4（与人类目录同一语义，不再精确匹配漏子类）
    const search = await invoke("asset.search", { type: baseKey });
    expectOk(search.status === "ok" && search.result.length === 4, search, "asset.search 类闭包应对齐目录");
    const dep = search.result.find((r: { lifecycle: string }) => r.lifecycle === "deprecated");
    expectOk(dep !== undefined, search.result, "弃用子类资产应可见且如实标注");
    // 未知类型 → 空（Agent 与目录同口径）
    const s2 = await invoke("asset.search", { type: `m71.nonexistent.${runId.slice(0, 4)}` });
    expectOk(s2.status === "ok" && s2.result.length === 0, s2, "未知类型空结果");
  });

  it("④属性键发现：facets.propertyKeys = head 修订观测一级键聚合（含计数、跨类型）", async () => {
    const f = await call("GET", `/assets/facets?teamId=${teamId}`, { session: admin });
    expectOk(f.status === 200 && Array.isArray(f.json.propertyKeys), f.json, "facets 应含 propertyKeys");
    const byKey = Object.fromEntries((f.json.propertyKeys as { key: string; count: number }[]).map((p) => [p.key, p.count]));
    expect(byKey["owner"]).toBe(5); // 五个资产都带 owner（跨 base/child/grand/other 四个类型）
    expect(byKey["accuracy"]).toBe(3); // 子类×2 + 孙类
    expect(byKey["fmiVersion"]).toBe(1);
    expect(byKey["nonexistent"]).toBeUndefined();
  });

  it("⑤M70 漏改修复：/ontology/assets-by-type 默认视图含弃用资产（弃用可见不隐藏、排后）", async () => {
    // 图投影先手动同步（管理员动作）：类型刚注册，worker 周期同步尚未覆盖——
    // 否则图引擎闭包只见自身（engine=graph 如实返回滞后投影，不虚报子类）
    const sync = await call("POST", "/graph/sync", { session: admin, body: { teamId } });
    expectOk(sync.status === 200, sync.json, "图投影同步失败");
    // 基类闭包（本端点自身走 resolveTypeClosure）默认 active 视图应命中 4 项（含弃用）
    const r = await call("GET", `/ontology/assets-by-type?teamId=${teamId}&typeKey=${baseKey}`, { session: admin });
    expectOk(r.status === 200 && r.json.assets.length === 4, r.json, "闭包检索默认视图应含弃用资产（M70 口径对齐）");
    // 弃用排最后（与 Agent 工具同序）
    const last = r.json.assets[r.json.assets.length - 1];
    expectOk(last.lifecycle === "deprecated" && last.name === `M71子类资产二-${N}`, last, "弃用资产应排最后");
    // @taw/graph SQL 回落闭包：子版本同样须 active——直接用 seed 连接走 SQL 递归 CTE 校验层级
    const closure = await seedInTeam(teamId, async (c) => {
      const { rows } = await c.query(
        `WITH RECURSIVE tree AS (
           SELECT id, type_key FROM asset_type_versions WHERE team_id = $1 AND type_key = $2 AND status = 'active'
           UNION
           SELECT ch.id, ch.type_key FROM asset_type_versions ch
             JOIN tree t ON ch.team_id = $1 AND ch.parent_type_version_id = t.id
            WHERE ch.team_id = $1 AND ch.status = 'active'
         ) SELECT DISTINCT type_key FROM tree ORDER BY 1`,
        [teamId, baseKey]
      );
      return rows.map((x: { type_key: string }) => x.type_key);
    });
    expect(closure.sort()).toEqual([baseKey, childKey, grandKey].sort());
  });
});
