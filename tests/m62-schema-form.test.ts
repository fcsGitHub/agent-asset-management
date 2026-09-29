// M62 集成测试 — Schema 驱动的登记表单：
// ①schemaToFormSpec：单类型 schema → 字段规格（顺序/必填/枚举/范围/长度/格式/部件选择）；
// ②链合并（与 validateAgainstChain 语义对齐）：祖先独有字段并入表单并标 inheritedFrom、
//   required 取并集、约束取最派生一环、additionalProperties:false → closed；
// ③单位词表并入：<name>Unit 字段变受控下拉；schema enum 优先；派生侧词表优先；
// ④formValuesToProperties：布尔/整数/数值/按元素类型的列表换算、JSON 坏值收集 problems 不抛；
// ⑤checkFormValues 本地预检：必填/枚举/范围/长度/格式/元素类型命中与放行；
// ⑥端到端：两级类型链 → 客户端式链重建 + spec → 表单值换算 → /assets/validate 全链通过、
//   漏继承字段被本地预检与服务端双重拦截、真实登记成功。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import {
  schemaToFormSpec,
  formValuesToProperties,
  checkFormValues,
  type TypeDefLite,
  type FormFieldSpec,
} from "@taw/domain/schema-form";

const PORT = 4163;
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

function fieldOf(fields: FormFieldSpec[], key: string): FormFieldSpec {
  const f = fields.find((x) => x.key === key);
  if (!f) throw new Error(`字段 ${key} 不在规格中：${fields.map((x) => x.key).join(",")}`);
  return f;
}

