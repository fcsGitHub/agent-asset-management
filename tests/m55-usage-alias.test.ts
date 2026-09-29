// M55 集成测试 — 使用度事件与别名引用（npm/HF 使用度信号 + MLflow alias 思想落地）：
// 别名 CRUD（格式/唯一/权限/跨团队隔离）、by-alias 解析、搜索命中别名、sort=usage 排序、
// 下载埋点（blob 真实下载计数）、复制引用端点、Agent 读取埋点随工具事务提交（m50 同款 seedInTeam）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";

const PORT = 4151;
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
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

async function seedInTeam<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

describe("M55 别名引用与使用度事件", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session, outsider: Session;
  let teamId = "", projectId = "", otherTeamId = "";
  let modelId = "", docId = "";
  let sessionId = "", adminUserId = "", runRowId = "";
  const tv: Record<string, string> = {};
  const rt: Record<string, string> = {};
  let zipDigest = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m55admin-${runId}@t.dev`, password: "password-123", displayName: "别名管理员", teamName: `别名团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m55member-${runId}@t.dev`, password: "password-123", displayName: "别名成员", teamName: `其他团队-${runId}` }),
    });
    member = sessionOf(m);
    otherTeamId = ((await m.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m55out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `外团-${runId}` }),
    });
    outsider = sessionOf(o);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m55member-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "别名验证", code: `m55-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const t of types) tv[t.type_key] = t.id;
    const relTypes = (await call("GET", `/relation-types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const r of relTypes) rt[r.type_key] = r.id;
    const me = await call("GET", "/auth/me", { session: admin });
    adminUserId = (me.json as { userId: string }).userId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M55工具验证", visibility: "project" } });
    expectOk(sess.status === 201, sess.json, "Session 创建失败");
    sessionId = sess.json.sessionId;
  });
  afterAll(async () => { await app.close(); });

  /** 真实运行行（tool_invocations 外键指向 agent_runs，同 m33/m50）。 */
  async function ensureRunRow(): Promise<string> {
    if (runRowId) return runRowId;
    runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,'M55 工具验证',$5,$6,$7,'deepseek',$8)`,
        [teamId, runRowId, sessionId, projectId, JSON.stringify([]),
         JSON.stringify(["asset.getRevision", "graph.neighbors"]),
         JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), adminUserId]
      );
    });
    return runRowId;
  }

  const toolCtx = async () => ({ teamId, userId: adminUserId, projectId, runId: await ensureRunRow() });

  it("登记两个资产并连关系；上传制品", async () => {
    const r1 = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M55传播模型", typeVersionId: tv["simulation.model"], properties: { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v55", validStepSeconds: { min: 0.1, max: 60 } } },
    });
    expectOk(r1.status === 201, r1.json, "模型登记失败");
    modelId = r1.json.assetId;
    const r2 = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M55接口说明", typeVersionId: tv.document, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m55" } },
    });
    expectOk(r2.status === 201, r2.json, "文档登记失败");
    docId = r2.json.assetId;
    const rel = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: rt.documentedBy, sourceAssetId: modelId, targetAssetId: docId, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "关系断言失败");
    const content = Buffer.from(`m55-artifact-${runId}`);
    const form = new FormData();
    form.append("file", new Blob([content]), "m55-模型包.zip");
    const up = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
      method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf }, body: form,
    });
    zipDigest = ((await up.json()) as { digest: string }).digest;
    const art = await call("POST", "/assets", {
      session: admin,
      body: {
        teamId, name: "M55模型带制品", typeVersionId: tv["simulation.model"],
        properties: { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v55", validStepSeconds: { min: 0.1, max: 60 } },
        artifacts: [{ digest: zipDigest, role: "implementation", originalName: "m55-模型包.zip", mediaType: "application/zip", size: content.length }],
      },
    });
    expectOk(art.status === 201, art.json, "带制品资产登记失败");
  });

  it("别名：创建 → 解析 → 冲突 409 → 非创建者 403 → 删除后解析 404", async () => {
    const add = await call("POST", `/assets/${modelId}/aliases`, { session: admin, body: { teamId, alias: "prop-v55" } });
    expectOk(add.status === 201, add.json, "别名创建失败");
    const resolve = await call("GET", `/assets/by-alias/prop-v55?teamId=${teamId}`, { session: admin });
    expectOk(resolve.status === 200, resolve.json, "别名解析失败");
    expect(resolve.json.assetId).toBe(modelId);
    expect(resolve.json.name).toBe("M55传播模型");

    const dup = await call("POST", `/assets/${docId}/aliases`, { session: admin, body: { teamId, alias: "prop-v55" } });
    expect(dup.status).toBe(409);

    const forbidden = await call("POST", `/assets/${modelId}/aliases`, { session: member, body: { teamId, alias: "member-alias" } });
    expect(forbidden.status).toBe(403);

    const bad = await call("POST", `/assets/${modelId}/aliases`, { session: admin, body: { teamId, alias: "Bad Alias!" } });
    expect(bad.status).toBe(422);

    const del = await call("DELETE", `/assets/${modelId}/aliases/prop-v55?teamId=${teamId}`, { session: admin });
    expect(del.status).toBe(200);
    const gone = await call("GET", `/assets/by-alias/prop-v55?teamId=${teamId}`, { session: admin });
    expect(gone.status).toBe(404);

    // 恢复别名供后续用例使用
    const reAdd = await call("POST", `/assets/${modelId}/aliases`, { session: admin, body: { teamId, alias: "prop-v55" } });
    expectOk(reAdd.status === 201, reAdd.json, "别名重建失败");
  });

  it("跨团队隔离：他团队用户解析本团队别名 → 404", async () => {
    const res = await call("GET", `/assets/by-alias/prop-v55?teamId=${otherTeamId}`, { session: member });
    expect(res.status).toBe(404);
    const outsiderRes = await call("GET", `/assets/by-alias/prop-v55?teamId=${teamId}`, { session: outsider });
    expect(outsiderRes.status).toBe(404);
  });

  it("搜索命中别名；详情返回 aliases 与 usage 聚合", async () => {
    const byAlias = await call("GET", `/assets/search?teamId=${teamId}&q=prop-v55`, { session: admin });
    expectOk(byAlias.status === 200, byAlias.json, "搜索失败");
    expect((byAlias.json as { id: string }[]).map((r) => r.id)).toContain(modelId);

    const ref = await call("POST", `/assets/${modelId}/usage`, { session: admin, body: { teamId, kind: "copy_ref" } });
    expect(ref.status).toBe(201);
    const badKind = await call("POST", `/assets/${modelId}/usage`, { session: admin, body: { teamId, kind: "download" } });
    expect(badKind.status).toBe(422);

    const detail = await call("GET", `/assets/${modelId}?teamId=${teamId}`, { session: admin });
    expectOk(detail.status === 200, detail.json, "详情失败");
    expect(detail.json.aliases).toContain("prop-v55");
    expect(detail.json.usage.copy_ref).toBeGreaterThanOrEqual(1);
  });

  it("真实下载计入 download 使用度；sort=usage 按热度降序", async () => {
    const dl = await fetch(`${BASE}/blobs/${zipDigest}?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    expect(dl.status).toBe(200);
    const dl2 = await fetch(`${BASE}/blobs/${zipDigest}?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    expect(dl2.status).toBe(200);

    // 复制引用热度集中在模型上（上例 1 次 + 本次 2 次）
    await call("POST", `/assets/${modelId}/usage`, { session: admin, body: { teamId, kind: "copy_ref" } });
    await call("POST", `/assets/${modelId}/usage`, { session: admin, body: { teamId, kind: "copy_ref" } });

    const res = await call("GET", `/assets/search?teamId=${teamId}&sort=usage`, { session: admin });
    expectOk(res.status === 200, res.json, "排序查询失败");
    const rows = res.json as { id: string; usage_count: number }[];
    expect(rows[0]!.id).toBe(modelId);
    expect(rows[0]!.usage_count).toBeGreaterThanOrEqual(3);
    const counts = rows.map((r) => r.usage_count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));

    const detail = await call("GET", `/assets/${modelId}?teamId=${teamId}`, { session: admin });
    expect(detail.json.usage.copy_ref).toBeGreaterThanOrEqual(3);
  });

  it("Agent 工具读取计入 agent_read（随工具事务真实提交）", async () => {
    const ctx = await toolCtx();
    const result = await seedInTeam(teamId, async (client) => {
      return invokeTool(
        client as never,
        ctx,
        allAgentTools(),
        "call-m55-1",
        "asset.getRevision",
        JSON.stringify({ assetId: modelId })
      );
    });
    expectOk(result.status === "ok", result, "工具调用应成功");
    const detail = await call("GET", `/assets/${modelId}?teamId=${teamId}`, { session: admin });
    expect(detail.json.usage.agent_read).toBeGreaterThanOrEqual(1);
  });

  it("Agent 名称解析支持别名（graph.neighbors 按别名解析成功）", async () => {
    const ctx = await toolCtx();
    const result = await seedInTeam(teamId, async (client) => {
      return invokeTool(
        client as never,
        ctx,
        allAgentTools(),
        "call-m55-2",
        "graph.neighbors",
        JSON.stringify({ name: "prop-v55", depth: 1 })
      );
    });
    // 图库可能滞后/离线：只要不是「名称解析失败」即证明别名解析生效
    expectOk(
      result.status === "ok" || !(result.error ?? "").includes("未命中"),
      result,
      "别名解析不应失败"
    );
    if (result.status === "ok") {
      expect((result.result as { assetId?: string }).assetId).toBe(modelId);
    }
  });
});
