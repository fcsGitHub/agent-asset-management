// M21 测试 — 语义候选导入去重（队列卫生：同类型+端点的 pending/confirmed 拒入、
// dismissed 放行）+ NL 图谱聚焦（L1 规则句式与真实 DeepSeek L2 白名单解析）。
// 全部真实集成，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
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

const PORT = 4129;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M21 候选导入去重 + NL 图谱聚焦", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let assetA = "";
  let assetB = "";
  let candA = ""; // dependsOn（可确认）
  let candB = ""; // related_to（可忽略）
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m21-${runId}@t.dev`, password: "password-123", displayName: "M21队长", teamName: `M21团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M21项目-${runId}`, code: `m21${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M21" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(`M21模型说明书-${runId}`);
    assetB = await mk(`M21接口文档-${runId}`);
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("导入去重：同类型+端点的 pending/confirmed 拒入，dismissed 放行；跳过数如实回执", async () => {
    const cand = (relationType: string, targetText: string) => ({
      relationType, sourceText: `M21模型说明书-${runId}`, targetText,
      evidenceSegment: `「M21模型说明书」依赖于「${targetText}」`, confidence: 0.8,
      llmProposed: false, extractorVersion: "taw-semantic-worker/1+test",
    });
    // 首次入队：2 条全部成功
    const first = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: { teamId, assetId: assetA, candidates: [cand("dependsOn", `M21接口文档-${runId}`), cand("related_to", "游离词")] },
    });
    expectOk(first.status === 201, first.json, "首次入队失败");
    expect(first.json.imported === 2 && first.json.skipped === 0, `应入队 2 跳过 0：${JSON.stringify(first.json)}`).toBe(true);
    candA = first.json.candidateIds[0]!;
    candB = first.json.candidateIds[1]!;

    // 原样重复入队：全部跳过（pending 去重）
    const again = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: { teamId, assetId: assetA, candidates: [cand("dependsOn", `M21接口文档-${runId}`), cand("related_to", "游离词")] },
    });
    expectOk(again.status === 201, again.json, "重复入队应 201（逐条如实回执）");
    expect(again.json.imported === 0 && again.json.skipped === 2, `应全跳过：${JSON.stringify(again.json)}`).toBe(true);
    expect(JSON.stringify(again.json.duplicateIndexes) === "[0,1]", `应标注重复下标：${JSON.stringify(again.json.duplicateIndexes)}`).toBe(true);

    // 确认 candA → 同键候选仍拒入（confirmed 也算重复）
    const rts = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rt = (rts.json as { id: string; type_key: string }[]).filter((x) => x.type_key === "dependsOn").pop();
    const conf = await call("POST", `/semantic/candidates/${candA}/confirm`, {
      session: admin, body: { teamId, sourceAssetId: assetA, targetAssetId: assetB },
    });
    expectOk(conf.status === 200, conf.json, "确认失败");
    const afterConfirm = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: { teamId, assetId: assetA, candidates: [cand("dependsOn", `M21接口文档-${runId}`)] },
    });
    expect(afterConfirm.json.imported === 0 && afterConfirm.json.skipped === 1,
      `confirmed 后应仍拒入：${JSON.stringify(afterConfirm.json)}`).toBe(true);

    // 忽略 candB → 同键重新入队被放行（dismissed 不算重复）；changed 键不受影响
    const dis = await call("POST", `/semantic/candidates/${candB}/dismiss`, { session: admin, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略失败");
    const afterDismiss = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: { teamId, assetId: assetA, candidates: [cand("related_to", "游离词"), cand("verifies", "另一词")] },
    });
    expectOk(afterDismiss.status === 201, afterDismiss.json, "dismissed 后重入队失败");
    expect(afterDismiss.json.imported === 2 && afterDismiss.json.skipped === 0,
      `dismissed 放行 + 新键不受影响：${JSON.stringify(afterDismiss.json)}`).toBe(true);

    // 待审列表恰有一条 related_to/游离词（重新入队的那条）
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    const rows = pending.json as Array<{ relation_type: string; target_text: string }>;
    expect(rows.filter((r) => r.relation_type === "related_to" && r.target_text === "游离词").length === 1,
      `重新入队的候选应恰好一条：${JSON.stringify(rows)}`).toBe(true);
  });

  it("NL 规则：图谱聚焦三种句式 L1 命中；纯图谱导航不回归", async () => {
    const parse = async (text: string) => call("POST", "/nl/parse", { session: admin, body: { teamId, text, page: "dashboard" } });
    const r1 = await parse(`聚焦M21接口文档-${runId}的图谱`);
    expectOk(r1.status === 200, r1.json, "聚焦句式解析失败");
    expect(r1.json.intent === "navigate" && r1.json.params.page === "graph" && r1.json.params.assetName === `M21接口文档-${runId}`,
      `「聚焦X的图谱」应带 assetName：${JSON.stringify(r1.json)}`).toBe(true);
    const r2 = await parse(`打开M21接口文档-${runId}的关系图谱`);
    expect(r2.json.intent === "navigate" && r2.json.params.page === "graph" && r2.json.params.assetName === `M21接口文档-${runId}`,
      `「打开X的关系图谱」应命中：${JSON.stringify(r2.json)}`).toBe(true);
    const r3 = await parse(`图谱聚焦：M21模型说明书-${runId}`);
    expect(r3.json.intent === "navigate" && r3.json.params.assetName === `M21模型说明书-${runId}`,
      `「图谱聚焦：X」应命中：${JSON.stringify(r3.json)}`).toBe(true);
    // 回归：纯「打开图谱」无 assetName；「打开提案页」仍 → proposals
    const r4 = await parse("打开图谱");
    expect(r4.json.intent === "navigate" && r4.json.params.page === "graph" && !r4.json.params.assetName,
      `「打开图谱」不应带 assetName：${JSON.stringify(r4.json)}`).toBe(true);
    const r5 = await parse("打开提案页");
    expect(r5.json.intent === "navigate" && r5.json.params.page === "proposals",
      `「打开提案页」应回归通过：${JSON.stringify(r5.json)}`).toBe(true);
    expect([r1, r2, r3, r4, r5].every((r) => r.json.parser.kind === "rules"), "全部应走 L1 规则路径").toBe(true);
  });

  it("真实 DeepSeek：口语化图谱聚焦指令经 L2 白名单解析出 graph + assetName", async () => {
    const r = await call("POST", "/nl/parse", {
      session: admin,
      body: { teamId, text: "帮我在关系图里聚焦看看推进模块接口文档", page: "dashboard" },
    });
    expectOk(r.status === 200, r.json, "LLM 解析失败");
    expect(r.json.parser.kind === "llm", `应走 L2：${JSON.stringify(r.json.parser)}`).toBe(true);
    expect(r.json.intent === "navigate" && r.json.params.page === "graph",
      `应解析为 navigate graph：${JSON.stringify(r.json)}`).toBe(true);
    expect(typeof r.json.params.assetName === "string" && r.json.params.assetName.includes("推进模块"),
      `assetName 应指向目标资产：${JSON.stringify(r.json.params)}`).toBe(true);
  }, 40000);
});
