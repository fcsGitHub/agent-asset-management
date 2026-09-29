// M60 集成测试 — Schema 便捷生成：
// ①fieldsToSchema（表单属性行 → JSON Schema）：required/枚举/min-max/array items、
//   键非法/重复、类型不匹配约束如实忽略并列 problems。
// ②inferSchemaFromSamples（样例推断，quicktype/jsonschema.net 惯例）：单样例全必填、
//   多样例 unanimity（全部出现才必填）、嵌套展开与深度上限、数组元素、类型冲突回落
//   宽松并注明、null 跳过、全非对象如实报。
// ③端点 POST /types/infer-schema：与纯函数同源、零副作用、越权 404。
// ④端到端闭环：推断生成的 schema 注册成类型后，符合样例的资产可登记、
//   不符合的被 M59 关卡拦下——「生成只降门槛，不降校验强度」。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  fieldsToSchema,
  inferSchemaFromSamples,
  type SchemaFieldDraft,
} from "@taw/domain/schema-builder";

const PORT = 4160;
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

describe("M60 Schema 便捷生成", () => {
  let app: FastifyInstance;
  let admin: Session, outsider: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m60admin-${runId}@t.dev`, password: "password-123", displayName: "M60管理员", teamName: `M60团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m60out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `M60外团-${runId}` }),
    });
    outsider = sessionOf(o);
  });
  afterAll(async () => { await app.close(); });

  // ---------------- 纯函数：表单构建 ----------------

  it("fieldsToSchema：完整属性行生成 schema（枚举/min-max/items/required/title）", () => {
    const fields: SchemaFieldDraft[] = [
      { key: "frame", title: "坐标系", type: "string", required: true, enumValues: "ECI, ECEF，LVLH" },
      { key: "level", type: "integer", required: true, minimum: 0, maximum: 10 },
      { key: "ratio", type: "number", required: false, minimum: 0 },
      { key: "tags", type: "array", required: false, items: "string" },
      { key: "active", type: "boolean", required: false },
    ];
    const built = fieldsToSchema(fields);
    expect(built.problems).toEqual([]);
    const s = built.jsonSchema as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(s.required).toEqual(["frame", "level"]);
    expect(s.properties.frame).toEqual({ type: "string", title: "坐标系", enum: ["ECI", "ECEF", "LVLH"] }); // 中英文逗号都接受
    expect(s.properties.level).toEqual({ type: "integer", minimum: 0, maximum: 10 });
    expect(s.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect(s.properties.active).toEqual({ type: "boolean" });
  });

  it("fieldsToSchema：键非法/重复/空行如实报 problems；类型不匹配的约束忽略", () => {
    const built = fieldsToSchema([
      { key: "1bad", type: "string", required: false },
      { key: "dup", type: "string", required: false },
      { key: "dup", type: "string", required: false },
      { key: "", type: "string", required: false },
      { key: "n", type: "number", required: false, enumValues: "a,b" },
      { key: "s", type: "string", required: false, minimum: 1 },
      { key: "ok", type: "string", required: true },
    ]);
    const problems = built.problems.join("\n");
    expect(problems).toContain("1bad");
    expect(problems).toContain("dup");
    expect(problems).toContain("枚举仅支持 string");
    expect(problems).toContain("min/max 仅支持数值型");
    const s = built.jsonSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(s.properties).sort()).toEqual(["dup", "n", "ok", "s"].sort()); // 非法/空键不入
    expect(s.required).toEqual(["ok"]);
    expect(s.properties.n).toEqual({ type: "number" }); // 枚举被忽略
  });

  // ---------------- 纯函数：样例推断 ----------------

  it("inferSchemaFromSamples：单样例全必填；类型/嵌套/数组如实推断", () => {
    const { jsonSchema, notes } = inferSchemaFromSamples([
      { frame: "ECI", count: 3, ratio: 0.5, on: true, validStepSeconds: { min: 0.1, max: 60 }, tags: ["a", "b"] },
    ]);
    const s = jsonSchema as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(s.required.sort()).toEqual(["count", "frame", "on", "ratio", "tags", "validStepSeconds"].sort());
    expect(s.properties.frame).toEqual({ type: "string" });
    expect(s.properties.count).toEqual({ type: "integer" });
    expect(s.properties.ratio).toEqual({ type: "number" });
    expect(s.properties.on).toEqual({ type: "boolean" });
    expect(s.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    const nested = s.properties.validStepSeconds as { type: string; properties: Record<string, unknown>; required: string[] };
    expect(nested.type).toBe("object");
    expect(nested.required.sort()).toEqual(["max", "min"]);
    expect(notes.some((n) => n.includes("复核"))).toBe(true); // 机械推断的边界如实告知
  });

  it("inferSchemaFromSamples：多样例 unanimity（全部出现才必填）+ 类型冲突回落宽松", () => {
    const { jsonSchema, notes } = inferSchemaFromSamples([
      { frame: "ECI", count: 1, memo: "x" },
      { frame: "ECEF", count: 2 }, // memo 缺席 → 不必填
    ]);
    const s = jsonSchema as { properties: Record<string, unknown>; required: string[] };
    expect(s.required).toEqual(["frame", "count"]);
    expect(s.properties.memo).toEqual({ type: "string" });
    expect(notes.some((n) => n.includes("memo") && n.includes("1/2"))).toBe(true);

    const conflict = inferSchemaFromSamples([{ v: "text" }, { v: 42 }]);
    const cs = conflict.jsonSchema as { properties: Record<string, unknown> };
    expect(cs.properties.v).toEqual({}); // 类型冲突 → 宽松不约束
    expect(conflict.notes.some((n) => n.includes("类型不一致"))).toBe(true);
  });

  it("inferSchemaFromSamples：null 字段跳过；数组元素混杂不约束 items；深度上限如实注明；全非对象报空", () => {
    const withNull = inferSchemaFromSamples([{ a: "x", b: null }]);
    expect((withNull.jsonSchema as { properties: Record<string, unknown> }).properties.a).toEqual({ type: "string" });
    expect("b" in (withNull.jsonSchema as { properties: Record<string, unknown> }).properties).toBe(false);
    expect(withNull.notes.some((n) => n.includes("b") && n.includes("null"))).toBe(true);

    const mixedArr = inferSchemaFromSamples([{ xs: [1, "a"] }]);
    expect((mixedArr.jsonSchema as { properties: Record<string, unknown> }).properties.xs).toEqual({ type: "array" });
    expect(mixedArr.notes.some((n) => n.includes("元素类型混杂"))).toBe(true);

    const deep = inferSchemaFromSamples([{ l1: { l2: { l3: { x: 1 } } } }]);
    expect(deep.notes.some((n) => n.includes("深度上限"))).toBe(true);

    const none = inferSchemaFromSamples(["不是对象", 42]);
    expect((none.jsonSchema as { properties: Record<string, unknown> }).properties).toEqual({});
    expect(none.notes.some((n) => n.includes("没有任何对象"))).toBe(true);
  });

  // ---------------- 端点与端到端 ----------------

  it("端点 /types/infer-schema：同源判定 + 非对象忽略 + 越权 404 + 空样例 422", async () => {
    const res = await call("POST", "/types/infer-schema", {
      session: admin,
      body: { teamId, samples: [{ frame: "ECI", step: 0.5 }, { frame: "ECEF" }] },
    });
    expectOk(res.status === 200, res.json, "推断端点失败");
    const s = res.json.jsonSchema as { properties: Record<string, unknown>; required: string[] };
    expect(s.required).toEqual(["frame"]);
    expect(s.properties.step).toEqual({ type: "number" });
    expect((res.json.notes as string[]).some((n) => n.includes("step"))).toBe(true);

    const mixed = await call("POST", "/types/infer-schema", {
      session: admin, body: { teamId, samples: [{ a: 1 }, "非对象"] },
    });
    expect(mixed.status).toBe(200);
    expect((mixed.json.notes as string[]).some((n) => n.includes("非对象样例"))).toBe(true);

    const forged = await call("POST", "/types/infer-schema", {
      session: outsider, body: { teamId, samples: [{ a: 1 }] },
    });
    expect(forged.status).toBe(404);

    const empty = await call("POST", "/types/infer-schema", { session: admin, body: { teamId, samples: [] } });
    expect(empty.status).toBe(422);
  });

  it("端到端闭环：推断生成的 schema 注册成类型，符合样例可登记、不符合被 M59 关卡拦下", async () => {
    // 从样例推断（模拟 UI「样例推断」全流程）
    const inferred = await call("POST", "/types/infer-schema", {
      session: admin,
      body: { teamId, samples: [{ frame: "ECI", validStepSeconds: { min: 0.1, max: 60 }, tags: ["a"] }] },
    });
    expectOk(inferred.status === 200, inferred.json, "推断失败");
    // 注册成类型（走 POST /types 全部质量门）
    const typeKey = `m60.gen.${runId.slice(0, 4)}`;
    const reg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M60生成类型", jsonSchema: inferred.json.jsonSchema },
    });
    expectOk(reg.status === 201, reg.json, "生成 schema 注册类型失败");
    // 符合样例的资产登记成功
    const okAsset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M60生成资产", typeVersionId: reg.json.typeVersionId, properties: { frame: "ITRF", validStepSeconds: { min: 1, max: 2 }, tags: ["z"] } },
    });
    expectOk(okAsset.status === 201, okAsset.json, "符合样例的资产应可登记");
    // 违反推断产物（类型错）被 M59 关卡拦下
    const badAsset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M60违规资产", typeVersionId: reg.json.typeVersionId, properties: { frame: 123 } },
    });
    expectOk(badAsset.status === 422, badAsset.json, "违反生成 schema 的资产应被拦");
    expect((badAsset.json.error.details as string[]).join("\n")).toContain("frame");
  });
});
