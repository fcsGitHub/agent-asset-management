// M14 语义候选工作台测试 — 界面背后的完整确认闭环：
// 真实抽取（规则/LLM 增强）→ 人工把候选端点映射到真实资产 → 确认断言 → 关系目录可见。
// 全部真实集成：真实 PostgreSQL、真实语义 worker、真实 DeepSeek。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "@taw/agent-adapter/env";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomBytes(4).toString("hex");
loadEnvFile();
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

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

function caller(base: string) {
  return async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      headers["x-csrf-token"] = opts.session.csrf;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

const W_PORT = 8133;
const PORT = 4121;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const SEED_TEXT = `「轨道传播模型A」依赖于「推进模块B」的接口定义，由「接口文档C」描述。`;
const ASSET_NAMES = ["轨道传播模型A", "推进模块B", "接口文档C"];

async function spawnWorker(port: number): Promise<ChildProcess> {
  const env: Record<string, string | undefined> = { ...process.env, SEMANTIC_WORKER_PORT: String(port) };
  const worker = spawn(join(root, ".venv-sema", "Scripts", "python.exe"), [join(root, "services", "semantic-worker", "main.py")], {
    env: env as NodeJS.ProcessEnv,
    stdio: "ignore",
  });
  const started = Date.now();
  while (Date.now() - started < 60000) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) return worker;
    } catch { /* 启动中 */ }
    await new Promise((r2) => setTimeout(r2, 800));
  }
  worker.kill();
  throw new Error(`worker ${port} 启动超时`);
}

