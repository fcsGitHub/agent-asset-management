// M18 候选队列批审与详情测试 — 批量确认/忽略逐条独立判定（SAVEPOINT 隔离），
// 逐条如实回执（部分成功不伪装全成功）；候选详情全字段含决策留痕与断言去向；
// 受控单位词表经 API 代理同源暴露（worker 不可达时 503 如实降级）。全部真实集成，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4126;
const WORKER_PORT = 8104;
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

describe("M18 候选队列批审与详情（逐条回执 + 同源单位词表）", () => {
  let app: FastifyInstance;
  let worker: ChildProcess;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let teamId = "";
  let assetA = "";
  let assetB = "";
  let cA = "", cB = "", cC = "", cD = "", cE = "", cF = "";
  const call = caller(BASE);

  beforeAll(async () => {
    // 启动真实 semantica worker（单位词表同源校验方）
    worker = spawn(join(root, ".venv-sema", "Scripts", "python.exe"),
      [join(root, "services", "semantic-worker", "main.py")],
      { env: { ...process.env, SEMANTIC_WORKER_PORT: String(WORKER_PORT) }, stdio: "ignore" });
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

    const reg = async (email: string, name: string, team: string) => {
      const res = await fetch(`${BASE}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
      });
      expect(res.status === 201, `注册失败 ${email}`).toBe(true);
      return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
    };
    const a = await reg(`m18-${runId}@t.dev`, "M18队长", `M18团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m18member-${runId}@t.dev`, "M18审核员", `M18成员团队-${runId}`);
    member = m.session;
    const joinRes = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m18member-${runId}@t.dev`, role: "member" } });
    expectOk(joinRes.status === 201, joinRes.json, "加成员失败");
    const o = await reg(`m18other-${runId}@t.dev`, "M18外团队", `M18外团队-${runId}`);
    outsider = o.session;

    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M18" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(`M18模型说明书-${runId}`);
    assetB = await mk(`M18接口文档-${runId}`);

    // 严格关系类型（software→software）：document 端点确认时必被 domain/range 拒绝
    const strict = await call("POST", "/relation-types", {
      session: admin,
      body: {
        teamId, typeKey: "m18strict", version: "1.0.0", title: "M18严格",
        sourceTypeKeys: ["software"], targetTypeKeys: ["software"], requiresRevision: false,
      },
    });
    expectOk(strict.status === 201, strict.json, "注册严格关系类型失败");

    // 入队 6 条：cA/cB 可确认；cC domain 违规；cD 类型未注册；cE 供忽略；cF 留在待审看详情
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [
          { relationType: "dependsOn", sourceText: `M18模型说明书-${runId}`, targetText: `M18接口文档-${runId}`, sourceStart: 0, sourceEnd: 12, targetStart: 14, targetEnd: 26, evidenceSegment: "「M18模型说明书」依赖于「M18接口文档」", confidence: 0.9, llmProposed: false, extractorVersion: "taw-semantic-worker/1+test" },
          { relationType: "documentedBy", sourceText: `M18模型说明书-${runId}`, targetText: `M18接口文档-${runId}`, evidenceSegment: "由「M18接口文档」描述", confidence: 0.75, llmProposed: true, extractorVersion: "taw-semantic-worker/1+llm/deepseek" },
          { relationType: "m18strict", sourceText: `M18模型说明书-${runId}`, targetText: `M18接口文档-${runId}`, confidence: 0.6, llmProposed: false, extractorVersion: "taw-semantic-worker/1+test" },
          { relationType: "m18unreg-xyz", sourceText: "未知词", targetText: "另一词", confidence: 0.4, llmProposed: false, extractorVersion: "taw-semantic-worker/1+test" },
          { relationType: "related_to", sourceText: "甲", targetText: "乙", confidence: 0.3, llmProposed: false, extractorVersion: "test" },
          { relationType: "related_to", sourceText: "丙", targetText: "丁", confidence: 0.3, llmProposed: false, extractorVersion: "test" },
        ],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    const ids = imp.json.candidateIds as string[];
    [cA, cB, cC, cD, cE, cF] = ids as [string, string, string, string, string, string];
  }, 90000);

  afterAll(async () => {
    await app.close();
    worker.kill();
  });

  it("批量确认混合结果：可确认条目落地断言，违规条目逐条回执且保持待审", async () => {
    const r = await call("POST", "/semantic/candidates/batch-confirm", {
      session: member,
      body: {
        teamId,
        items: [
          { candidateId: cA, sourceAssetId: assetA, targetAssetId: assetB },
          { candidateId: cB, sourceAssetId: assetA, targetAssetId: assetB },
          { candidateId: cC, sourceAssetId: assetA, targetAssetId: assetB },
          { candidateId: cD, sourceAssetId: assetA, targetAssetId: assetB },
        ],
      },
    });
    expectOk(r.status === 200, r.json, "批量确认应 200（逐条回执，不因个别失败整单报错）");
    expect(r.json.confirmed === 2, `应确认 2 条：${r.json.confirmed}`).toBe(true);
    const results = r.json.results as Array<{ candidateId: string; ok: boolean; relationId?: string; code?: string; message?: string }>;
    expect(results.length === 4, "应逐条回执 4 条").toBe(true);
    expect(results[0]!.ok && !!results[0]!.relationId, "cA 应确认成功并返回 relationId").toBe(true);
    expect(results[1]!.ok && !!results[1]!.relationId, "cB 应确认成功并返回 relationId").toBe(true);
    expect(results[2]!.ok === false && results[2]!.code === "DOMAIN_RANGE_VIOLATION",
      `cC 应如实回执 domain 违规：${JSON.stringify(results[2])}`).toBe(true);
    expect(results[3]!.ok === false && results[3]!.code === "RELATION_TYPE_UNREGISTERED",
      `cD 应如实回执未注册：${JSON.stringify(results[3])}`).toBe(true);

    // 已确认条目离开待审队列；违规条目保持 pending（可修正后重试）
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: member });
    const ids = (pending.json as { id: string }[]).map((x) => x.id);
    expect(!ids.includes(cA) && !ids.includes(cB), "已确认条目不应再待审").toBe(true);
    expect(ids.includes(cC) && ids.includes(cD) && ids.includes(cE) && ids.includes(cF), "违规条目应保持待审").toBe(true);

    // 断言真实落地：confirmed 状态的两条关系在目录可见
    const view = await call("GET", `/relations?teamId=${teamId}&assetId=${assetA}`, { session: admin });
    const out = view.json.outgoing as Array<{ type_key: string; status: string }>;
    expect(out.some((e) => e.type_key === "dependsOn" && e.status === "confirmed"), "dependsOn 断言应 confirmed").toBe(true);
    expect(out.some((e) => e.type_key === "documentedBy" && e.status === "confirmed"), "documentedBy 断言应 confirmed").toBe(true);
  });

  it("重复批审同一候选：整单 200，该条如实回执 CANDIDATE_NOT_PENDING", async () => {
    const r = await call("POST", "/semantic/candidates/batch-confirm", {
      session: admin,
      body: { teamId, items: [{ candidateId: cA, sourceAssetId: assetA, targetAssetId: assetB }] },
    });
    expectOk(r.status === 200, r.json, "重复批审不应整单报错");
    expect(r.json.confirmed === 0, "不应产生新断言").toBe(true);
    expect(r.json.results[0]?.code === "CANDIDATE_NOT_PENDING",
      `应逐条回执状态机冲突：${JSON.stringify(r.json.results)}`).toBe(true);
  });

  it("批量忽略：有效条目忽略、不存在条目如实回执，不中断其余", async () => {
    const ghost = randomUUID();
    const r = await call("POST", "/semantic/candidates/batch-dismiss", {
      session: member,
      body: { teamId, candidateIds: [cE, ghost] },
    });
    expectOk(r.status === 200, r.json, "批量忽略应 200");
    expect(r.json.dismissed === 1, `应忽略 1 条：${r.json.dismissed}`).toBe(true);
    const results = r.json.results as Array<{ candidateId: string; ok: boolean; code?: string }>;
    expect(results[0]!.ok, "cE 应忽略成功").toBe(true);
    expect(results[1]!.ok === false && results[1]!.code === "CANDIDATE_NOT_PENDING", "幽灵 id 应如实回执").toBe(true);
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: member });
    expect(!(pending.json as { id: string }[]).some((x) => x.id === cE), "已忽略条目应离开待审").toBe(true);
  });

  it("候选详情：确认条目带决策留痕与断言去向；待审条目决策为空；未知 id 404", async () => {
    const done = await call("GET", `/semantic/candidates/${cA}?teamId=${teamId}`, { session: member });
    expectOk(done.status === 200, done.json, "详情读取失败");
    expect(done.json.status === "confirmed", "cA 应为 confirmed").toBe(true);
    expect(!!done.json.resolved_relation_id, "应带断言去向").toBe(true);
    expect(done.json.resolved_type_key === "dependsOn", `应带断言类型：${done.json.resolved_type_key}`).toBe(true);
    expect(done.json.decided_by_name === "M18审核员", `决策人应如实留痕：${done.json.decided_by_name}`).toBe(true);
    expect(done.json.asset_name?.includes("M18模型说明书"), `应带来源资产名：${done.json.asset_name}`).toBe(true);
    expect(typeof done.json.source_start === "number" && typeof done.json.source_end === "number", "应带原文定位 spans").toBe(true);
    expect(done.json.extractor_version?.includes("taw-semantic-worker"), "应带抽取器版本").toBe(true);

    const pend = await call("GET", `/semantic/candidates/${cF}?teamId=${teamId}`, { session: member });
    expectOk(pend.status === 200, pend.json, "待审详情读取失败");
    expect(pend.json.status === "pending" && pend.json.resolved_relation_id === null && pend.json.decided_by_name === null,
      "待审条目不应有决策留痕").toBe(true);

    const missing = await call("GET", `/semantic/candidates/${randomUUID()}?teamId=${teamId}`, { session: member });
    expect(missing.status === 404, `未知候选应 404，实际 ${missing.status}`).toBe(true);
  });

  it("越界与越权：条目数超限 422；非成员批审/详情均 404", async () => {
    const many = Array.from({ length: 51 }, () => ({ candidateId: randomUUID(), sourceAssetId: assetA, targetAssetId: assetB }));
    const over = await call("POST", "/semantic/candidates/batch-confirm", { session: admin, body: { teamId, items: many } });
    expect(over.status === 422, `超限应 422，实际 ${over.status}`).toBe(true);

    const conf = await call("POST", "/semantic/candidates/batch-confirm", {
      session: outsider, body: { teamId, items: [{ candidateId: cF, sourceAssetId: assetA, targetAssetId: assetB }] },
    });
    expect(conf.status === 404, `非成员批量确认应 404，实际 ${conf.status}`).toBe(true);
    const dis = await call("POST", "/semantic/candidates/batch-dismiss", { session: outsider, body: { teamId, candidateIds: [cF] } });
    expect(dis.status === 404, `非成员批量忽略应 404，实际 ${dis.status}`).toBe(true);
    const detail = await call("GET", `/semantic/candidates/${cF}?teamId=${teamId}`, { session: outsider });
    expect(detail.status === 404, `非成员详情应 404，实际 ${detail.status}`).toBe(true);
    // 越权确认不得改动数据
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    expect((pending.json as { id: string }[]).some((x) => x.id === cF), "越权尝试后 cF 仍应待审").toBe(true);
  });

  it("受控单位词表：API 代理与 worker 校验同源；worker 不可达时 503 如实降级", async () => {
    const r = await call("GET", `/semantic/units?teamId=${teamId}`, { session: member });
    expectOk(r.status === 200, r.json, "单位词表读取失败");
    const units = r.json.units as Record<string, string[]>;
    expect(Array.isArray(units.positionUnit) && units.positionUnit.includes("m"), `positionUnit 应含 m：${JSON.stringify(units.positionUnit)}`).toBe(true);
    expect(Array.isArray(units.timeScale) && units.timeScale.includes("UTC"), "timeScale 应含 UTC").toBe(true);
    expect(String(r.json.extractor_version).includes("taw-semantic-worker"), "应带抽取器版本").toBe(true);

    // 降级：worker 不可达 → 503 DEPENDENCY_UNAVAILABLE（如实降级，不伪造词表）
    const saved = process.env.SEMANTIC_WORKER_URL;
    process.env.SEMANTIC_WORKER_URL = "http://127.0.0.1:59999";
    try {
      const down = await call("GET", `/semantic/units?teamId=${teamId}`, { session: member });
      expect(down.status === 503, `worker 不可达应 503，实际 ${down.status}`).toBe(true);
      expect(down.json?.error?.code === "DEPENDENCY_UNAVAILABLE", `应如实降级：${down.json?.error?.code}`).toBe(true);
    } finally {
      process.env.SEMANTIC_WORKER_URL = saved;
    }
  });
});
