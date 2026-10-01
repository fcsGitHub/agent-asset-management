// M67 候选清偿轮集成测试（七项一次交付）：
// ①派生血缘字段（HF base_model）：属性引用 → derivedFrom 断言物化（名称/别名精确命中、
//   已有如实 already、未命中如实 unresolved、无血缘字段 422、详情附 lineageRefs）。
// ②属性自定义筛选器（OpenMetadata）：prop=key=value 过滤 head 属性；非法格式 422 点名。
// ③标签沿血缘传播写侧（Atlas+治理确认）：预览 planDigest → 确认执行；摘要不符 409；
//   二级下游覆盖到、已覆盖不再出现、传播后标签真实落库。
// ④别名进 ⌘K：search 附 matched_alias（搜别名能解释为何命中）。
// ⑤集合只读分享快照（Zenodo 快照语义）：冻结内容 + 免登录 token 查看；集合后续增删不影响
//   快照；坏 token 404；外团队成员不能创建；公开响应不含 teamId。
// ⑦完整度汇总：水位（count/平均/三档分桶）+ 低分清单（升序、带未过项）。
// ⑥Agent 对话区可折叠为纯 UI，浏览器实测覆盖（无 API 面）。
// 纯函数（lineage/prop-filter/completeness-summary）单测一并在此文件。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { extractLineageRefs, planLabelPropagation } from "@taw/domain/lineage";
import { parsePropFilters, formatPropFilters } from "@taw/domain/prop-filter";
import { summarizeCompleteness } from "@taw/domain/completeness-summary";

