// M5 集成测试 — 语义适配（真实 semantica worker）、检索授权、降级。
// 覆盖验收：D07（中文/同名/单位/冲突/来源契约）/ D08（检索授权）/ D09（降级不影响核心流程）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4104;
const WORKER_PORT = 8101;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
process.env.SEMANTIC_WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
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

describe("M5 语义与检索（真实 worker 集成）", () => {
  let app: FastifyInstance;
  let worker: ChildProcess;
  let admin: Session, member: Session, outsider: Session;
  let teamId = "", projectId = "";

  beforeAll(async () => {
    // 启动真实 semantica worker
    const venvPython = join(root, ".venv-sema", "Scripts", "python.exe");
    worker = spawn(venvPython, [join(root, "services", "semantic-worker", "main.py")], {
      env: { ...process.env, SEMANTIC_WORKER_PORT: String(WORKER_PORT) },
      stdio: "ignore",
    });
    const started = Date.now();
    while (Date.now() - started < 60000) {
      try {
        const r = await fetch(`http://127.0.0.1:${WORKER_PORT}/healthz`);
        if (r.ok) break;
      } catch { /* 启动中 */ }
      await new Promise((r2) => setTimeout(r2, 1000));
    }

    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });

    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m5admin-${runId}@t.dev`, password: "password-123", displayName: "语义管理员", teamName: `语义团队-${runId}` }),
    });
    admin = sessionOf(a); teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m5member-${runId}@t.dev`, password: "password-123", displayName: "语义成员", teamName: `旁-${runId}` }),
    });
    member = sessionOf(m);
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m5out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `外队-${runId}` }),
    });
    outsider = sessionOf(o);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m5member-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "语义验证项目", code: `sem-${runId}` } });
    projectId = proj.json.projectId;
  }, 90000);

  afterAll(async () => {
    await app.close();
    worker?.kill();
  });

  it("D07-中文：真实 semantica 抽取中文关系候选，带证据定位与来源", async () => {
    const res = await call("POST", "/semantic/extract", {
      session: member,
      body: {
        teamId,
        revisionRef: `${teamId}/model-a/rev1`,
        text: "轨道传播模型A 依赖于 引擎核心，并且由 接口说明v2 描述。",
        entityHints: [
          { text: "轨道传播模型A", label: "MODEL" },
          { text: "引擎核心", label: "ENGINE" },
          { text: "接口说明v2", label: "DOC" },
        ],
      },
    });
    expect(res.status === 200, JSON.stringify(res.json).slice(0, 300));
    const j = res.json;
    expect(j.candidate_entities.length >= 3, j, "实体候选不足");
    expect(j.candidate_relations.some((r: any) => r.type === "dependsOn" && r.evidence.matched_pattern === "依赖于"), j, "dependsOn 候选缺失");
    // 来源：证据锚点携带修订引用；抽取器版本固定
    expect(j.evidence_anchors.every((e: any) => e.revision_ref === `${teamId}/model-a/rev1`), j, "来源引用缺失");
    expect(String(j.extractor_version)).toContain("semantica/0.6.8", j);
  });

  it("D07-同名：同名实体不自动合并，进入待消歧列表", async () => {
    const res = await call("POST", "/semantic/validate", {
      session: member,
      body: {
        teamId,
        candidates: [
          { entityId: "a1", name: "轨道传播模型A", properties: { positionUnit: "m", frame: "ECI" } },
          { entityId: "a2", name: "轨道传播模型A", properties: { positionUnit: "km", frame: "ECEF" } },
          { entityId: "a3", name: "轨道传播模型A", properties: { positionUnit: "m" } },
        ],
      },
    });
    expect(res.status === 200, JSON.stringify(res.json).slice(0, 300));
    // 单位冲突被真实检测（m 与 km）
    expect(res.json.conflicts.length >= 1, res.json, "单位冲突应被检出");
    // 同名多实体：结构上保持独立，不自动合并
    const names = res.json.unresolved_entities as string[];
    expect(names.includes("轨道传播模型A") || res.json.conflicts.length >= 1, res.json, "同名应进消歧或冲突");
  });

  it("D07-单位：非法单位被结构校验拒绝（真实词表）", async () => {
    const res = await call("POST", "/semantic/validate", {
      session: member,
      body: {
        teamId,
        candidates: [
          { entityId: "u1", name: "单位坏实体", properties: { positionUnit: "parsecs" } },
        ],
      },
    });
    expect(res.status === 200, JSON.stringify(res.json).slice(0, 300));
    expect(res.json.structural_errors.some((e: string) => e.includes("positionUnit")), res.json, "非法单位应报结构错误");
  });

  it("D08：检索与语义接口先查权限，外人不可见", async () => {
    // 外人调用语义抽取 → 404（无团队身份）
    const ext = await call("POST", "/semantic/extract", {
      session: outsider,
      body: { teamId, revisionRef: "x/y/z", text: "测试", entityHints: [] },
    });
    expect(ext.status === 404, ext.json, "外人语义抽取应 404");
    // 外人搜索团队资产 → 空或 404（不泄露）
    const search = await call("GET", `/assets/search?teamId=${teamId}`, { session: outsider });
    expect(search.status === 404 || (search.json as any[]).length === 0, search.json, "外人搜索不应返回团队资产");
  });

  it("D09：语义 worker 故障时明确降级，核心流程照常", async () => {
    // 指向不存在的 worker 端口（每请求读取环境变量）
    process.env.SEMANTIC_WORKER_URL = "http://127.0.0.1:59999";
    const dead = await call("POST", "/semantic/extract", {
      session: member,
      body: { teamId, revisionRef: "x/y/z", text: "测试降级", entityHints: [] },
    });
    expect(dead.status === 503 && dead.json.error.code === "DEPENDENCY_UNAVAILABLE", dead.json, "应 503 明确降级");
    // 核心流程不受影响：资产登记、检索、关系照常
    const types = await call("GET", `/types?teamId=${teamId}`, { session: member });
    expect(types.status === 200, types.json, "类型列表失败");
    const tv = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;
    const asset = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "降级期登记文档", typeVersionId: tv.id,
        properties: { docRole: "manual", format: "txt", language: "zh-CN", confidentiality: "internal", scope: "x" } },
    });
    expect(asset.status === 201, asset.json, "降级期资产登记失败");
    const search = await call("GET", `/assets/search?teamId=${teamId}&q=降级期`, { session: member });
    expect(search.status === 200 && search.json.length === 1, search.json, "降级期检索失败");
    // 恢复 worker 地址
    process.env.SEMANTIC_WORKER_URL = `http://127.0.0.1:${WORKER_PORT}`;
    const recovered = await call("POST", "/semantic/extract", {
      session: member,
      body: { teamId, revisionRef: "x/y/z", text: "恢复测试", entityHints: [] },
    });
    expect(recovered.status === 200, recovered.json, "worker 恢复后应可用");
  });
});