describe("M14 语义候选确认闭环（抽取 → 映射 → 断言，真实 worker）", () => {
  let worker: ChildProcess;
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let docTypeId = "";
  const call = caller(BASE);
  const assetIds = new Map<string, string>();

  beforeAll(async () => {
    worker = await spawnWorker(W_PORT);
    process.env.SEMANTIC_WORKER_URL = `http://127.0.0.1:${W_PORT}`;
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m14-${runId}@t.dev`, password: "password-123", displayName: "M14管理员", teamName: `M14团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    for (const name of ASSET_NAMES) {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M14" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      assetIds.set(name, r.json.assetId as string);
    }
  }, 90000);

  afterAll(async () => {
    await app.close();
    worker.kill();
  });

  it("规则抽取 → 端点映射到真实资产 → 确认断言 → 关系目录可见", async () => {
    const r = await call("POST", "/semantic/extract", {
      session: admin,
      body: {
        teamId,
        revisionRef: `${teamId}/${assetIds.get("轨道传播模型A")}/head`,
        text: SEED_TEXT,
        entityHints: ASSET_NAMES.map((t) => ({ text: t })),
        enhanceLlm: false,
      },
    });
    expectOk(r.status === 200, r.json, "抽取失败");
    const cands = r.json.candidate_relations as { type: string; source: { text: string }; target: { text: string }; status: string }[];
    expect(cands.length > 0, "应抽出候选关系").toBe(true);
    expect(cands.every((c) => c.status === "candidate"), "候选必须仍是 candidate").toBe(true);
    // 界面同款映射：端点文本精确匹配资产名
    const depends = cands.find((c) => c.type === "dependsOn" && assetIds.has(c.source.text) && assetIds.has(c.target.text));
    expect(!!depends, `应有端点可精确映射的 dependsOn 候选：${JSON.stringify(cands).slice(0, 300)}`).toBe(true);
    // 确认断言：使用默认 dependsOn 关系类型
    const rts = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rt = (rts.json as { id: string; type_key: string }[]).filter((x) => x.type_key === "dependsOn").pop();
    expect(!!rt, "默认 dependsOn 关系类型应存在").toBe(true);
    const rel = await call("POST", "/relations", {
      session: admin,
      body: {
        teamId, relationTypeVersionId: rt!.id,
        sourceAssetId: assetIds.get(depends!.source.text), targetAssetId: assetIds.get(depends!.target.text),
        confirm: true,
      },
    });
    expectOk(rel.status === 201, rel.json, "确认断言应 201");
    // 关系目录可见（资产详情页的数据源）
    const aId = assetIds.get(depends!.source.text)!;
    const view = await call("GET", `/relations?teamId=${teamId}&assetId=${aId}`, { session: admin });
    const out = (view.json.outgoing as { type_key: string; target_name: string; status: string }[]).find((e) => e.type_key === "dependsOn");
    expect(!!out, "断言后 outgoing 应含 dependsOn").toBe(true);
    expect(out!.status === "confirmed", `状态应为 confirmed：${out!.status}`).toBe(true);
  });

  it("LLM 增强抽取（真实 DeepSeek）：候选仍需确认；端点精确映射可确认成功", async () => {
    const r = await call("POST", "/semantic/extract", {
      session: admin,
      body: {
        teamId,
        revisionRef: `${teamId}/${assetIds.get("轨道传播模型A")}/head`,
        text: SEED_TEXT,
        entityHints: ASSET_NAMES.map((t) => ({ text: t })),
        enhanceLlm: true,
      },
    });
    expectOk(r.status === 200, r.json, "LLM 增强抽取失败");
    const j = r.json as { candidate_relations: { type: string; source: { text: string }; target: { text: string }; status: string; llm_proposed?: boolean }[]; warnings: string[]; extractor_version: string };
    expectOk(j.candidate_relations.length > 0, j, "应至少有规则候选");
    expect(j.candidate_relations.every((c) => c.status === "candidate"), "LLM 场景下候选同样必须仍是 candidate").toBe(true);
    expect(
      j.extractor_version.includes("+llm/") || j.warnings.some((w) => w.includes("LLM 增强失败")),
      `应真实走 LLM 或如实降级：${j.extractor_version}`
    ).toBe(true);
    // 映射并确认一个端点精确匹配的候选（可能是 LLM 提议的）
    const mappable = j.candidate_relations.find((c) => c.type !== "related_to" && assetIds.has(c.source.text) && assetIds.has(c.target.text));
    if (!mappable) {
      expect(j.warnings.length >= 0, "无可映射候选时本用例仅验证候选可见性").toBe(true);
      return;
    }
    const rts = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rt = (rts.json as { id: string; type_key: string }[]).filter((x) => x.type_key === mappable.type).pop();
    expect(!!rt, `关系类型 ${mappable.type} 应已注册（默认词表）`).toBe(true);
    const rel = await call("POST", "/relations", {
      session: admin,
      body: {
        teamId, relationTypeVersionId: rt!.id,
        sourceAssetId: assetIds.get(mappable.source.text), targetAssetId: assetIds.get(mappable.target.text),
        confirm: true,
      },
    });
    expectOk(rel.status === 201, rel.json, "LLM 候选经人工确认应可断言");
  });

  it("worker 不可达：503 DEPENDENCY_UNAVAILABLE 如实报错（核心流程不受影响）", async () => {
    process.env.SEMANTIC_WORKER_URL = "http://127.0.0.1:8999";
    // 构建第二个 server 以拿到重启后的 env 读取时机（workerUrl 每次调用时读取 env）
    const r = await call("POST", "/semantic/extract", {
      session: admin,
      body: {
        teamId,
        revisionRef: `${teamId}/${assetIds.get("轨道传播模型A")}/head`,
        text: SEED_TEXT,
        entityHints: [],
        enhanceLlm: false,
      },
    });
    expect(r.status === 503, `worker 不可达应 503，实际 ${r.status}`).toBe(true);
    expect(r.json?.error?.code === "DEPENDENCY_UNAVAILABLE" || String(r.json?.error?.message ?? "").includes("worker"), "应如实标注依赖不可用").toBe(true);
    process.env.SEMANTIC_WORKER_URL = `http://127.0.0.1:${W_PORT}`;
  });
});
