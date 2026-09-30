// M65 集成测试 — 资产元数据完整度 scorecard 与引导（Backstage TechInsights 思想）：
// ①纯函数：全过 100；逐项失败（detail 点名/hint 可执行）；owner 惯例键集合；
//   required 缺失点名；权重算术（单项失败扣对应分）。
// ②API 端到端：裸资产（仅必填字段）低分且检查明细如实；补 owner 属性、关系、
//   别名、标签后分数上升（引导闭环）；completeness 与类型链 required 并集一致
//   （两级链：父类 required 也计入）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { computeCompleteness, OWNER_KEYS } from "@taw/domain/completeness";

const PORT = 4166;
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
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
}

const FULL = {
  requiredFields: ["frame", "owner"],
  properties: { frame: "ECI", owner: "alice" },
  artifactsCount: 1, relationsCount: 2, aliasesCount: 1, labelsCount: 1, categoriesCount: 0,
};

describe("M65 完整度 scorecard", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m65admin-${runId}@t.dev`, password: "password-123", displayName: "M65管理员", teamName: `M65团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
  });
  afterAll(async () => { await app.close(); });

  it("纯函数：全过 100；逐项失败扣对应分且 hint 可执行", () => {
    const full = computeCompleteness(FULL);
    expect(full.score).toBe(100);
    expect(full.checks.every((c) => c.passed)).toBe(true);

    // 每次只破坏一项，分数恰减该项权重（权重算术自证）
    const cases: { mut: typeof FULL; key: string; weight: number; detailIncludes: string[] }[] = [
      { mut: { ...FULL, requiredFields: ["frame", "memo"], properties: { frame: "ECI", memo: "", owner: "alice" } }, key: "schema_required", weight: 25, detailIncludes: ["memo"] },
      { mut: { ...FULL, properties: { frame: "ECI" }, requiredFields: ["frame"] }, key: "owner", weight: 20, detailIncludes: ["负责人"] },
      { mut: { ...FULL, relationsCount: 0 }, key: "relations", weight: 20, detailIncludes: ["孤岛"] },
      { mut: { ...FULL, artifactsCount: 0 }, key: "artifacts", weight: 15, detailIncludes: ["没有制品"] },
      { mut: { ...FULL, aliasesCount: 0 }, key: "aliases", weight: 10, detailIncludes: ["别名"] },
      { mut: { ...FULL, labelsCount: 0, categoriesCount: 0 }, key: "tags", weight: 10, detailIncludes: ["标签"] },
    ];
    for (const c of cases) {
      const r = computeCompleteness(c.mut);
      expect(r.score).toBe(100 - c.weight);
      const failed = r.checks.find((x) => x.key === c.key)!;
      expect(failed.passed).toBe(false);
      expect(failed.hint.length).toBeGreaterThan(5); // 失败必须给可执行下一步（TechInsights 口径）
      for (const frag of c.detailIncludes) expect(failed.detail).toContain(frag);
    }
  });

  it("纯函数：owner 惯例键集合；required 缺失逐个点名", () => {
    for (const key of ["ownerName", "maintainer", "responsible", "author", "creator"]) {
      const r = computeCompleteness({ ...FULL, properties: { frame: "ECI", [key]: "zhang" }, requiredFields: ["frame"] });
      expect(r.checks.find((c) => c.key === "owner")!.passed).toBe(true);
    }
    expect(OWNER_KEYS).toContain("owner");
    const r = computeCompleteness({ ...FULL, requiredFields: ["frame", "owner", "memo"], properties: { memo: "x" } });
    const failed = r.checks.find((c) => c.key === "schema_required")!;
    expect(failed.detail).toContain("frame");
    expect(failed.detail).toContain("owner");
    expect(failed.detail).not.toContain("memo"); // 空串视为缺失，memo 有值不点名
  });

  it("API 端到端：裸资产低分 → 补 owner/关系/别名/标签分数上升（引导闭环）；两级链 required 并集一致", async () => {
    // 父类型 required: ownerKey（用惯例键 owner，让 required 与 owner 检查同源）
    const parent = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m65.base.${runId.slice(0, 4)}`, version: "1.0.0", title: "M65基类", jsonSchema: { type: "object", required: ["owner"], properties: { owner: { type: "string", title: "负责人" } } } },
    });
    expectOk(parent.status === 201, parent.json, "父类型注册失败");
    // 子类型 required: frame（收窄）——链上 required 并集 = [frame, owner]
    const child = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m65.child.${runId.slice(0, 4)}`, version: "1.0.0", title: "M65子类", parentTypeVersionId: parent.json.typeVersionId, jsonSchema: { type: "object", required: ["frame"], properties: { frame: { type: "string", enum: ["ECI", "ECEF"] } } } },
    });
    expectOk(child.status === 201, child.json, "子类型注册失败");

    // 裸资产：满足必填（owner+frame）+ 登记时带一个标签，但无关系/制品/别名 → 25+20+10 = 55
    // （标签/分类只在登记时设置，无独立端点——如实按登记口径构造）
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M65裸资产", typeVersionId: child.json.typeVersionId, properties: { owner: "alice", frame: "ECI" }, labels: ["核心"] },
    });
    expectOk(asset.status === 201, asset.json, "资产登记失败");
    const detail1 = await call("GET", `/assets/${asset.json.assetId}?teamId=${teamId}`, { session: admin });
    expectOk(detail1.status === 200, detail1.json, "详情失败");
    const comp1 = detail1.json.completeness as { score: number; checks: { key: string; passed: boolean; detail: string }[] };
    expect(comp1.score).toBe(55);
    const byKey = Object.fromEntries(comp1.checks.map((c) => [c.key, c]));
    expect(byKey.schema_required.passed).toBe(true); // 链并集 required=[frame,owner] 齐备
    expect(byKey.schema_required.detail).toContain("2 项"); // 两级链并集
    expect(byKey.owner.passed).toBe(true);
    expect(byKey.tags.passed).toBe(true);
    expect(byKey.relations.passed).toBe(false);
    expect(byKey.relations.detail).toContain("孤岛");
    expect(byKey.artifacts.passed).toBe(false);
    expect(byKey.aliases.passed).toBe(false);

    // 引导闭环：建关系（+20）+ 加别名（+10）→ 85
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const dependsOn = (relTypes.json as { id: string; type_key: string }[]).find((r) => r.type_key === "dependsOn")!;
    const other = await call("POST", "/assets", {
      session: admin, body: { teamId, name: "M65同伴资产", typeVersionId: child.json.typeVersionId, properties: { owner: "bob", frame: "ECEF" } },
    });
    const rel = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: dependsOn.id, sourceAssetId: asset.json.assetId, targetAssetId: other.json.assetId, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "关系创建失败");
    const alias = await call("POST", `/assets/${asset.json.assetId}/aliases`, {
      session: admin, body: { teamId, alias: "m65-bare" },
    });
    expectOk(alias.status === 201, alias.json, "别名创建失败");
    const detail2 = await call("GET", `/assets/${asset.json.assetId}?teamId=${teamId}`, { session: admin });
    const comp2 = detail2.json.completeness as { score: number; checks: { key: string; passed: boolean }[] };
    expect(comp2.score).toBe(85);
    const byKey2 = Object.fromEntries(comp2.checks.map((c) => [c.key, c]));
    expect(byKey2.relations.passed).toBe(true);
    expect(byKey2.aliases.passed).toBe(true);
    expect(byKey2.tags.passed).toBe(true);
    expect(byKey2.artifacts.passed).toBe(false); // 制品仍缺（hint 引导上传）
  });
});
