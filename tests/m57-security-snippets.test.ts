// M57 集成测试 — 越权修补与使用片段：
// ①跨租户越权回归（RLS 不校验调用者归属的漏洞类）：外人伪造 teamId 读他团队
//   会话消息、注入消息、建 Issue、推 Issue 状态、评论——全部应 404（M57 修复）。
// ②使用片段端点：按类型家族生成（simulation→YAML 配置、software→依赖声明、
//   document→Markdown 引用）、别名短引用、Agent 引用格式与 M54 同源。
// ③@taw/domain buildSnippets 纯函数：对象属性展开、无属性家族回落、digest 截断。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildSnippets } from "@taw/domain/snippets";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4157;
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
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

describe("M57 越权修补与使用片段", () => {
  let app: FastifyInstance;
  let admin: Session, outsider: Session;
  let teamId = "", projectId = "", sessionId = "", issueId = "";
  let modelId = "", docId = "", softId = "";
  const tv: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m57admin-${runId}@t.dev`, password: "password-123", displayName: "越权管理员", teamName: `越权团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m57out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `外团-${runId}` }),
    });
    outsider = sessionOf(o);
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "越权验证", code: `m57-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M57", visibility: "project" } });
    sessionId = sess.json.sessionId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const t of types) tv[t.type_key] = t.id;
    const mk = async (name: string, typeVersionId: string, extra: Record<string, unknown> = {}) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties: extra } });
      expectOk(r.status === 201, r.json, `${name} 登记失败`);
      return r.json.assetId as string;
    };
    modelId = await mk("M57传播模型", tv["simulation.model"], {
      frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v57",
      validStepSeconds: { min: 0.1, max: 60 },
    });
    docId = await mk("M57接口说明", tv.document, {
      docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m57",
    });
    softId = await mk("M57处理软件", tv.software, {
      language: "python", entry: "main.py", interfaceVersion: "if-v57", runtime: "python3.12", license: "MIT",
    });
    const issue = await call("POST", "/issues", { session: admin, body: { teamId, projectId, title: "M57 越权靶", body: "x" } });
    issueId = issue.json.issueId;
  });
  afterAll(async () => { await app.close(); });

  it("跨租户越权（修复回归）：外人伪造 teamId 读消息 → 404", async () => {
    // 项目可见会话：修复前外人可读全部消息（RLS 只隔离行，不校验调用者）
    const res = await call("GET", `/sessions/${sessionId}/messages?teamId=${teamId}`, { session: outsider });
    expect(res.status).toBe(404);
  });

  it("跨租户越权（修复回归）：外人注入会话消息 → 404", async () => {
    const res = await call("POST", `/sessions/${sessionId}/messages`, {
      session: outsider,
      body: { teamId, role: "user", content: "越权注入" },
    });
    expect(res.status).toBe(404);
    // 确认未写入
    const msgs = (await call("GET", `/sessions/${sessionId}/messages?teamId=${teamId}`, { session: admin })).json as { content: string }[];
    expect(msgs.some((m) => m.content === "越权注入")).toBe(false);
  });

  it("跨租户越权（修复回归）：外人建 Issue / 推状态 / 评论 → 404", async () => {
    const create = await call("POST", "/issues", { session: outsider, body: { teamId, projectId, title: "越权工单", body: "x" } });
    expect(create.status).toBe(404);
    const status = await call("POST", `/issues/${issueId}/status`, { session: outsider, body: { teamId, status: "closed" } });
    expect(status.status).toBe(404);
    const comment = await call("POST", `/issues/${issueId}/comments`, { session: outsider, body: { teamId, content: "越权评论" } });
    expect(comment.status).toBe(404);
    // 成员路径不受影响（回归）
    const okStatus = await call("POST", `/issues/${issueId}/status`, { session: admin, body: { teamId, status: "in_progress" } });
    expect(okStatus.status).toBe(200);
    const okComment = await call("POST", `/issues/${issueId}/comments`, { session: admin, body: { teamId, content: "成员评论" } });
    expect(okComment.status).toBe(201);
  });

  it("使用片段：simulation 家族生成 YAML 配置 + Agent/JSON/别名片段", async () => {
    const alias = await call("POST", `/assets/${modelId}/aliases`, { session: admin, body: { teamId, alias: `m57-${runId}` } });
    expectOk(alias.status === 201, alias.json, "别名创建失败");
    const res = await call("GET", `/assets/${modelId}/snippets?teamId=${teamId}`, { session: admin });
    expectOk(res.status === 200, res.json, "片段端点失败");
    const kinds = (res.json.snippets as { kind: string; text: string }[]).map((s) => s.kind);
    expect(kinds).toContain("agent-ref");
    expect(kinds).toContain("json");
    expect(kinds).toContain("short-ref");
    expect(kinds).toContain("config");
    const byKind = Object.fromEntries((res.json.snippets as { kind: string; text: string; label: string }[]).map((s) => [s.kind, s]));
    // Agent 引用与 M54 复制引用同格式
    expect(byKind["agent-ref"].text).toContain(`资产「M57传播模型」(id: ${modelId}, 类型 simulation.model v`);
    // YAML 配置含 head 标量属性与对象属性展开
    expect(byKind["config"].text).toContain("frame: ECI");
    expect(byKind["config"].text).toContain("validStepSeconds.min: 0.1");
    expect(byKind["config"].text).toContain(`assets:m57-${runId}`);
    // 跨团队 404
    const leak = await call("GET", `/assets/${modelId}/snippets?teamId=${teamId}`, { session: outsider });
    expect(leak.status).toBe(404);
  });

  it("使用片段：software → 依赖声明；document → Markdown 引用", async () => {
    const soft = await call("GET", `/assets/${softId}/snippets?teamId=${teamId}`, { session: admin });
    const softKinds = (soft.json.snippets as { kind: string }[]).map((s) => s.kind);
    expect(softKinds).toContain("dependency");
    expect(softKinds).not.toContain("config");
    const doc = await call("GET", `/assets/${docId}/snippets?teamId=${teamId}`, { session: admin });
    const docKinds = (doc.json.snippets as { kind: string }[]).map((s) => s.kind);
    expect(docKinds).toContain("markdown-link");
    expect(docKinds).not.toContain("short-ref"); // 无别名时不出短引用
  });

  it("buildSnippets 纯函数：digest 截断、空属性回落、未知家族只有通用片段", () => {
    const out = buildSnippets({
      id: "0199aaaa-bbbb-cccc-dddd-eeeeffff0000", name: "数据集X", typeKey: "data.dataset",
      typeVersion: "1.0.0", aliases: [], properties: null,
      contentDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    });
    const kinds = out.map((s) => s.kind);
    expect(kinds).toEqual(["agent-ref", "json"]);
    const json = out.find((s) => s.kind === "json")!;
    expect(json.text).toContain('"digest": "0123456789abcdef"'); // 16 位截断
  });
});