describe("M62 Schema 驱动登记表单", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m62admin-${runId}@t.dev`, password: "password-123", displayName: "M62管理员", teamName: `M62团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
  });
  afterAll(async () => { await app.close(); });

  // ---------------- 纯函数：schema → 字段规格 ----------------

  it("schemaToFormSpec：单类型字段规格（顺序/必填/部件/约束齐备）", () => {
    const spec = schemaToFormSpec([{
      typeKey: "sim.config", version: "1.0.0",
      jsonSchema: {
        type: "object",
        required: ["frame"],
        properties: {
          frame: { type: "string", enum: ["ECI", "ECEF"] },
          level: { type: "integer", minimum: 0, maximum: 10 },
          ratio: { type: "number", minimum: 0 },
          active: { type: "boolean" },
          code: { type: "string", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 },
          tags: { type: "array", items: { type: "string" } },
          scores: { type: "array", items: { type: "integer" } },
          limits: { type: "object", properties: { min: { type: "number" } } },
        },
      },
      unitVocabularies: {},
    }]);
    expect(spec.fields.map((f) => f.key)).toEqual(["frame", "level", "ratio", "active", "code", "tags", "scores", "limits"]); // schema 顺序即表单顺序
    expect(fieldOf(spec.fields, "frame")).toMatchObject({ input: "enum", required: true, enumValues: ["ECI", "ECEF"] });
    expect(fieldOf(spec.fields, "level")).toMatchObject({ input: "integer", minimum: 0, maximum: 10 });
    expect(fieldOf(spec.fields, "ratio")).toMatchObject({ input: "number", minimum: 0, required: false });
    expect(fieldOf(spec.fields, "active")).toMatchObject({ input: "boolean" });
    expect(fieldOf(spec.fields, "code")).toMatchObject({ pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 });
    expect(fieldOf(spec.fields, "tags")).toMatchObject({ input: "list", items: "string" });
    expect(fieldOf(spec.fields, "scores")).toMatchObject({ input: "list", items: "integer" });
    expect(fieldOf(spec.fields, "limits")).toMatchObject({ input: "json", type: "object" });
    expect(spec.closed).toBe(false);
  });

  it("schemaToFormSpec：类型链合并——祖先字段并入、required 并集、约束取交集、closed 标注", () => {
    const parent: TypeDefLite = {
      typeKey: "asset.base", version: "2.0.0",
      jsonSchema: {
        type: "object", additionalProperties: false,
        required: ["owner", "frame"],
        properties: {
          owner: { type: "string", title: "负责人" },
          frame: { type: "string", enum: ["ECI", "ECEF", "LVLH"] },
          memo: { type: "string" },
          ratio: { type: "number", minimum: 0, maximum: 100 },
          axis: { type: "string", enum: ["X", "Y"] },
        },
      },
      unitVocabularies: {},
    };
    const child: TypeDefLite = {
      typeKey: "sim.orbit", version: "1.1.0",
      jsonSchema: {
        type: "object",
        required: ["level"],
        properties: {
          frame: { type: "string", enum: ["ECI", "ECEF"] }, // 收窄
          level: { type: "integer", minimum: 0, maximum: 3 },
          owner: { type: "string" }, // 与父同型（不 required——required 由并集决定）
          ratio: { type: "number", maximum: 50 }, // 漏写 min：祖先 min=0 仍生效 → 交集
          axis: { type: "string", enum: ["Z"] }, // 与父枚举无交集 → 治理债提示
        },
      },
      unitVocabularies: {},
    };
    const spec = schemaToFormSpec([child, parent]); // 派生在前，与 loadTypeChain 同序
    const owner = fieldOf(spec.fields, "owner");
    expect(owner.required).toBe(true); // 父 required → 并集必填
    expect(owner.inheritedFrom).toBeUndefined(); // 子也声明了 → 非纯继承字段
    expect(owner.title).toBe("负责人"); // 派生侧未给 title → 从祖先回填
    const frame = fieldOf(spec.fields, "frame");
    expect(frame.enumValues).toEqual(["ECI", "ECEF"]); // 枚举交集（按派生侧顺序）
    const ratio = fieldOf(spec.fields, "ratio");
    expect(ratio).toMatchObject({ minimum: 0, maximum: 50 }); // 祖先 min 与子 max 的交集——漏写不会放松祖先限制
    expect(fieldOf(spec.fields, "axis").enumValues).toEqual([]); // 无交集
    expect(spec.notes.join("\n")).toContain("枚举无交集");
    expect(fieldOf(spec.fields, "memo").inheritedFrom).toBe("asset.base v2.0.0"); // 仅祖先声明 → 标注继承来源
    expect(fieldOf(spec.fields, "memo").required).toBe(false);
    expect(fieldOf(spec.fields, "level").required).toBe(true);
    expect(spec.closed).toBe(true); // 父 additionalProperties:false
    expect(spec.notes.join("\n")).toContain("关闭未声明属性");
    expect(spec.notes.join("\n")).toContain("仅由祖先类型声明");
  });

  it("schemaToFormSpec：单位词表并入 <name>Unit 下拉；schema enum 优先；派生侧词表优先", () => {
    const child: TypeDefLite = {
      typeKey: "sim.step", version: "1.0.0",
      jsonSchema: {
        type: "object",
        properties: {
          timeUnit: { type: "string" },
          presetUnit: { type: "string", enum: ["A"] }, // 已有 enum：不被词表覆盖
        },
      },
      unitVocabularies: { time: ["ms", "s"], preset: ["B", "C"] },
    };
    const parent: TypeDefLite = {
      typeKey: "sim.root", version: "1.0.0",
      jsonSchema: { type: "object", properties: { depth: { type: "string" } } },
      unitVocabularies: { time: ["minutes"], depth: ["km", "m"] },
    };
    const spec = schemaToFormSpec([child, parent]);
    const timeUnit = fieldOf(spec.fields, "timeUnit");
    expect(timeUnit.enumValues).toEqual(["ms", "s"]); // 派生侧词表优先于祖先
    expect(timeUnit.vocabulary).toBe("time");
    expect(timeUnit.input).toBe("enum");
    expect(fieldOf(spec.fields, "presetUnit").enumValues).toEqual(["A"]); // schema enum 优先
    // 深度单位挂在本体字段上（dangling 检查允许 <name> 或 <name>Unit）
    const depth = spec.fields.find((f) => f.key === "depth");
    expect(depth?.enumValues).toEqual(["km", "m"]); // 祖先词表并入祖先声明的本体字段
  });

  // ---------------- 纯函数：换算与预检 ----------------

  it("formValuesToProperties：布尔/整数/数值/列表元素/JSON 换算；坏值收集 problems 不抛", () => {
    const fields: FormFieldSpec[] = [
      { key: "active", type: "boolean", input: "boolean", required: false },
      { key: "level", type: "integer", input: "integer", required: false },
      { key: "ratio", type: "number", input: "number", required: false },
      { key: "scores", type: "array", input: "list", required: false, items: "integer" },
      { key: "limits", type: "object", input: "json", required: false },
      { key: "bad", type: "object", input: "json", required: false },
    ];
    const { properties, problems } = formValuesToProperties(fields, {
      active: "true", level: "3", ratio: "0.5", scores: "1, 2，3",
      limits: '{"min": 1}', bad: "{not-json", empty: "应被忽略（不在字段表）",
    });
    expect(properties).toEqual({ active: true, level: 3, ratio: 0.5, scores: [1, 2, 3], limits: { min: 1 } });
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain("bad");
    expect(problems[0]).toContain("JSON");

    const badNum = formValuesToProperties(fields, { level: "3.5", ratio: "abc" });
    expect(badNum.problems.join("\n")).toContain("整数");
    expect(badNum.problems.join("\n")).toContain("数字");
    expect("level" in badNum.properties).toBe(false);
  });

  it("checkFormValues：必填/枚举/范围/长度/格式/元素类型命中与放行", () => {
    const fields: FormFieldSpec[] = [
      { key: "owner", type: "string", input: "text", required: true },
      { key: "frame", type: "string", input: "enum", required: false, enumValues: ["ECI", "ECEF"], vocabulary: "frame" },
      { key: "level", type: "integer", input: "integer", required: false, minimum: 0, maximum: 10 },
      { key: "code", type: "string", input: "text", required: false, pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 },
      { key: "scores", type: "array", input: "list", required: false, items: "integer" },
    ];
    expect(checkFormValues(fields, {})).toEqual(["缺少必填属性 \"owner\""]);
    expect(checkFormValues(fields, { owner: "a" })).toEqual([]); // 只填必填即通过（其余可选）

    const errs = checkFormValues(fields, {
      owner: "a", frame: "ITRF", level: 11, code: "abc", scores: [1, "x"],
    });
    const joined = errs.join("\n");
    expect(joined).toContain("ITRF");
    expect(joined).toContain("词表 frame");
    expect(joined).toContain("上限 10");
    expect(joined).toContain("格式");
    expect(joined).toContain("元素应为 integer");
    expect(errs.length).toBe(5);

    // 数值型范围与类型；合法值放行
    expect(checkFormValues(fields, { owner: "a", level: 10, code: "AB", scores: [1, 2] })).toEqual([]);
    expect(checkFormValues(fields, { owner: "a", level: "3" })[0]).toContain("整数");
  });

  // ---------------- 端到端：链重建 + spec + 换算 + 服务端关卡 ----------------

  it("端到端：两级类型链表单并集字段 → dry-run 全链通过、漏继承字段双重拦截、登记成功", async () => {
    // 父类型：owner 必填（子类型不重复声明——表单并集是唯一入口）
    const parentReg = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `m62.base.${runId.slice(0, 4)}`, version: "1.0.0", title: "M62基类",
        jsonSchema: { type: "object", required: ["owner"], properties: { owner: { type: "string", title: "负责人" }, frame: { type: "string", enum: ["ECI", "ECEF", "LVLH"] } } },
      },
    });
    expectOk(parentReg.status === 201, parentReg.json, "父类型注册失败");

    // 子类型：枚举收窄 + 新增必填 level + 词表字段 timeUnit
    const childReg = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `m62.child.${runId.slice(0, 4)}`, version: "1.0.0", title: "M62子类",
        parentTypeVersionId: parentReg.json.typeVersionId,
        jsonSchema: { type: "object", required: ["level"], properties: { frame: { type: "string", enum: ["ECI", "ECEF"] }, level: { type: "integer", minimum: 0, maximum: 3 }, timeUnit: { type: "string" } } },
        unitVocabularies: { time: ["s", "ms"] },
      },
    });
    expectOk(childReg.status === 201, childReg.json, "子类型注册失败");

    // GET /types → 客户端式链重建（与 Workbench 同逻辑）
    const list = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    expectOk(list.status === 200, list.json, "类型列表失败");
    const rows = list.json as { id: string; type_key: string; version: string; parent_type_key?: string | null; parent_version?: string | null; json_schema: object; unit_vocabularies: Record<string, string[]> }[];
    const childRow = rows.find((r) => r.id === childReg.json.typeVersionId)!;
    const chain: TypeDefLite[] = [];
    let cursor = childRow;
    while (cursor) {
      chain.push({ typeKey: cursor.type_key, version: cursor.version, jsonSchema: cursor.json_schema, unitVocabularies: cursor.unit_vocabularies ?? {} });
      const pk = cursor.parent_type_key, pv = cursor.parent_version;
      const next: typeof childRow | undefined = pk && pv ? rows.find((r) => r.type_key === pk && r.version === pv) : undefined;
      cursor = next!;
    }
    expect(chain.map((c) => c.typeKey)).toHaveLength(2); // 子 → 父

    const spec = schemaToFormSpec(chain);
    expect(fieldOf(spec.fields, "owner").inheritedFrom).toContain("m62.base"); // 祖先必填字段并入表单
    expect(fieldOf(spec.fields, "owner").required).toBe(true);
    expect(fieldOf(spec.fields, "frame").enumValues).toEqual(["ECI", "ECEF"]); // 收窄后的枚举
    expect(fieldOf(spec.fields, "timeUnit").enumValues).toEqual(["s", "ms"]); // 词表下拉

    // 表单值换算 → dry-run 全链通过
    const filled = formValuesToProperties(spec.fields, { owner: "alice", frame: "ECI", level: "2", timeUnit: "s" });
    expect(filled.problems).toEqual([]);
    const dry = await call("POST", "/assets/validate", {
      session: admin,
      body: { teamId, typeVersionId: childReg.json.typeVersionId, properties: filled.properties },
    });
    expectOk(dry.status === 200, dry.json, "dry-run 失败");
    expect(dry.json.valid).toBe(true);

    // 漏掉继承字段 owner：本地预检先拦（省掉必然失败的往返）
    const missing = formValuesToProperties(spec.fields, { frame: "ECI", level: "2" });
    expect(checkFormValues(spec.fields, missing.properties)).toEqual(["缺少必填属性 \"owner\""]);
    // 服务端关卡（权威）同样拦下，错误带 [parent vX] 前缀
    const dryBad = await call("POST", "/assets/validate", {
      session: admin,
      body: { teamId, typeVersionId: childReg.json.typeVersionId, properties: missing.properties },
    });
    expectOk(dryBad.status === 200, dryBad.json, "dry-run(Bad) 失败");
    expect(dryBad.json.valid).toBe(false);
    expect((dryBad.json.errors as string[]).join("\n")).toContain("owner");
    expect((dryBad.json.errors as string[]).join("\n")).toContain(`m62.base.${runId.slice(0, 4)}`);

    // 真实登记成功（M59 关卡过）；词表外值被拦
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M62表单资产", typeVersionId: childReg.json.typeVersionId, properties: filled.properties },
    });
    expectOk(asset.status === 201, asset.json, "表单换算属性应可登记");
    const vocabBad = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M62词表违规", typeVersionId: childReg.json.typeVersionId, properties: { owner: "a", level: 1, timeUnit: "minutes" } },
    });
    expectOk(vocabBad.status === 422, vocabBad.json, "词表外值应被服务端拦下");
    // 本地预检也应提前发现（枚举来自词表）
    expect(checkFormValues(spec.fields, { owner: "a", level: 1, timeUnit: "minutes" }).join("\n")).toContain("词表 time");
  });
});
