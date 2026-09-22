// M32 实测走查修复测试 — 项目成员添加 + 通道发布集历史与回滚 UI 支撑：
// 1) POST /projects/:id/members（走查发现：普通成员此前无任何途径进入项目）——管理员
//    按邮箱添加本团队成员 → 成员 GET /projects 立即可见该项目；重复添加 409；
//    非成员邮箱 422；普通成员（非 lead）添加 403；添加盖章 project.member.add。
// 2) GET /projects/:id/release-sets（走查发现：回滚端点存在但无历史读取与 UI 入口）——
//    两次发布后列出两个发布集（is_current 指向最新）；管理员回滚到旧集 → 通道头回退；
//    release_rollback 盖章落库；普通成员回滚 403。全部真实集成，无任何 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
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

async function withTeamDb<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

async function register(base: string, email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, "注册失败").toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

async function upload(base: string, session: Session, teamId: string, content: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(`${base}/uploads?teamId=${teamId}`, {
    method: "POST",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    body: form,
  });
  const json = (await res.json()) as { digest?: string };
  expect(res.status === 201 && !!json.digest, "上传失败").toBe(true);
  return json.digest!;
}

const PORT = 4139;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const DOC_PROPS = { scope: "M32", docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal" };

describe("M32：项目成员添加 + 通道发布集历史/回滚（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session;      // 团队管理员（CR 作者）
  let admin2: Session;     // 第二管理员（非作者，发布/回滚执行人）
  let member: Session;     // 普通成员
  let teamId = "";
  let projectId = "";
  let docTypeId = "";
  let assetId = "";
  const call = caller(BASE);
  const memberEmail = `m32member-${runId}@t.dev`;

  async function createBranchDraftAndCr(title: string, interfaceVersion: string): Promise<string> {
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: member, body: { teamId, name: `br-${interfaceVersion}-${randomBytes(2).toString("hex")}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const digest = await upload(BASE, member, teamId, `m32 doc ${interfaceVersion}\n`, `d-${interfaceVersion}.txt`);
    const save = await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId, properties: { ...DOC_PROPS, interfaceVersion } },
    });
    expectOk(save.status === 201, save.json, "保存草稿失败");
    const cr = await call("POST", "/change-requests", {
      session: member,
      body: { teamId, branchId: br.json.branchId, title, motivation: title, relatedRefs: "",
        changeSummary: title, compatibility: "无", testPlan: "回归", rollbackNotes: "回退上一发布集" },
    });
    expectOk(cr.status === 201, cr.json, "CR 创建失败");
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, {
      session: member, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(prep.status === 201, prep.json, "prepare-review 失败");
    return prep.json.reviewDigest as string;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(BASE, `m32admin-${runId}@t.dev`, "M32管理员", `M32团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const a2 = await register(BASE, `m32admin2-${runId}@t.dev`, "M32管理员B", `M32旁支-${runId}`);
    admin2 = a2.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m32admin2-${runId}@t.dev`, role: "admin" } });
    const m = await register(BASE, memberEmail, "M32成员", `M32成员团队-${runId}`);
    member = m.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: memberEmail, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M32项目-${runId}`, code: `m32-${runId.slice(0, 6)}` } });
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const asset = await call("POST", "/assets", {
      session: member, body: { teamId, name: `M32资产-${runId}`, typeVersionId: docTypeId, properties: DOC_PROPS },
    });
    expectOk(asset.status === 201, asset.json, "登记资产失败");
    assetId = asset.json.assetId;
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("成员可见性缺口闭合：管理员按邮箱添加项目成员 → 成员立即可见项目；负例与盖章如实", async () => {
    // 添加前：普通成员看不到该项目（团队资格不等于项目资格）
    const before = await call("GET", "/projects", { session: member });
    expect((before.json as { projectId: string }[]).some((p) => p.projectId === projectId), "添加前成员不应看到项目").toBe(false);

    // 普通成员（非 lead）尝试添加 → 403
    const denied = await call("POST", `/projects/${projectId}/members`, {
      session: member, body: { teamId, email: `m32admin-${runId}@t.dev` },
    });
    expect(denied.status === 403, `普通成员添加应 403，实际 ${denied.status}`).toBe(true);

    // 管理员添加 → 201；重复添加 → 409；陌生邮箱 → 422
    const add = await call("POST", `/projects/${projectId}/members`, { session: admin, body: { teamId, email: memberEmail } });
    expectOk(add.status === 201, add.json, "添加项目成员失败");
    const dupe = await call("POST", `/projects/${projectId}/members`, { session: admin, body: { teamId, email: memberEmail } });
    expect(dupe.status === 409 && dupe.json?.error?.code === "ALREADY_MEMBER", `重复添加应 409：${JSON.stringify(dupe.json)}`).toBe(true);
    const unknown = await call("POST", `/projects/${projectId}/members`, { session: admin, body: { teamId, email: `nobody-${runId}@t.dev` } });
    expect(unknown.status === 422, `陌生邮箱应 422，实际 ${unknown.status}`).toBe(true);

    // 添加后：成员立即看到项目
    const after = await call("GET", "/projects", { session: member });
    expect((after.json as { projectId: string }[]).some((p) => p.projectId === projectId), "添加后成员应看到项目").toBe(true);

    // 审计盖章
    const stamp = await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE action = 'project.member.add' AND object_id = $1`, [projectId]);
      return rows[0] ?? null;
    });
    expectOk(!!stamp, projectId, "project.member.add 审计应落库");
    expect(stamp!.detail.email === memberEmail, `盖章应带邮箱：${JSON.stringify(stamp!.detail)}`).toBe(true);
  });

  it("发布集历史与回滚：两次发布后 is_current 指向最新；非作者管理员回滚 → 通道头回退 + release_rollback 盖章；成员 403", async () => {
    // 两次发布（作者=member，发布人=admin2 非作者）
    const d1 = await createBranchDraftAndCr("第一次发布", "v1");
    const p1 = await call("POST", `/change-requests/${await currentCrId("第一次发布")}/review-and-publish`, {
      session: admin2, body: { teamId, expectedReviewDigest: d1, note: "同意 v1" },
    });
    expectOk(p1.status === 200, p1.json, "第一次发布失败");
    const d2 = await createBranchDraftAndCr("第二次发布", "v2");
    const p2 = await call("POST", `/change-requests/${await currentCrId("第二次发布")}/review-and-publish`, {
      session: admin2, body: { teamId, expectedReviewDigest: d2, note: "同意 v2" },
    });
    expectOk(p2.status === 200, p2.json, "第二次发布失败");
    const firstReleaseSetId = p1.json.releaseSetId as string;

    // 历史列表：两个发布集，is_current 指向最新
    const hist = await call("GET", `/projects/${projectId}/release-sets?teamId=${teamId}&channel=stable`, { session: member });
    expectOk(hist.status === 200, hist.json, "发布集历史读取失败");
    const sets = hist.json.sets as { id: string; kind: string; item_count: number; is_current: boolean }[];
    expect(sets.length === 2, `应有两个发布集，实际 ${sets.length}`).toBe(true);
    expect(sets[0].is_current && !sets[1].is_current, "is_current 应指向最新发布集").toBe(true);
    expect(hist.json.channelId, "应返回 channelId 供回滚调用").toBeTruthy();

    // 普通成员回滚 → 403
    const denied = await call("POST", `/channels/${hist.json.channelId}/rollback`, {
      session: member, body: { teamId, toReleaseSetId: firstReleaseSetId, reason: "成员尝试回滚" },
    });
    expect(denied.status === 403, `成员回滚应 403，实际 ${denied.status}`).toBe(true);

    // 非作者管理员回滚到第一次发布集 → 通道头回退
    const rb = await call("POST", `/channels/${hist.json.channelId}/rollback`, {
      session: admin2, body: { teamId, toReleaseSetId: firstReleaseSetId, reason: "M32 走查：回滚到 v1" },
    });
    expectOk(rb.status === 200, rb.json, "回滚失败");
    const channel = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { session: admin2 });
    const head = (channel.json as { asset_id: string; revision_seq: number }[]).find((h) => h.asset_id === assetId)!;
    expect(head.revision_seq === 2, `回滚后通道头应在 r2，实际 r${head.revision_seq}`).toBe(true);
    const hist2 = await call("GET", `/projects/${projectId}/release-sets?teamId=${teamId}&channel=stable`, { session: admin2 });
    const sets2 = hist2.json.sets as { id: string; kind: string; is_current: boolean }[];
    const rollbackSet = sets2.find((s) => s.kind === "rollback");
    expectOk(!!rollbackSet && rollbackSet.is_current, "回滚集应成为当前头");

    // release_rollback 审计盖章
    const stamp = await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE action = 'release_rollback' ORDER BY created_at DESC LIMIT 1`);
      return rows[0] ?? null;
    });
    expectOk(!!stamp, "release_rollback 审计应落库");
    expect(stamp!.detail.toReleaseSetId === firstReleaseSetId, `盖章应带目标发布集：${JSON.stringify(stamp!.detail)}`).toBe(true);
  });

  // CR 列表里按标题取最新 CR id（列表不含 reviewDigest，digest 由 prepare 返回后已传递）
  async function currentCrId(title: string): Promise<string> {
    const list = await call("GET", `/projects/${projectId}/change-requests?teamId=${teamId}`, { session: admin2 });
    const rows = list.json as { id: string; title: string }[];
    const hit = [...rows].reverse().find((r) => r.title === title);
    expectOk(!!hit, rows.map((r) => r.title), `找不到 CR：${title}`);
    return hit!.id;
  }
});
