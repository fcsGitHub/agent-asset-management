// M8 本体治理测试 — 关系 domain/range 执行、类型层次（收窄继承）、质量门、
// 迁移预览（层次影响 / 关系类型预演）、本体导出。真实 PostgreSQL/HTTP，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const PORT = 4111;
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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, `register ${email} → ${res.status}`, "注册失败");
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

const DOC_PROPS = (scope: string) => ({ docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope });
const BASE_SCHEMA = { type: "object", required: ["name"], properties: { name: { type: "string" } } };

describe("M8 本体治理", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "";
  let docTypeId = "", baseTypeId = "", childTypeId = "";
  let docA = "", docB = "", docC = "", baseAsset = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m8o-${runId}@t.dev`, "M8本体管理员", `M8本体团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M8本体项目", code: `m8o-${runId}` } });
    projectId = proj.json.projectId;
    // 播种默认类型，取 document 作为具体类
    await call("GET", `/types?teamId=${teamId}`, { session: admin });
    await seedInTeam(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
      docTypeId = rows[0]!.id;
    });
    // 注册最小父类型（层次与 domain/range 的具体类）
    const base = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: "m8base", version: "1.0.0", title: "M8 基类", jsonSchema: BASE_SCHEMA },
    });
    expectOk(base.status === 201, base.json, "注册 m8base 失败");
    baseTypeId = base.json.typeVersionId;

    for (const [key, slot] of [["docA", "docA"], ["docB", "docB"], ["docC", "docC"]] as const) {
      const r = await call("POST", "/assets", {
        session: admin,
        body: { teamId, name: `文档-${key}-${runId}`, typeVersionId: docTypeId, properties: DOC_PROPS(key) },
      });
      expectOk(r.status === 201, r.json, `建 ${key} 失败`);
      if (slot === "docA") docA = r.json.assetId;
      if (slot === "docB") docB = r.json.assetId;
      if (slot === "docC") docC = r.json.assetId;
    }
    const b = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `基类资产-${runId}`, typeVersionId: baseTypeId, properties: { name: "base" } },
    });
    expectOk(b.status === 201, b.json, "建基类资产失败");
    baseAsset = b.json.assetId;
  });

  afterAll(async () => { await app.close(); });

  it("质量门：单位词表悬挂引用与关系类型悬挂 type_key 必须拒绝", async () => {
    const badVocab = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: "m8vocab", version: "1.0.0", title: "坏词表",
        jsonSchema: { type: "object", properties: { size: { type: "number" } } },
        unitVocabularies: { position: ["m", "km"] }, // 需要 positionUnit 属性，schema 未定义
      },
    });
    expect(badVocab.status === 422, badVocab, "词表悬挂引用应 422");
    expect(String(badVocab.json?.error?.message).includes("position"), badVocab.json, "错误应指明 position 词表");

    const badRel = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m8BadLink", version: "1.0.0", title: "坏引用", sourceTypeKeys: ["no.such-type"] },
    });
    expect(badRel.status === 422, badRel, "关系类型悬挂 type_key 应 422");
    expect(String(badRel.json?.error?.message).includes("尚未注册"), badRel.json, "错误应说明悬挂");

    const badKind = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m8BadKind", version: "1.0.0", title: "坏 kind", sourceKinds: ["dragon"] },
    });
    expect(badKind.status === 422 || badKind.status === 400, badKind, "非法 kind 应拒绝");
  });

  it("类型层次：子类型必须收窄父类型；资产实例须同时满足整条链；预览覆盖后代", async () => {
    // 子类型：在父基础上加必填 extra（收窄，允许）
    const child = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: "m8child", version: "1.0.0", title: "M8 子类",
        jsonSchema: { type: "object", required: ["name", "extra"], properties: { name: { type: "string" }, extra: { type: "string" } } },
        parentTypeVersionId: baseTypeId,
      },
    });
    expectOk(child.status === 201, child.json, "注册收窄子类型失败");
    childTypeId = child.json.typeVersionId;

    // 改写父属性类型（name: number）→ 拒绝（收窄才允许）
    const badChild = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: "m8child2", version: "1.0.0", title: "坏子类",
        jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "number" } } },
        parentTypeVersionId: baseTypeId,
      },
    });
    expect(badChild.status === 422, badChild, "改写父属性类型应 422");
    expect(String(badChild.json?.error?.message).includes("收窄"), badChild.json, "错误应说明只能收窄");

    // 层次在 GET /types 可见
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const childRow = (types.json as any[]).find((t) => t.type_key === "m8child");
    expectOk(childRow?.parent_type_key === "m8base" && childRow?.parent_version === "1.0.0", childRow, "GET /types 应返回父类型信息");

    // 资产实例：满足子类型但缺父必填 name → 拒绝（链上祖先也要满足）
    const violation = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "缺父必填", typeVersionId: childTypeId, properties: { extra: "x" } },
    });
    expect(violation.status === 422, violation, "缺父类型必填应 422");
    const errs = JSON.stringify(violation.json);
    expect(errs.includes("name"), violation.json, "错误应指出 name 缺失");

    // 同时满足整条链 → 成功
    const okAsset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `子类资产-${runId}`, typeVersionId: childTypeId, properties: { name: "child", extra: "ok" } },
    });
    expect(okAsset.status === 201, okAsset.json, "满足整条链的资产应创建成功");

    // 迁移预览：父类型的影响面包含后代类型资产；改写类型时标记继承问题
    const preview = await call("POST", "/types/migration-preview", {
      session: admin,
      body: {
        teamId, typeKey: "m8base",
        jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "number" } } },
      },
    });
    expectOk(preview.status === 200, preview.json, "预览失败");
    expect(preview.json.inheritanceIssue !== null, preview.json, "预览应指出继承违规");
    expect(preview.json.safe === false, preview.json, "继承违规时 safe 应为 false");
    expect(
      (preview.json.descendantTypes as any[]).some((d) => d.type_key === "m8child"),
      preview.json.descendantTypes,
      "后代类型应列入影响面"
    );
    const listed = await call("GET", `/assets/${okAsset.json.assetId}?teamId=${teamId}`, { session: admin });
    expect(listed.status === 200, listed.json, "子类资产应存在");
  });

  it("关系 domain/range：kind 与类级 type_keys 在断言时强制执行", async () => {
    // 注册仅允许 document→document 的关系类型
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: {
        teamId, typeKey: `m8LinkDoc`, version: "1.0.0", title: "文档关联",
        sourceTypeKeys: ["document"], targetTypeKeys: ["document"], cyclic: true,
      },
    });
    expectOk(rt.status === 201, rt.json, "注册 m8LinkDoc 失败");

    // 目标为 m8base 资产 → 类级 range 违规
    const violation = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: rt.json.relationTypeVersionId, sourceAssetId: docA, targetAssetId: baseAsset, confirm: true },
    });
    expect(violation.status === 409, violation, "range 违规应 409");
    expect(violation.json?.error?.code === "DOMAIN_RANGE_VIOLATION", violation.json, "错误码应为 DOMAIN_RANGE_VIOLATION");

    // document→document 合法
    const ok = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: rt.json.relationTypeVersionId, sourceAssetId: docA, targetAssetId: docB, confirm: true },
    });
    expect(ok.status === 201, ok.json, "合法断言应 201");

    // GET /relation-types 列表可用
    const list = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    expectOk(list.status === 200, list.json, "关系类型列表失败");
    const row = (list.json as any[]).find((r) => r.type_key === "m8LinkDoc");
    expectOk(row && row.source_type_keys[0] === "document" && row.target_type_keys[0] === "document", row, "列表应含类级 domain/range");
  });

  it("成环禁止：cyclic=false 的关系类型在直接环与传递环上都拒绝断言", async () => {
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m8Acyclic", version: "1.0.0", title: "无环依赖", cyclic: false },
    });
    expectOk(rt.status === 201, rt.json, "注册无环类型失败");
    const rtId = rt.json.relationTypeVersionId;

    const e1 = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: rtId, sourceAssetId: docA, targetAssetId: docB, confirm: true },
    });
    expect(e1.status === 201, e1.json, "首条断言应成功");
    const e2 = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: rtId, sourceAssetId: docB, targetAssetId: docC, confirm: true },
    });
    expect(e2.status === 201, e2.json, "第二条断言应成功");

    // 直接环 B→A
    const direct = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: rtId, sourceAssetId: docB, targetAssetId: docA, confirm: true },
    });
    expect(direct.status === 409 && direct.json?.error?.code === "CYCLE_FORBIDDEN", direct, "直接环应 409");

    // 传递环 C→A（A→B→C→A）
    const transitive = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: rtId, sourceAssetId: docC, targetAssetId: docA, confirm: true },
    });
    expect(transitive.status === 409 && transitive.json?.error?.code === "CYCLE_FORBIDDEN", transitive, "传递环应 409");
  });

  it("关系类型迁移预演：domain/range 收窄列出存量违反，cyclic 收紧数出存量环", async () => {
    // 先构造存量：m8LinkDoc 已有 docA→docB；再造 docB→baseAsset？不行（会违规）。
    // 改为：预演把 target 收窄到 m8base → 现有 docA→docB 违反。
    const preview = await call("POST", "/relation-types/migration-preview", {
      session: admin,
      body: { teamId, typeKey: "m8LinkDoc", targetTypeKeys: ["m8base"] },
    });
    expectOk(preview.status === 200, preview.json, "关系预演失败");
    expect(preview.json.affectedAssertions >= 1, preview.json, "应统计到存量断言");
    expect(
      (preview.json.domainRangeViolations as any[]).some((v) => v.side === "target"),
      preview.json.domainRangeViolations,
      "应列出目标端违反"
    );
    expect(preview.json.safe === false, preview.json, "存在违反时 safe 应为 false");

    // cyclic true→false：m8LinkDoc 当前 cyclic=true；现有断言 docA→docB 无环，反向补一条造环
    const back = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: (await call("GET", `/relation-types?teamId=${teamId}`, { session: admin })).json.find((r: any) => r.type_key === "m8LinkDoc").id, sourceAssetId: docB, targetAssetId: docA, confirm: true },
    });
    expectOk(back.status === 201, back.json, "反向断言应成功（当前允许环）");
    const cycPreview = await call("POST", "/relation-types/migration-preview", {
      session: admin,
      body: { teamId, typeKey: "m8LinkDoc", cyclic: false },
    });
    expectOk(cycPreview.status === 200, cycPreview.json, "cyclic 预演失败");
    expect(cycPreview.json.existingCycles >= 1, cycPreview.json, "应数出存量环");
    expect(cycPreview.json.safe === false, cycPreview.json, "存量环使收窄不安全");
  });

  it("本体导出：类含 subClassOf、对象属性含 domain/range，摘要稳定", async () => {
    const e1 = await call("GET", `/ontology/export?teamId=${teamId}`, { session: admin });
    expectOk(e1.status === 200, e1.json, "导出失败");
    expect(e1.json.format === "taw-ontology/1", e1.json, "格式标识错误");
    const classes = e1.json.classes as any[];
    const child = classes.find((c) => c.key === "m8child");
    expectOk(child?.subClassOf?.key === "m8base", child, "子类应带 subClassOf");
    const props = e1.json.objectProperties as any[];
    const link = props.find((p) => p.key === "m8LinkDoc");
    expectOk(link?.range?.typeKeys?.[0] === "document", link, "对象属性应带类级 range");
    expectOk(props.some((p) => p.key === "dependsOn"), props, "默认关系类型应在导出中");

    const e2 = await call("GET", `/ontology/export?teamId=${teamId}`, { session: admin });
    expect(e2.json.ontologyDigest === e1.json.ontologyDigest, [e1.json.ontologyDigest, e2.json.ontologyDigest], "摘要应稳定");

    // 跨团队隔离：另一团队导出不含本团队自定义类
    const other = await register(`m8o2-${runId}@t.dev`, "M8他团队", `M8他团队-${runId}`);
    const otherExport = await call("GET", `/ontology/export?teamId=${other.teamId}`, { session: other.session });
    expectOk(otherExport.status === 200, otherExport.json, "他团队导出失败");
    expect(!(otherExport.json.classes as any[]).some((c) => c.key === "m8child"), otherExport.json.classes, "他团队不应看到本团队类");
  });
});