const PORT = 4168;
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 600)}`);
}

describe("M67 纯函数：lineage / prop-filter / completeness-summary", () => {
  it("extractLineageRefs：字符串/数组/去重/非字符串跳过/多字段", () => {
    const refs = extractLineageRefs({
      base_model: ["net-a", "net-b", "net-a", " "],
      baseModel: "Net-C",
      note: 42,
      other: "x",
    });
    expect(refs).toEqual([
      { field: "base_model", refs: ["net-a", "net-b"] },
      { field: "baseModel", refs: ["Net-C"] },
    ]);
    expect(extractLineageRefs({})).toEqual([]);
  });

  it("planLabelPropagation：BFS 多级 + 环安全 + 已覆盖不产生条目 + 源无标签注记", () => {
    // parent → child → grandchild，外加一条回到 parent 的环边（visited 挡住）
    const edges = [
      { from: "p", to: "c" },
      { from: "c", to: "g" },
      { from: "g", to: "p" },
    ];
    const plan = planLabelPropagation({ sourceId: "p", edges, labelsByAsset: { p: ["core"], c: ["core", "extra"], g: [] } });
    expect(plan.targets).toEqual([{ assetId: "g", labelsToAdd: ["core"] }]); // c 已覆盖 → 不产生条目
    expect(plan.notes.some((n) => n.includes("1 个下游资产已具备全部源标签"))).toBe(true);
    const empty = planLabelPropagation({ sourceId: "p", edges, labelsByAsset: { p: [] } });
    expect(empty.targets).toEqual([]);
    expect(empty.notes[0]).toContain("没有任何标签");
    const noDown = planLabelPropagation({ sourceId: "x", edges: [], labelsByAsset: { x: ["a"] } });
    expect(noDown.notes[0]).toContain("没有下游资产");
  });

  it("parsePropFilters：合法/分隔符非法/空值/同键覆盖/formatPropFilters 往返", () => {
    const { filters, problems } = parsePropFilters(["owner=alice", "stage:prod", "owner=bob", "bad", "k="]);
    // M68② 起筛选项带算符（op），等值语义与 M67 完全一致
    expect(filters).toEqual([{ key: "owner", op: "=", value: "bob" }, { key: "stage", op: "=", value: "prod" }]);
    expect(problems).toHaveLength(2);
    expect(formatPropFilters(filters)).toBe("owner=bob stage=prod");
    expect(parsePropFilters(undefined).filters).toEqual([]);
    expect(parsePropFilters(["  "]).filters).toEqual([]);
  });

  it("summarizeCompleteness：分桶/平均/低分升序截断", () => {
    const s = summarizeCompleteness([
      { id: "1", name: "a", score: 90, missingTitles: [] },
      { id: "2", name: "b", score: 60, missingTitles: ["关联"] },
      { id: "3", name: "c", score: 30, missingTitles: ["必填属性", "负责人"] },
      { id: "4", name: "d", score: 10, missingTitles: ["必填属性"] },
    ]);
    expect(s.count).toBe(4);
    expect(s.average).toBe(48);
    expect(s.buckets).toEqual({ green: 1, yellow: 1, red: 2 });
    expect(s.low.map((e) => e.id)).toEqual(["4", "3"]); // 升序：10 < 30（60 不算低）
    expect(s.low[0]!.missingTitles).toEqual(["必填属性"]);
    const maxLow = summarizeCompleteness(
      Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `n${i}`, score: i % 50, missingTitles: [] })),
      { maxLow: 5 }
    );
    expect(maxLow.low).toHaveLength(5);
    expect(summarizeCompleteness([])).toMatchObject({ count: 0, average: 0 });
  });
});

describe("M67 候选清偿（血缘物化/属性筛选/标签传播/别名命中/分享快照/完整度汇总）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let outsider: Session;
  let teamId = "";
  let typeVersionId = "";
  let parentId = "", childId = "", grandId = "", aliasAssetId = "", bareId = "", unresId = "";
  let derivedFromId = "";
  let collectionId = "";
  const PARENT_NAME = `m67-basenet-${runId}`;
  const CHILD_NAME = `m67-childnet-${runId}`;
  const GRAND_NAME = `m67-grandnet-${runId}`;
  const ALIAS_NAME = `m67-alias-asset-${runId}`;
  const ALIAS = `m67ali${runId.slice(0, 6)}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m67admin-${runId}@t.dev`, password: "password-123", displayName: "M67管理员", teamName: `M67团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m67other-${runId}@t.dev`, password: "password-123", displayName: "M67外人", teamName: `M67外团队-${runId}` }),
    });
    outsider = sessionOf(o);
    const typeKey = `m67.model.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M67模型", jsonSchema: { type: "object", properties: { base_model: { type: "string" }, owner: { type: "string" }, note: { type: "string" } } } },
    });
    typeVersionId = typeReg.json.typeVersionId;
    const mk = async (name: string, properties: Record<string, unknown>, labels: string[] = []) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties, labels } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
      return r.json.assetId as string;
    };
    parentId = await mk(PARENT_NAME, { owner: "m67-owner-a", note: "parent" }, ["m67lab"]);
    childId = await mk(CHILD_NAME, { owner: "m67-owner-b", note: "child", base_model: PARENT_NAME.toUpperCase() });
    grandId = await mk(GRAND_NAME, { owner: "m67-owner-c", note: "grand", base_model: CHILD_NAME });
    aliasAssetId = await mk(ALIAS_NAME, { owner: "m67-owner-a", note: "alias" });
    bareId = await mk(`m67-bare-${runId}`, { note: "bare" });
    unresId = await mk(`m67-unres-${runId}`, { note: "x", base_model: "no-such-asset-m67-xyz" });
    const alias = await call("POST", `/assets/${aliasAssetId}/aliases`, { session: admin, body: { teamId, alias: ALIAS } });
    expectOk(alias.status === 201, alias.json, "别名创建失败");
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    derivedFromId = ((relTypes.json as { id: string; type_key: string }[]).find((r) => r.type_key === "derivedFrom") ?? {}).id ?? "";
    expectOk(!!derivedFromId, relTypes.json, "默认 derivedFrom 关系类型缺失");
    const col = await call("POST", "/collections", { session: admin, body: { teamId, name: `M67分享包-${runId}`, description: "M67 snapshot test" } });
    expectOk(col.status === 201, col.json, "集合创建失败");
    collectionId = col.json.collectionId;
    for (const aid of [parentId, childId]) {
      const it = await call("POST", `/collections/${collectionId}/items`, { session: admin, body: { teamId, assetId: aid, note: "" } });
      expectOk(it.status === 201, it.json, "集合条目加入失败");
    }
  });
  afterAll(async () => { await app.close(); });

  it("①血缘物化：大小写不敏感名称命中建边；重复如实 already；未命中如实 unresolved；无字段 422；详情附 lineageRefs", async () => {
    const m1 = await call("POST", `/assets/${childId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m1.status === 200 && m1.json.created === 1, m1.json, "child 物化失败");
    expectOk(m1.json.results[0].status === "linked" && m1.json.results[0].targetName === PARENT_NAME, m1.json.results, "命中目标不符");
    const m2 = await call("POST", `/assets/${childId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m2.status === 200 && m2.json.created === 0 && m2.json.results[0].status === "already", m2.json, "重复物化应 already");
    const m3 = await call("POST", `/assets/${grandId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m3.status === 200 && m3.json.created === 1, m3.json, "grand 物化失败");
    const m4 = await call("POST", `/assets/${unresId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m4.status === 200 && m4.json.results[0].status === "unresolved", m4.json, "未命中应 unresolved");
    const m5 = await call("POST", `/assets/${aliasAssetId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m5.status === 422, m5.json, "无血缘字段应 422");
    // 详情附 lineageRefs；child 的关联数已含物化边
    const detail = await call("GET", `/assets/${childId}?teamId=${teamId}`, { session: admin });
    expectOk((detail.json.lineageRefs ?? []).some((g: { field: string }) => g.field === "base_model"), detail.json.lineageRefs, "详情缺 lineageRefs");
    const rows = await call("GET", `/assets/search?teamId=${teamId}&q=${encodeURIComponent(CHILD_NAME)}`, { session: admin });
    const childRow = (rows.json as { id: string; relation_count: number }[]).find((r) => r.id === childId);
    expectOk((childRow?.relation_count ?? 0) >= 1, rows.json, "物化后 child 关联数应 ≥1");
  });

  it("①血缘物化（别名命中）：base_model 用别名引用也能建边", async () => {
    const a = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `m67-byalias-${runId}`, typeVersionId, properties: { note: "by alias", base_model: ALIAS } },
    });
    expectOk(a.status === 201, a.json, "byalias 登记失败");
    const m = await call("POST", `/assets/${a.json.assetId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m.status === 200 && m.json.created === 1 && m.json.results[0].status === "linked", m.json, "别名命中物化失败");
  });

  it("②属性筛选：prop=owner=… 精确过滤；多项空格语义=多参数；非法格式 422 点名", async () => {
    const rows = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("owner=m67-owner-a")}`, { session: admin });
    expectOk(rows.status === 200, rows.json, "prop 筛选失败");
    const names = (rows.json as { name: string }[]).map((r) => r.name);
    expectOk(names.includes(PARENT_NAME) && names.includes(ALIAS_NAME), names, "owner-a 资产应命中");
    expectOk(!names.includes(CHILD_NAME) && !names.includes(GRAND_NAME), names, "owner-b/c 资产应被排除");
    const both = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("owner=m67-owner-a")}&prop=${encodeURIComponent("note=child")}`, { session: admin });
    expectOk(both.status === 200 && (both.json as unknown[]).length === 0, both.json, "两个 prop 应取交集（owner-a 且 note=child → 无命中）");
    const bad = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("badformat")}`, { session: admin });
    expectOk(bad.status === 422 && JSON.stringify(bad.json).includes("badformat"), bad.json, "非法格式应 422 且点名");
  });

  it("③标签沿血缘传播：预览含两级下游；错摘要 409；执行后标签落库；二次预览无待传播", async () => {
    const p1 = await call("GET", `/assets/${parentId}/propagate-labels?teamId=${teamId}`, { session: admin });
    expectOk(p1.status === 200, p1.json, "预览失败");
    const targets = p1.json.targets as { assetId: string; name: string; labelsToAdd: string[] }[];
    expectOk(targets.length === 2, targets, "应有 child+grand 两个下游");
    expectOk(targets.every((t) => t.labelsToAdd.join(",") === "m67lab"), targets, "每个下游应新增 m67lab");
    // 错摘要 → 409（TOCTOU 口径）
    const wrong = await call("POST", `/assets/${parentId}/propagate-labels`, { session: admin, body: { teamId, confirmPlanDigest: "deadbeefdeadbeef" } });
    expectOk(wrong.status === 409 && wrong.json.error.code === "PROPAGATION_PLAN_CHANGED", wrong.json, "错摘要应 409");
    const apply = await call("POST", `/assets/${parentId}/propagate-labels`, { session: admin, body: { teamId, confirmPlanDigest: p1.json.planDigest } });
    expectOk(apply.status === 200 && apply.json.appliedAssets === 2 && apply.json.appliedLabels === 2, apply.json, "执行结果不符");
    for (const aid of [childId, grandId]) {
      const d = await call("GET", `/assets/${aid}?teamId=${teamId}`, { session: admin });
      expectOk((d.json.labels as string[]).includes("m67lab"), d.json.labels, "下游标签未落库");
    }
    const p2 = await call("GET", `/assets/${parentId}/propagate-labels?teamId=${teamId}`, { session: admin });
    expectOk((p2.json.targets as unknown[]).length === 0, p2.json, "已传播后不应再有 targets");
    expectOk((p2.json.notes as string[]).some((n) => n.includes("已具备全部源标签")), p2.json.notes, "应注记已覆盖");
  });

  it("④别名命中：search 搜别名返回 matched_alias", async () => {
    const rows = await call("GET", `/assets/search?teamId=${teamId}&q=${ALIAS}`, { session: admin });
    const hit = (rows.json as { id: string; matched_alias?: string }[]).find((r) => r.id === aliasAssetId);
    expectOk(!!hit, rows.json, "按别名搜索应命中资产");
    expectOk(hit!.matched_alias === ALIAS, hit, "matched_alias 应等于命中别名");
  });

  it("⑤集合分享快照：冻结 + 免登录 + 增删不影响 + 坏 token 404 + 外团队不可建 + 不泄漏 teamId", async () => {
    const snap = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId } });
    expectOk(snap.status === 201 && /^[0-9a-f]{32}$/.test(snap.json.token) && snap.json.itemCount === 2, snap.json, "快照创建失败");
    const token = snap.json.token as string;
    // 免登录（不带会话）读取
    const pub = await call("GET", `/share/collections/${token}`);
    expectOk(pub.status === 200, pub.json, "公开读取失败");
    expectOk(pub.json.collectionName === `M67分享包-${runId}` && (pub.json.payload.items as unknown[]).length === 2, pub.json, "快照内容不符");
    expectOk(!("teamId" in pub.json) && !("team_id" in pub.json.payload), pub.json, "公开响应不应含团队标识");
    // 集合移除一项后再读——快照仍 2 项（冻结）
    const rm = await call("DELETE", `/collections/${collectionId}/items/${childId}?teamId=${teamId}`, { session: admin });
    expectOk(rm.status === 200, rm.json, "移除集合条目失败");
    const pub2 = await call("GET", `/share/collections/${token}`);
    expectOk((pub2.json.payload.items as unknown[]).length === 2, pub2.json.payload, "快照应保持冻结");
    // 团队内快照清单
    const list = await call("GET", `/collections/${collectionId}/snapshots?teamId=${teamId}`, { session: admin });
    expectOk(list.status === 200 && (list.json as unknown[]).length === 1 && list.json[0].shareUrl.includes(token), list.json, "快照清单不符");
    // 坏 token
    const badTok = await call("GET", `/share/collections/${"0".repeat(32)}`);
    expectOk(badTok.status === 404, badTok.json, "坏 token 应 404");
    // 外团队成员不能创建快照（teamRole 对别的团队 404）
    const ext = await call("POST", `/collections/${collectionId}/snapshots`, { session: outsider, body: { teamId } });
    expectOk(ext.status === 404, ext.json, "外团队应 404");
  });

  it("⑦完整度汇总：水位分桶合计=总数；低分清单升序且含未过项", async () => {
    const s = await call("GET", `/assets/completeness-summary?teamId=${teamId}`, { session: admin });
    expectOk(s.status === 200, s.json, "汇总失败");
    const b = s.json.buckets as { green: number; yellow: number; red: number };
    expectOk(b.green + b.yellow + b.red === s.json.count, s.json, "分桶合计应等于总数");
    expectOk(s.json.count >= 6 && s.json.sampled === s.json.count, s.json, "样本数不符");
    const low = s.json.low as { name: string; score: number; missingTitles: string[] }[];
    const scores = low.map((e) => e.score);
    expectOk(scores.every((v, i) => i === 0 || scores[i - 1]! <= v), scores, "低分清单应升序");
    const bare = low.find((e) => e.name === `m67-bare-${runId}`);
    expectOk(!!bare && bare.score < 60 && bare.missingTitles.length >= 3, bare, "裸资产应进低分清单且带未过项");
    expectOk(typeof s.json.average === "number" && s.json.average >= 0 && s.json.average <= 100, s.json.average, "平均分应 0-100");
  });
});
