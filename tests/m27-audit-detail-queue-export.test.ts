// M27 审计详情 + 语义队列导出测试 — 治理回执原文按需拉取（团队 scoped、404/422 如实）；
// 队列导出 CSV/JSON 与状态过滤、盖章 semantic.queue.export（先取数后盖章、动态页可见、
// 过滤选项自动出现）。全部真实集成，无 mock。
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

const PORT = 4134;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M27 审计条目详情 + 语义队列导出", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let projectId = "";
  let assetA = "";
  let assetB = "";
  let candConfirm = "";
  let candDismiss = "";
  let candPending = "";
  let adminPool: Pool;
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
    const a = await reg(`m27-${runId}@t.dev`, "M27队长", `M27团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M27项目-${runId}`, code: `m27${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: { teamId, name, typeVersionId: docTypeId, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M27" } },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(`M27模型说明书-${runId}`);
    assetB = await mk(`M27接口文档-${runId}`);

    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    const { rows: u } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m27-${runId}@t.dev`]);
    // 团队级 + 项目级审计各一条，detail 带治理回执
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at)
       VALUES ($1,$2,'asset.archive','audit',jsonb_build_object('note','M27 团队级回执','count',3),now())`,
      [teamId, u[0]!.id]
    );
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, project_id, created_at)
       VALUES ($1,$2,'release_published','release',jsonb_build_object('channel','stable','digest','abc123'),$3,now())`,
      [teamId, u[0]!.id, projectId]
    );

    // 候选三条：确认 / 忽略 / 待审各一（确认走真实断言路径，关系类型先登记 document→document）
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m27depends", version: "1.0.0", title: "M27依赖", sourceTypeKeys: ["document"], targetTypeKeys: ["document"], requiresRevision: false },
    });
    expectOk(rt.status === 201, rt.json, "注册关系类型失败");
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [
          { relationType: "m27depends", sourceText: `M27模型说明书-${runId}`, targetText: `M27接口文档-${runId}`, confidence: 0.9, extractorVersion: "m27-test" },
          { relationType: "documentedBy", sourceText: `M27模型说明书-${runId}`, targetText: `M27接口文档-${runId}`, confidence: 0.7, extractorVersion: "m27-test" },
          { relationType: "related_to", sourceText: `M27接口文档-${runId}`, targetText: `M27模型说明书-${runId}`, confidence: 0.5, extractorVersion: "m27-test" },
        ],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    [candConfirm, candDismiss, candPending] = imp.json.candidateIds;
    const conf = await call("POST", `/semantic/candidates/${candConfirm}/confirm`, {
      session: admin, body: { teamId, sourceAssetId: assetA, targetAssetId: assetB },
    });
    expectOk(conf.status === 200, conf.json, "确认失败");
    const dis = await call("POST", `/semantic/candidates/${candDismiss}/dismiss`, { session: admin, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略失败");
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("审计详情：回执原文按需拉取，团队 scoped，404/422/越权如实", async () => {
    const lst = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expectOk(lst.status === 200, lst.json, "列表失败");
    const auditKey = (lst.json.items as Array<{ key?: string; kind: string }>).find((i) => i.kind === "audit" && i.key?.startsWith("audit:"))!.key!;
    const auditId = auditKey.slice("audit:".length);

    const d = await call("GET", `/activity/audit/${auditId}?teamId=${teamId}`, { session: admin });
    expectOk(d.status === 200, d.json, "详情失败");
    expect(d.json.action === "release_published" || d.json.action === "asset.archive", `动作应如实：${d.json.action}`).toBe(true);
    expect(!!d.json.detail && typeof d.json.detail === "object", `回执原文应返回：${JSON.stringify(d.json.detail)}`).toBe(true);
    if (d.json.action === "release_published") {
      expect(d.json.detail.channel === "stable" && d.json.project_name === `M27项目-${runId}`, `项目级回执应带项目名：${JSON.stringify(d.json)}`).toBe(true);
    }

    const missing = await call("GET", `/activity/audit/999999?teamId=${teamId}`, { session: admin });
    expect(missing.status === 404, `不存在应 404：${missing.status}`).toBe(true);
    const bad = await call("GET", `/activity/audit/abc?teamId=${teamId}`, { session: admin });
    expect(bad.status === 422, `非法 id 应 422：${bad.status}`).toBe(true);

    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m27other-${runId}@t.dev`, password: "password-123", displayName: "M27外团队", teamName: `M27外团队-${runId}` }),
    });
    const other = sessionOf(o);
    const foreign = await call("GET", `/activity/audit/${auditId}?teamId=${teamId}`, { session: other });
    expect(foreign.status === 404, `非成员应 404：${foreign.status}`).toBe(true);
  });

  it("队列导出：CSV/JSON 与状态过滤同源，盖章 semantic.queue.export 且动态页/过滤选项自动可见", async () => {
    // 缺省 CSV（all）：BOM + 表头 + 3 行，时间正序
    const csvRes = await fetch(`${BASE}/semantic/candidates/export?teamId=${teamId}&status=all`, { headers: { cookie: admin.cookie } });
    expect(csvRes.status === 200, `CSV 导出应 200：${csvRes.status}`).toBe(true);
    expect((csvRes.headers.get("content-type") ?? "").startsWith("text/csv"), "应 text/csv").toBe(true);
    const buf = new Uint8Array(await csvRes.arrayBuffer());
    expect(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, "应带 UTF-8 BOM").toBe(true);
    const csvText = new TextDecoder().decode(buf.slice(3));
    const lines = csvText.trim().split("\r\n");
    expect(lines.length === 4, `应为表头+3 行：${lines.length}`).toBe(true);
    expect(lines[0]!.includes("relation_type") && lines[0]!.includes("status"), `表头应含类型/状态：${lines[0]}`).toBe(true);
    expect((csvText.match(/m27depends|documentedBy|related_to/g) ?? []).length === 3, "三种类型各出现一次").toBe(true);

    // JSON + 状态过滤：pending 恰 1 条、confirmed 恰 1 条（含断言去向）
    const pj = await call("GET", `/semantic/candidates/export?teamId=${teamId}&status=pending&format=json`, { session: admin });
    expectOk(pj.status === 200, pj.json, "pending 导出失败");
    expect(pj.json.total === 1 && pj.json.status === "pending", `pending 应 1 条：${JSON.stringify({ total: pj.json.total, status: pj.json.status })}`).toBe(true);
    expect(pj.json.items[0]!.id === candPending, `应为待审候选：${pj.json.items[0]!.id}`).toBe(true);
    const cj = await call("GET", `/semantic/candidates/export?teamId=${teamId}&status=confirmed&format=json`, { session: admin });
    expect(cj.json.total === 1 && cj.json.items[0]!.id === candConfirm && !!cj.json.items[0]!.resolvedRelationId, `confirmed 应带断言去向：${JSON.stringify(cj.json.items[0])}`).toBe(true);

    // 盖章：三次导出各落一条 semantic.queue.export，先取数后盖章（章不在本次导出内）
    const { rows: stamps } = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE team_id = $1 AND action = 'semantic.queue.export' ORDER BY created_at DESC LIMIT 3`,
      [teamId]
    );
    expect(stamps.length === 3, `应有 3 条导出章：${stamps.length}`).toBe(true);
    expect(stamps[2]!.detail.count === 3 && stamps[2]!.detail.status === "all" && stamps[2]!.detail.format === "csv", `全量章应如实：${JSON.stringify(stamps[2]!.detail)}`).toBe(true);

    // 动态页可见 + 过滤选项自动出现（ACTION_LABELS 同源）
    const act = await call("GET", `/activity?teamId=${teamId}&action=semantic.queue.export&limit=50`, { session: admin });
    expect(act.json.items.length === 3, `过滤视图应 3 条导出章：${act.json.items.length}`).toBe(true);
    expect((act.json.items as Array<{ summary: string }>)[0]!.summary === "导出语义队列", "摘要应为中文标签").toBe(true);
    const opts = (act.json.actions ?? []) as Array<{ value: string }>;
    expect(opts.some((o) => o.value === "semantic.queue.export"), "过滤选项应自动包含新动作").toBe(true);

    const badStatus = await call("GET", `/semantic/candidates/export?teamId=${teamId}&status=archived`, { session: admin });
    expect(badStatus.status === 422, `非法状态应 422：${badStatus.status}`).toBe(true);
    const badFormat = await call("GET", `/semantic/candidates/export?teamId=${teamId}&format=xml`, { session: admin });
    expect(badFormat.status === 422, `非法格式应 422：${badFormat.status}`).toBe(true);
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m27o2-${runId}@t.dev`, password: "password-123", displayName: "M27外团队B", teamName: `M27外团队B-${runId}` }),
    });
    const other = sessionOf(o);
    const foreign = await call("GET", `/semantic/candidates/export?teamId=${teamId}`, { session: other });
    expect(foreign.status === 404, `非成员应 404：${foreign.status}`).toBe(true);
  });
});
