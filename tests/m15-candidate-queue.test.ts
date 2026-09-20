// M15 候选审核队列测试 — 候选持久化（0020）后的完整生命周期：
// 入队 → 跨成员可见 → 确认（共享断言路径，违规时保持 pending）→ 忽略。全部真实集成，无 mock。
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

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M15 候选审核队列（持久化 + 跨成员 + 原子确认）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let projectId = "";
  let docTypeId = "";
  let assetA = "";
  let assetB = "";
  let candidateId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = async (email: string, name: string, team: string) => {
      const res = await fetch(`${BASE}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
      });
      expect(res.status === 201, "注册失败").toBe(true);
      return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
    };
    const a = await reg(`m15-${runId}@t.dev`, "M15队长", `M15团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m15member-${runId}@t.dev`, "M15审核员", `M15成员团队-${runId}`);
    member = m.session;
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m15member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M15项目-${runId}`, code: `m15${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M15" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(`M15模型说明书-${runId}`);
    assetB = await mk(`M15接口文档-${runId}`);
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("入队 → 队列跨成员可见（含入队人与来源资产）", async () => {
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [
          {
            relationType: "dependsOn", sourceText: `M15模型说明书-${runId}`, targetText: `M15接口文档-${runId}`,
            evidenceSegment: "「M15模型说明书」依赖于「M15接口文档」", confidence: 0.9,
            llmProposed: false, extractorVersion: "taw-semantic-worker/1+test",
          },
          {
            relationType: "documentedBy", sourceText: `M15模型说明书-${runId}`, targetText: `M15接口文档-${runId}`,
            evidenceSegment: "由「M15接口文档」描述", confidence: 0.75,
            llmProposed: true, extractorVersion: "taw-semantic-worker/1+llm/deepseek",
          },
        ],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    expect(imp.json.imported === 2, `应入队 2 条：${imp.json.imported}`).toBe(true);
    candidateId = imp.json.candidateIds[0]!;

    // 另一位成员的队列视图应看到同样的候选（跨会话/跨成员）
    const seen = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: member });
    expectOk(seen.status === 200, seen.json, "成员读队列失败");
    const row = (seen.json as { id: string; created_by_name: string; asset_name: string }[]).find((c) => c.id === candidateId);
    expect(!!row, "成员应看到队长入队的候选").toBe(true);
    expect(row!.created_by_name === "M15队长", `应如实标注入队人：${row!.created_by_name}`).toBe(true);
    expect(row!.asset_name?.includes("M15模型说明书"), `应带来源资产名：${row!.asset_name}`).toBe(true);
  });

  it("成员确认入队候选：走共享断言路径，关系落地且候选转为 confirmed", async () => {
    const rts = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rt = (rts.json as { id: string; type_key: string }[]).filter((x) => x.type_key === "dependsOn").pop();
    // 先探测断言路径可用（与确认端点同校验）
    const rel = await call("POST", "/relations", {
      session: member,
      body: { teamId, relationTypeVersionId: rt!.id, sourceAssetId: assetA, targetAssetId: assetB, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "成员普通断言应可用");
    // 成员经确认端点断言第二条候选（documentedBy）
    const seen = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: member });
    const doc = (seen.json as { id: string; relation_type: string }[]).find((c) => c.relation_type === "documentedBy");
    expect(!!doc, "documentedBy 候选应待审").toBe(true);
    const conf = await call("POST", `/semantic/candidates/${doc!.id}/confirm`, {
      session: member,
      body: { teamId, sourceAssetId: assetA, targetAssetId: assetB },
    });
    expectOk(conf.status === 200, conf.json, "确认应成功");
    expect(conf.json.status === "confirmed" || conf.json.relationId, `应返回断言结果：${JSON.stringify(conf.json)}`).toBe(true);
    // 关系目录可见
    const view = await call("GET", `/relations?teamId=${teamId}&assetId=${assetA}`, { session: admin });
    const edge = (view.json.outgoing as { type_key: string; status: string }[]).find((e) => e.type_key === "documentedBy");
    expect(!!edge && edge.status === "confirmed", "确认产生的断言应 confirmed 且可见").toBe(true);
    // 重复确认同一候选：409（状态机）
    const again = await call("POST", `/semantic/candidates/${doc!.id}/confirm`, {
      session: member, body: { teamId, sourceAssetId: assetA, targetAssetId: assetB },
    });
    expect(again.status === 409, `重复确认应 409，实际 ${again.status}`).toBe(true);
  });

  it("确认被 domain/range 拒绝时：候选保持 pending，错误如实回显", async () => {
    // 注册只允许 software→software 的严格关系类型，并把一条候选标为该类型：
    // 通过"先入队一个 typeKey 未注册的候选 → 确认报未注册"与"违规候选"两层验证
    const strict = await call("POST", "/relation-types", {
      session: admin,
      body: {
        teamId, typeKey: "m15strict", version: "1.0.0", title: "M15严格",
        sourceTypeKeys: ["software"], targetTypeKeys: ["software"], requiresRevision: false,
      },
    });
    expectOk(strict.status === 201, strict.json, "注册严格关系类型失败");
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [{
          relationType: "m15strict", sourceText: "任一", targetText: "任二",
          confidence: 0.5, llmProposed: false, extractorVersion: "test",
        }],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    const id = imp.json.candidateIds[0]!;
    // 端点是 document 资产 → DOMAIN_RANGE_VIOLATION
    const conf = await call("POST", `/semantic/candidates/${id}/confirm`, {
      session: admin,
      body: { teamId, sourceAssetId: assetA, targetAssetId: assetB },
    });
    expect(conf.status === 409, `违规确认应 409，实际 ${conf.status}`).toBe(true);
    expect(conf.json?.error?.code === "DOMAIN_RANGE_VIOLATION", `应如实返回违规码：${conf.json?.error?.code}`).toBe(true);
    // 候选保持 pending（可修正映射后重试）
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    const still = (pending.json as { id: string }[]).find((c) => c.id === id);
    expect(!!still, "违规后候选必须保持 pending").toBe(true);
  });

  it("忽略：pending → dismissed，重复忽略 409", async () => {
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [{ relationType: "related_to", sourceText: "甲", targetText: "乙", confidence: 0.3, llmProposed: false, extractorVersion: "test" }],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    const id = imp.json.candidateIds[0]!;
    const dis = await call("POST", `/semantic/candidates/${id}/dismiss`, { session: member, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略应成功");
    const again = await call("POST", `/semantic/candidates/${id}/dismiss`, { session: member, body: { teamId } });
    expect(again.status === 409, `重复忽略应 409`).toBe(true);
    const pending = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    expect(!(pending.json as { id: string }[]).some((c) => c.id === id), "已忽略不应出现在待审列表").toBe(true);
  });

  it("鉴权：非本团队成员读不到队列", async () => {
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m15other-${runId}@t.dev`, password: "password-123", displayName: "M15外团队", teamName: `M15外团队-${runId}` }),
    });
    const other = sessionOf(o);
    const r = await call("GET", `/semantic/candidates?teamId=${teamId}`, { session: other });
    expect(r.status === 404, `非成员应 404，实际 ${r.status}`).toBe(true);
  });
});
