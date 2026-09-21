// M23 入队预演 + 提案批量备注测试 — 入队预演与真实入队共用 planImport 判定核心：
// 预演只判不写、口径与真实入队一致（队列已有 pending/confirmed 跳过、批内重复跳过、dismissed 不算）；
// 批量审核备注经既有 batch-review 端点写入每条审核留痕。全部真实集成，无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
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

interface Cand {
  relationType: string;
  sourceText: string; sourceStart?: number; sourceEnd?: number;
  targetText: string; targetStart?: number; targetEnd?: number;
  evidenceSegment?: string; confidence?: number; llmProposed?: boolean; extractorVersion?: string;
}
function cand(relationType: string, sourceText: string, targetText: string, extra: Partial<Cand> = {}): Cand {
  return { relationType, sourceText, targetText, confidence: 0.8, extractorVersion: "m23-test", ...extra };
}

const PORT = 4131;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M23 入队预演（与真实入队同口径）+ 提案批量审核备注", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let projectId = "";
  let assetA = "";
  let adminPool: Pool;
  const call = caller(BASE);
  const src = `M23模型说明书-${runId}`;
  const tgt = `M23接口文档-${runId}`;

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
    const a = await reg(`m23-${runId}@t.dev`, "M23队长", `M23团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m23member-${runId}@t.dev`, "M23审核员", `M23成员团队-${runId}`);
    member = m.session;
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m23member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M23项目-${runId}`, code: `m23${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "M23 提案会话", visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    const sessionId = sess.json.sessionId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M23" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(src);
    await mk(tgt);

    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    const { rows: u } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m23-${runId}@t.dev`]);
    // 批量备注用例的运行 + 提案种子（真实 DB 行；提案永远待人工审核）
    const rid = randomUUID();
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by)
       VALUES ($1,$2,$3,$4,'completed',$5,$6)`,
      [teamId, rid, sessionId, projectId, `M23 提案运行 ${runId}`, u[0]!.id]
    );
    for (let i = 1; i <= 2; i++) {
      await adminPool.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'asset_registration',jsonb_build_object('name',$5::text,'typeKey','document'))`,
        [teamId, randomUUID(), rid, projectId, `M23 提案 ${i}-${runId}`]
      );
    }
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  const previewBody = (candidates: Cand[], assetId = assetA) => ({
    session: admin,
    body: { teamId, assetId, candidates },
  });

  it("预演与真实入队同口径且不落库：批内重复/队列已有均如实标出，确认后回执与预演一致", async () => {
    const batch = [cand("dependsOn", src, tgt), cand("dependsOn", src, tgt), cand("documentedBy", src, tgt)];
    // 预演：index 1 是批内重复（前序同键条目将先入队），index 2 可入队
    const pv = await call("POST", "/semantic/candidates/import/preview", previewBody(batch));
    expectOk(pv.status === 200, pv.json, "预演失败");
    expect(pv.json.total === 3 && pv.json.wouldImport === 2, `预演应 3 中 2：${JSON.stringify(pv.json)}`).toBe(true);
    expect(pv.json.duplicates.length === 1, `应只标 1 条重复：${JSON.stringify(pv.json.duplicates)}`).toBe(true);
    expect(pv.json.duplicates[0]!.index === 1 && pv.json.duplicates[0]!.reason === "batch", `index 1 应为批内重复：${JSON.stringify(pv.json.duplicates[0])}`).toBe(true);

    // 预演不落库：队列应没有这些候选
    const before = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: member });
    expectOk(before.status === 200, before.json, "读队列失败");
    expect((before.json as { source_text: string }[]).filter((c) => c.source_text === src).length === 0, "预演不得写入队列").toBe(true);

    // 真实入队：回执与预演完全一致
    const imp = await call("POST", "/semantic/candidates/import", previewBody(batch));
    expectOk(imp.status === 201, imp.json, "入队失败");
    expect(imp.json.imported === 2 && imp.json.skipped === 1, `应入队 2 跳过 1：${JSON.stringify(imp.json)}`).toBe(true);
    expect(JSON.stringify(imp.json.duplicateIndexes) === "[1]", `跳过下标应为 [1]：${JSON.stringify(imp.json.duplicateIndexes)}`).toBe(true);

    // 二次预演：已入队的两条现在是队列重复（reason=queue），只有新候选可入队
    const fresh = cand("related_to", src, `M23新增文档-${runId}`);
    const pv2 = await call("POST", "/semantic/candidates/import/preview", previewBody([batch[0]!, batch[2]!, fresh]));
    expectOk(pv2.status === 200, pv2.json, "二次预演失败");
    expect(pv2.json.wouldImport === 1, `仅新候选可入队：${JSON.stringify(pv2.json)}`).toBe(true);
    const reasons = new Map<number, string>(pv2.json.duplicates.map((d: { index: number; reason: string }) => [d.index, d.reason]));
    expect(reasons.get(0) === "queue" && reasons.get(1) === "queue", `前两条应为 queue 重复：${JSON.stringify(pv2.json.duplicates)}`).toBe(true);

    // dismissed 不阻塞重新入队：入队 → 忽略 → 预演同键候选应可入队
    const imp2 = await call("POST", "/semantic/candidates/import", previewBody([fresh]));
    expectOk(imp2.status === 201 && imp2.json.imported === 1, imp2.json, "新候选入队失败");
    const freshId = imp2.json.candidateIds[0] as string;
    const dis = await call("POST", `/semantic/candidates/${freshId}/dismiss`, { session: member, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略失败");
    const pv3 = await call("POST", "/semantic/candidates/import/preview", previewBody([fresh]));
    expect(pv3.json.wouldImport === 1 && pv3.json.duplicates.length === 0, `dismissed 后同键应可再入队：${JSON.stringify(pv3.json)}`).toBe(true);
  });

  it("预演鉴权与校验：匿名 401、非成员 404、来源资产不在团队 422、空候选 422", async () => {
    const anon = await fetch(`${BASE}/semantic/candidates/import/preview`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId, assetId: assetA, candidates: [cand("dependsOn", src, tgt)] }),
    });
    // 匿名 POST 先撞 CSRF 检查（无会话无 token → 403），与 m12 先例一致：401/403 均为拒绝
    expect(anon.status === 401 || anon.status === 403, `匿名应 401/403，实际 ${anon.status}`).toBe(true);

    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m23other-${runId}@t.dev`, password: "password-123", displayName: "M23外团队", teamName: `M23外团队-${runId}` }),
    });
    const outsider = sessionOf(o);
    const foreign = await call("POST", "/semantic/candidates/import/preview", {
      session: outsider, body: { teamId, assetId: assetA, candidates: [cand("dependsOn", src, tgt)] },
    });
    expect(foreign.status === 404, `非成员应 404，实际 ${foreign.status}`).toBe(true);

    const badAsset = await call("POST", "/semantic/candidates/import/preview", {
      session: admin, body: { teamId, assetId: randomUUID(), candidates: [cand("dependsOn", src, tgt)] },
    });
    expect(badAsset.status === 422, `外团队资产应 422，实际 ${badAsset.status}`).toBe(true);
    expect(String(badAsset.json?.error?.message ?? "").includes("来源资产不存在"), `应如实报资产缺失：${badAsset.json?.error?.message}`).toBe(true);

    const empty = await call("POST", "/semantic/candidates/import/preview", { session: admin, body: { teamId, assetId: assetA, candidates: [] } });
    expect(empty.status === 422, `空候选应 422，实际 ${empty.status}`).toBe(true);
  });

  it("批量审核备注：写入每条审核留痕；失败条目不误写，备注不回溯覆盖", async () => {
    const list = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=pending`, { session: admin });
    expectOk(list.status === 200, list.json, "读提案失败");
    const pending = list.json as { id: string; payload: Record<string, unknown> }[];
    expect(pending.length >= 2, `应有 2 条种子提案：${pending.length}`).toBe(true);
    const [p1, p2] = pending as [{ id: string }, { id: string }];

    const note = "按评审会口径接受，证据见附件";
    const batch = await call("POST", `/projects/${projectId}/proposals/batch-review`, {
      session: admin,
      body: { teamId, items: [
        { proposalId: p1!.id, decision: "accepted", note },
        { proposalId: p2!.id, decision: "accepted", note },
      ] },
    });
    expectOk(batch.status === 200, batch.json, "批量审核失败");
    expect(batch.json.reviewed === 2, `应审核 2 条：${JSON.stringify(batch.json)}`).toBe(true);

    const all = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=all`, { session: member });
    const rows = all.json as { id: string; payload: Record<string, unknown>; reviewed_by_name: string | null }[];
    for (const id of [p1!.id, p2!.id]) {
      const row = rows.find((r) => r.id === id);
      expect(!!row, `提案 ${id.slice(0, 8)} 应可见`).toBe(true);
      const review = (row!.payload.review ?? {}) as Record<string, unknown>;
      expect(review.note === note, `备注应写入审核留痕：${JSON.stringify(review)}`).toBe(true);
      expect(row!.reviewed_by_name === "M23队长", `应记录审核人：${row!.reviewed_by_name}`).toBe(true);
    }

    // 混合批次：一条新待审 + 一条已审——失败的条目不得被写备注，成功条目正常
    const { rows: runRows } = await adminPool.query<{ id: string }>(`SELECT id FROM agent_runs WHERE team_id = $1 LIMIT 1`, [teamId]);
    const p3id = randomUUID();
    await adminPool.query(
      `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
       VALUES ($1,$2,$3,$4,'asset_registration',jsonb_build_object('name',$5::text,'typeKey','document'))`,
      [teamId, p3id, runRows[0]!.id, projectId, `M23 提案 3-${runId}`]
    );
    const mixed = await call("POST", `/projects/${projectId}/proposals/batch-review`, {
      session: admin,
      body: { teamId, items: [
        { proposalId: p3id, decision: "accepted", note: "第三条备注" },
        { proposalId: p1!.id, decision: "rejected", note: "试图回溯覆盖" },
      ] },
    });
    expectOk(mixed.status === 200, mixed.json, "混合批次失败");
    expect(mixed.json.reviewed === 1, `混合批次应只成功 1 条：${JSON.stringify(mixed.json)}`).toBe(true);
    const failed = (mixed.json.results as Array<{ proposalId: string; ok: boolean; code?: string }>).find((r) => !r.ok);
    expect(failed?.proposalId === p1!.id && failed.code === "PROPOSAL_NOT_PENDING", `已审条目应如实失败：${JSON.stringify(mixed.json.results)}`).toBe(true);
    const after = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=all`, { session: admin });
    const p1after = (after.json as { id: string; payload: Record<string, unknown> }[]).find((r) => r.id === p1!.id)!;
    expect(((p1after.payload.review ?? {}) as Record<string, unknown>).note === note, "失败条目的备注不得覆盖原留痕").toBe(true);
    const p3after = (after.json as { id: string; payload: Record<string, unknown> }[]).find((r) => r.id === p3id)!;
    expect(((p3after.payload.review ?? {}) as Record<string, unknown>).note === "第三条备注", "成功条目备注应写入").toBe(true);
  });
});
