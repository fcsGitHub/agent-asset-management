// M64 集成测试 — schema 表单贯穿草稿编辑 + 门禁提示前移：
// ①chainRequiresTestEvidence：链上任一环声明即 required（与 checkTestGate 语义同源）；
// ②propertiesToFormValues：六类型预填往返、schema 外属性分离 extra、含逗号数组如实注记；
// ③GET /types 暴露 requires_test_evidence（登记表单门禁提示的数据源）；
// ④草稿编辑端到端（模拟 UI 全流程）：head 属性预填 → 改一字段 → formValuesToProperties
//   + extra 合并 → 保存分支修订 201（M59 关卡对全量属性过）；预检先拦枚举外值、服务端
//   M59 兜底 422；**补丁语义契约**——服务端 {...head, ...body} 合并后校验存储，清空的
//   键沿用 head 值（UI 预检按合并视图查，纯函数对裸值仍报缺必填）；JSON 模式等价路径。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  chainRequiresTestEvidence,
  checkFormValues,
  formValuesToProperties,
  propertiesToFormValues,
  schemaToFormSpec,
  type TypeDefLite,
} from "@taw/domain/schema-form";

const PORT = 4165;
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

describe("M64 schema 表单贯穿草稿编辑 + 门禁提示前移", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m64admin-${runId}@t.dev`, password: "password-123", displayName: "M64管理员", teamName: `M64团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M64验证", code: `m64-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;
  });
  afterAll(async () => { await app.close(); });

  it("chainRequiresTestEvidence：链上任一环声明即 required", () => {
    expect(chainRequiresTestEvidence([])).toBe(false);
    expect(chainRequiresTestEvidence([{}, {}])).toBe(false);
    expect(chainRequiresTestEvidence([{ requiresTestEvidence: true }])).toBe(true);
    // 祖先声明、子类未声明 → 仍 required（与 checkTestGate 的链语义同源）
    expect(chainRequiresTestEvidence([{}, { requiresTestEvidence: true }, {}])).toBe(true);
  });

  it("propertiesToFormValues：六类型预填往返 + extra 分离 + 含逗号数组如实注记", () => {
    const chain: TypeDefLite[] = [{
      typeKey: "sim.cfg", version: "1.0.0",
      jsonSchema: {
        type: "object", required: ["frame"],
        properties: {
          frame: { type: "string", enum: ["ECI", "ECEF"] },
          level: { type: "integer", minimum: 0, maximum: 3 },
          ratio: { type: "number" },
          active: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          limits: { type: "object", properties: { min: { type: "number" } } },
        },
      },
      unitVocabularies: {},
    }];
    const spec = schemaToFormSpec(chain);
    const original = {
      frame: "ECI", level: 2, ratio: 0.5, active: true,
      tags: ["a", "b"], limits: { min: 1 },
      customField: "schema 外属性", customNum: 7, // extra
    };
    const { values, extra, notes } = propertiesToFormValues(spec.fields, original);
    expect(values).toEqual({
      frame: "ECI", level: "2", ratio: "0.5", active: "true",
      tags: "a, b", limits: "{\n  \"min\": 1\n}",
    });
    expect(extra).toEqual({ customField: "schema 外属性", customNum: 7 });
    expect(notes).toEqual([]);
    // 往返：formValuesToProperties(propertiesToFormValues(x)) ≡ x（声明字段 + extra 合并）
    const { properties, problems } = formValuesToProperties(spec.fields, values);
    expect(problems).toEqual([]);
    expect({ ...properties, ...extra }).toEqual(original);

    // 含逗号字符串数组：预填注记失真风险（提示走 JSON 模式），JSON 串保真
    const comma = propertiesToFormValues(spec.fields, { tags: ["a,b", "c"] });
    expect(comma.values.tags).toBe("a,b, c");
    expect(comma.notes.join("\n")).toContain("逗号");
  });

  it("GET /types 暴露 requires_test_evidence（门禁提示数据源）", async () => {
    const gated = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m64.gated.${runId.slice(0, 4)}`, version: "1.0.0", title: "M64门禁类型", requiresTestEvidence: true, jsonSchema: { type: "object", properties: { memo: { type: "string" } } } },
    });
    expectOk(gated.status === 201, gated.json, "门禁类型注册失败");
    const list = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    expectOk(list.status === 200, list.json, "类型列表失败");
    const row = (list.json as { type_key: string; requires_test_evidence?: boolean }[]).find((t) => t.type_key === `m64.gated.${runId.slice(0, 4)}`);
    expectOk(!!row, list.json.length, "列表缺门禁类型");
    expect(row!.requires_test_evidence).toBe(true);
    const plain = (list.json as { type_key: string; requires_test_evidence?: boolean }[]).find((t) => t.type_key === "document");
    expect(plain?.requires_test_evidence ?? false).toBe(false); // 默认类型不门禁
  });

  it("草稿编辑端到端：预填→改字段→换算合并→保存 201；预检拦非法值与清空必填；M59 兜底 422", async () => {
    // 类型：frame 枚举必填 + level 整数 + memo 文本（additionalProperties 开放 → extra 可携带）
    const typeKey = `m64.doc.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M64文档", jsonSchema: { type: "object", required: ["frame"], properties: { frame: { type: "string", enum: ["ECI", "ECEF"] }, level: { type: "integer", minimum: 0, maximum: 3 }, memo: { type: "string" } } } },
    });
    expectOk(typeReg.status === 201, typeReg.json, "类型注册失败");
    // 登记资产（属性含 schema 外字段 customNote）
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M64草稿资产", typeVersionId: typeReg.json.typeVersionId, properties: { frame: "ECI", level: 2, memo: "v1", customNote: "schema 外" } },
    });
    expectOk(asset.status === 201, asset.json, "资产登记失败");
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `m64-edits-${runId}` } });
    expectOk(br.status === 201, br.json, "分支创建失败");
    const branchId = br.json.branchId;

    // —— 模拟 UI：GET /types 重建链 → spec → head 属性预填 → 改 level → 换算合并保存
    const list = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const rows = list.json as { id: string; type_key: string; version: string; parent_type_key?: string | null; parent_version?: string | null; json_schema: object; unit_vocabularies: Record<string, string[]> }[];
    const typeRow = rows.find((r) => r.id === typeReg.json.typeVersionId)!;
    const chain: TypeDefLite[] = [];
    let cursor = typeRow;
    while (cursor) {
      chain.push({ typeKey: cursor.type_key, version: cursor.version, jsonSchema: cursor.json_schema, unitVocabularies: cursor.unit_vocabularies ?? {} });
      const pk = cursor.parent_type_key, pv = cursor.parent_version;
      const next: typeof typeRow | undefined = pk && pv ? rows.find((r) => r.type_key === pk && r.version === pv) : undefined;
      cursor = next!;
    }
    const spec = schemaToFormSpec(chain);
    const headProps = { frame: "ECI", level: 2, memo: "v1", customNote: "schema 外" };
    const { values, extra } = propertiesToFormValues(spec.fields, headProps);
    expect(values).toEqual({ frame: "ECI", level: "2", memo: "v1" }); // 预填到位
    expect(extra).toEqual({ customNote: "schema 外" }); // schema 外分离

    // 用户只改 level=3，其余不动 → 合并后保存
    const edited = { ...values, level: "3" };
    const { properties: typed, problems } = formValuesToProperties(spec.fields, edited);
    expect(problems).toEqual([]);
    expect(checkFormValues(spec.fields, typed)).toEqual([]); // 本地预检放行
    const merged = { ...typed, ...extra };
    const saved = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: asset.json.assetId, properties: merged, artifacts: [] },
    });
    expectOk(saved.status === 201, saved.json, "草稿保存失败");
    expect(saved.json.contentDigest).toBeTruthy();

    // 预检先拦：枚举外值（UI 不发请求）；服务端 M59 对直接提交兜底 422
    const badValues = { ...edited, frame: "ITRF" };
    const badTyped = formValuesToProperties(spec.fields, badValues);
    expect(checkFormValues(spec.fields, badTyped.properties).join("\n")).toContain("ITRF");
    const serverBad = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: asset.json.assetId, properties: { ...badTyped.properties, ...extra }, artifacts: [] },
    });
    expectOk(serverBad.status === 422, serverBad.json, "M59 应拦枚举外值");

    // 清空必填 frame：补丁语义——服务端 {...head, ...body} 合并后校验，缺省键沿用
    // head 值，保存 201 且新修订里 frame 仍是 head 的 "ECI"（UI 预检按合并视图查，
    // 不会误报缺必填；纯函数对裸表单值仍如实报缺必填）
    const cleared = { ...edited, frame: "" };
    const clearedTyped = formValuesToProperties(spec.fields, cleared);
    expect(checkFormValues(spec.fields, clearedTyped.properties)).toEqual(['缺少必填属性 "frame"']); // 纯函数口径
    expect(checkFormValues(spec.fields, { ...headProps, ...clearedTyped.properties, ...extra })).toEqual([]); // 合并视图口径（UI 实际用）
    const serverCleared = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: asset.json.assetId, properties: { ...clearedTyped.properties, ...extra }, artifacts: [] },
    });
    expectOk(serverCleared.status === 201, serverCleared.json, "补丁语义：缺省键沿用 head 值应可保存");
    const detail = await call("GET", `/assets/${asset.json.assetId}?teamId=${teamId}`, { session: admin });
    expectOk(detail.status === 200, detail.json, "资产详情失败");
    const headAfter = (detail.json.revisions[0].properties as Record<string, unknown>);
    expect(headAfter.frame).toBe("ECI"); // 沿用 head 值
    expect(headAfter.level).toBe(3);    // 本次修改生效
    expect(headAfter.customNote).toBe("schema 外"); // extra 合并保留

    // JSON 模式等价：直接提交完整 JSON（含 extra）也能保存（双模式同一条服务端关卡）
    const jsonSaved = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: asset.json.assetId, properties: { frame: "ECEF", level: 1, memo: "json-mode", customNote: "schema 外" }, artifacts: [] },
    });
    expectOk(jsonSaved.status === 201, jsonSaved.json, "JSON 模式保存应成功");
  });
});
