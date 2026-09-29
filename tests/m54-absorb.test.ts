// M54 集成测试 — 调研吸收第二轮：
// ①NL L1「X 的关联资产」句式 → 图谱聚焦（老化候选落地，搜索前缀让位）
// ②/assets/search 关联数排序（Amundsen 被引信号：relation_count + sort=refs）
// ③/relations 携带端点 lifecycle（Atlas 血缘传播读侧：上游归档 → 详情页警示数据源）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { ruleParse } from "../apps/api/src/routes/nl";

const PORT = 4137;
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

describe("M54 NL L1「X 的关联资产」句式", () => {
  it("命中 → navigate graph + assetName", () => {
    for (const text of [
      "轨道传播模型的关联资产",
      "查看接口规范文档的相关资产",
      "找遥测处理软件的多跳资产",
      "「回归测试集」的邻域资产",
    ]) {
      const r = ruleParse(text);
      expect(r, text).not.toBeNull();
      expect(r!.intent).toBe("navigate");
      expect(r!.params.page).toBe("graph");
      expect(r!.params.assetName).toBeTruthy();
    }
    expect(ruleParse("轨道传播模型的关联资产")!.params.assetName).toBe("轨道传播模型");
    expect(ruleParse("查看接口规范文档的相关资产")!.params.assetName).toBe("接口规范文档");
  });

  it("搜索/查找前缀让位搜索意图；无名或纯动词不命中；既有句式无回归", () => {
    const search = ruleParse("搜索轨道传播模型的关联资产");
    expect(search?.intent).toBe("search_assets");
    expect(ruleParse("查找轨道的关联资产")?.intent).toBe("search_assets");
    expect(ruleParse("关联资产")).toBeNull();
    expect(ruleParse("查看的关联资产")).toBeNull();
    // 既有句式回归：图谱聚焦 / 打开图谱 / 搜索
    const focus = ruleParse("聚焦轨道传播模型的图谱");
    expect(focus?.params).toMatchObject({ page: "graph", assetName: "轨道传播模型" });
    expect(ruleParse("打开图谱")?.params).toMatchObject({ page: "graph" });
    expect(ruleParse("搜索轨道传播模型")?.intent).toBe("search_assets");
  });
});

describe("M54 检索排序与血缘健康数据源", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "";
  let docId = "", modelId = "", thirdId = "";
  const typeVersionIds: Record<string, string> = {};
  const relationTypeIds: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m54admin-${runId}@t.dev`, password: "password-123", displayName: "吸收管理员", teamName: `吸收团队-${runId}` }),
    });
    admin = sessionOf(reg);
    teamId = ((await reg.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "吸收验证", code: `m54-${runId}` } });
    expect(proj.status).toBe(201);
    projectId = proj.json.projectId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const t of types) typeVersionIds[t.type_key] = t.id;
    const relTypes = (await call("GET", `/relation-types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const r of relTypes) relationTypeIds[r.type_key] = r.id;
  });
  afterAll(async () => { await app.close(); });

  async function register(name: string, typeKey: string, properties: object): Promise<string> {
    const res = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name, typeVersionId: typeVersionIds[typeKey], properties },
    });
    expect(res.status, `${name}: ${JSON.stringify(res.json)}`).toBe(201);
    return res.json.assetId as string;
  }

  it("登记四个资产并连两条关系（模型被文档说明、被测试集验证）", async () => {
    docId = await register("M54接口说明", "document", { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m54" });
    modelId = await register("M54传播模型", "simulation.model", { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v2", validStepSeconds: { min: 0.1, max: 60 } });
    thirdId = await register("M54孤立文档", "document", { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m54" });
    const testId = await register("M54回归测试集", "test.suite", { testTarget: "prop-v2", execProtocol: "pytest-v1", fixtureVersion: "fx-3", passThreshold: 0.95 });
    const r1 = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: relationTypeIds.documentedBy, sourceAssetId: modelId, targetAssetId: docId, confirm: true },
    });
    const r2 = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: relationTypeIds.verifies, sourceAssetId: testId, targetAssetId: modelId, confirm: true },
    });
    expect(r1.status, `documentedBy: ${JSON.stringify(r1.json)}`).toBe(201);
    expect(r2.status, `verifies: ${JSON.stringify(r2.json)}`).toBe(201);
  });

  it("search 关联数：sort=refs 模型置顶（relation_count 如实）", async () => {
    const res = await call("GET", `/assets/search?teamId=${teamId}&sort=refs`, { session: admin });
    expect(res.status).toBe(200);
    const rows = res.json as { id: string; relation_count: number }[];
    expect(rows[0]!.id).toBe(modelId);
    expect(rows[0]!.relation_count).toBeGreaterThanOrEqual(2);
    const counts = rows.map((r) => r.relation_count);
    const sorted = [...counts].sort((a, b) => b - a);
    expect(counts).toEqual(sorted);
  });

  it("默认排序仍为最新登记（回归）", async () => {
    const res = await call("GET", `/assets/search?teamId=${teamId}`, { session: admin });
    const rows = res.json as { id: string }[];
    expect(rows[0]!.id).not.toBe(modelId); // 最新登记的是孤立文档
    expect(rows[rows.length - 1]!.id).toBe(docId);
  });

  it("归档上游文档后 /relations 带端点 lifecycle（读侧警示数据源）", async () => {
    const arch = await call("POST", `/assets/${docId}/archive`, { session: admin, body: { teamId, reason: "M54 测试归档上游文档" } });
    expect(arch.status).toBe(200);
    const rels = await call("GET", `/relations?teamId=${teamId}&assetId=${modelId}`, { session: admin });
    expect(rels.status).toBe(200);
    const outgoing = rels.json.outgoing as { target_asset_id: string; target_lifecycle: string; source_lifecycle: string }[];
    const incoming = rels.json.incoming as { source_asset_id: string; source_lifecycle: string }[];
    // documentedBy：模型 → 文档（出边）：文档归档后 target_lifecycle 如实带出
    const toDoc = outgoing.find((r) => r.target_asset_id === docId);
    expect(toDoc).toBeTruthy();
    expect(toDoc!.target_lifecycle).toBe("archived");
    // verifies：测试集 → 模型（入边）：上游（测试集）仍为进行中
    expect(incoming.length).toBeGreaterThanOrEqual(1);
    expect(incoming.every((r) => r.source_lifecycle === "active")).toBe(true);
  });
});
