// M61 集成测试 — 自然语言生成 schema 草稿：
// ①白名单（SchemaDraft，zod strict）：合法草稿通过；未知字段/坏类型/超数量拒绝——
//   LLM 输出只能以 SchemaFieldDraft 形状进系统，草稿再经 fieldsToSchema 键约束复核。
// ②端点 POST /types/describe-schema：真实 DeepSeek 生成草稿（结构断言宽松——模型
//   输出有随机性，只验证形状与可编译性）；无 key 如实 503（stubEnv replace-me 哨兵，
//   M31 教训：加载器不覆盖已存在变量）；越权 404；描述过短 422。
// ③草稿不落库：端点零写入（types 列表前后不变——登记仍需人工走 POST /types）。
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { buildServer } from "@taw/api/server";
import { SchemaDraft } from "@taw/api/routes/catalog";
import { compileTypeSchema } from "@taw/domain/validate";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4162;
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

const hasKey = Boolean(process.env.DEEPSEEK_API_KEY && process.env.DEEPSEEK_API_KEY !== "replace-me");

describe("M61 自然语言生成 schema 草稿", () => {
  let app: FastifyInstance;
  let admin: Session, outsider: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m61admin-${runId}@t.dev`, password: "password-123", displayName: "M61管理员", teamName: `M61团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m61out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `M61外团-${runId}` }),
    });
    outsider = sessionOf(o);
  });
  afterAll(async () => { await app.close(); });

  it("白名单：合法草稿通过；未知字段/坏类型/超数量拒绝（LLM 输出的唯一入口）", () => {
    const ok = SchemaDraft.safeParse({
      typeKey: "sim.telemetry",
      title: "遥测类型",
      fields: [
        { key: "frame", type: "string", required: true, enumValues: "ECI, ECEF" },
        { key: "score", type: "integer", required: false, minimum: 0, maximum: 10 },
        { key: "tags", type: "array", required: false, items: "string" },
      ],
    });
    expect(ok.success).toBe(true);

    expect(SchemaDraft.safeParse({ fields: [{ key: "a", type: "string", required: true, evil: "越权字段" }] }).success).toBe(false); // strict 拒未知字段
    expect(SchemaDraft.safeParse({ fields: [{ key: "a", type: "datetime", required: true }] }).success).toBe(false); // 类型白名单
    expect(SchemaDraft.safeParse({ fields: [] }).success).toBe(false); // 至少一行
    expect(SchemaDraft.safeParse({ fields: Array.from({ length: 25 }, (_, i) => ({ key: `f${i}`, type: "string", required: false })) }).success).toBe(false); // 上限 24
    expect(SchemaDraft.safeParse({ fields: [{ key: "a", type: "string", required: "yes" }] }).success).toBe(false); // required 必须 boolean
  });

  it("真实 DeepSeek 草稿：结构正确、schema 可编译、草稿零写入", { timeout: 60000, retry: 1 }, async () => {
    if (!hasKey) return; // 无 key 环境跳过真实调用（降级路径由下一用例覆盖）
    const before = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const res = await call("POST", "/types/describe-schema", {
      session: admin,
      body: {
        teamId,
        description: "仿真报告类型：坐标系是枚举 ECI/ECEF/LVLH 必填；报告编号必填字符串；评审评分是 0 到 10 的整数",
      },
    });
    expectOk(res.status === 200, res.json, "describe-schema 失败");
    expect(res.json.fields.length).toBeGreaterThanOrEqual(2);
    expect(res.json.fields.length).toBeLessThanOrEqual(24);
    expect(typeof res.json.tokens).toBe("number");
    // 产物可编译（可注册）且必填集合非空
    expect(compileTypeSchema(res.json.jsonSchema)).toBe(true);
    const required = (res.json.jsonSchema as { required?: string[] }).required ?? [];
    expect(required.length).toBeGreaterThanOrEqual(1);
    // 描述里明确的枚举被识别为 string 枚举（键名允许模型自定，只验证形状）
    const props = (res.json.jsonSchema as { properties: Record<string, Record<string, unknown>> }).properties;
    const enumField = Object.values(props).find((p) => Array.isArray(p.enum));
    expect(enumField).toBeDefined();
    // 草稿零写入：类型列表不变（登记必须人工走 POST /types）
    const after = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    expect((after.json as unknown[]).length).toBe((before.json as unknown[]).length);
  });

  it("无 key 如实 503：不伪造草稿（replace-me 哨兵，M31 口径）", { timeout: 20000 }, async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "replace-me");
    try {
      const res = await call("POST", "/types/describe-schema", {
        session: admin,
        body: { teamId, description: "任何描述都不会走模型" },
      });
      expectOk(res.status === 503 && res.json.error.code === "DEPENDENCY_UNAVAILABLE", res.json, "应 503 降级");
      expect((res.json.error.message as string)).toContain("未配置");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("越权 404；描述过短 422", async () => {
    const forged = await call("POST", "/types/describe-schema", {
      session: outsider, body: { teamId, description: "随便描述一个类型" },
    });
    expect(forged.status).toBe(404);
    const short = await call("POST", "/types/describe-schema", {
      session: admin, body: { teamId, description: "太短" },
    });
    expect(short.status).toBe(422);
  });
});
