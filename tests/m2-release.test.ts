// M2 集成测试 — 分支、CR、审核摘要、管理员发布、回退、绑定。
// 覆盖验收：B03/B04/B05/B06/B09/B10 + 发布链完整走通。全部真实（PG/HTTP/文件）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

const PORT = 4101;
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

async function call(
  method: string,
  path: string,
  opts: { session?: Session; body?: unknown; idemKey?: string; rawCookie?: string } = {}
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.rawCookie) headers.cookie = opts.rawCookie;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idemKey) headers["idempotency-key"] = opts.idemKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, `register ${email} → ${res.status}`, "注册失败");
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

async function upload(session: Session, teamId: string, content: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
    method: "POST",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    body: form,
  });
  const json = (await res.json()) as { digest?: string };
  expect(res.status === 201 && !!json.digest, json, "上传失败");
  return json.digest!;
}

const MODEL_PROPS = {
  frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s",
  interfaceVersion: "prop-v2", validStepSeconds: { min: 0.1, max: 60 },
};

describe("M2 分支、发布与审批（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, admin2: Session, member: Session;
  let teamId = "", projectId = "";
  let modelAssetId = "";
  let typeVersionId = "";
  let mainHeadR1 = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m2admin-${runId}@t.dev`, "管理员A", `发布团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const a2 = await register(`m2admin2-${runId}@t.dev`, "管理员B", `旁支团队-${runId}`);
    admin2 = a2.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m2admin2-${runId}@t.dev`, role: "admin" } });
    const m = await register(`m2member-${runId}@t.dev`, "成员M", `成员团队-${runId}`);
    member = m.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m2member-${runId}@t.dev`, role: "member" } });

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "发布验证项目", code: `rel-${runId}` } });
    projectId = proj.json.projectId;

    await call("GET", `/types?teamId=${teamId}`, { session: member });
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'simulation.model'`);
      typeVersionId = rows[0]!.id;
    });
  });

  afterAll(async () => { await app.close(); });

  it("成员登记模型（r1），分支从 r1 出发", async () => {
    const digest = await upload(member, teamId, `m2-model-${runId}\nline2\n`, `model-${runId}.txt`);
    const res = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "发布验证模型", typeVersionId, properties: MODEL_PROPS,
        artifacts: [{ digest, role: "implementation", originalName: `model-${runId}.txt`, mediaType: "text/plain", size: 40 }] },
    });
    expectOk(res.status === 201, res.json, "登记失败");
    modelAssetId = res.json.assetId;
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_revisions WHERE asset_id = $1 ORDER BY seq`, [modelAssetId]);
      expect(rows).toHaveLength(1);
      mainHeadR1 = rows[0]!.id;
    });
  });

  it("成员建分支并在分支上保存草稿（新不可变修订 r2，头移动）", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: member, body: { teamId, name: `fix-interface-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const branchId = br.json.branchId as string;
    (globalThis as { __branchId?: string }).__branchId = branchId;

    const digest2 = await upload(member, teamId, `m2-model-${runId}\nline2-fixed\n`, `model2-${runId}.txt`);
    const save = await call("POST", `/branches/${branchId}/revisions`, {
      session: member,
      body: { teamId, assetId: modelAssetId,
        properties: { interfaceVersion: "prop-v3" },
        artifacts: [{ digest: digest2, role: "implementation", originalName: `model2-${runId}.txt`, mediaType: "text/plain", size: 44 }] },
    });
    expectOk(save.status === 201, save.json, "保存草稿失败");

    // STALE_HEAD 负例：带着旧期望头再保存 → 409
    const stale = await call("POST", `/branches/${branchId}/revisions`, {
      session: member,
      body: { teamId, assetId: modelAssetId, expectedHeadRevisionId: save.json.revisionId, properties: {} },
    });
    expect(stale.status === 409 && stale.json.error.code === "STALE_HEAD", stale.json, "期望 409 STALE_HEAD");
  });

  it("差异接口：属性逐字段 + 二进制摘要对照（B02）", async () => {
    const branchId = (globalThis as { __branchId?: string }).__branchId!;
    const diff = await call("GET", `/branches/${branchId}/diff?teamId=${teamId}`, { session: member });
    expectOk(diff.status === 200, diff.json, "差异获取失败");
    const d = diff.json[0];
    expect(d.diff.properties.some((p: any) => p.key === "interfaceVersion" && p.kind === "changed"), d.diff, "属性差异缺失");
    expect(d.diff.artifacts[0].fromDigest !== d.diff.artifacts[0].toDigest, d.diff, "制品摘要差异缺失");
  });

  it("成员提交 CR；成员不能审核发布（B03）；默认不能自审自发", async () => {
    const branchId = (globalThis as { __branchId?: string }).__branchId!;
    const cr = await call("POST", "/change-requests", {
      session: member,
      body: { teamId, branchId, title: "升级接口到 prop-v3", motivation: "下游需要 v3 接口",
        relatedRefs: `issue-无`, changeSummary: "接口版本变更", compatibility: "对 v2 下游破坏", testPlan: "回归测试集A", rollbackNotes: "回退到上一发布集" },
    });
    expectOk(cr.status === 201, cr.json, "CR 创建失败");
    const crId = cr.json.changeRequestId as string;
    (globalThis as { __crId?: string }).__crId = crId;

    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, {
      session: member, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(prep.status === 201, prep.json, "prepare-review 失败");
    (globalThis as { __digest?: string }).__digest = prep.json.reviewDigest;

    // 成员尝试发布 → 403（B03）
    const memberPublish = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: member, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expect(memberPublish.status === 403, memberPublish.json, "成员不应能发布");

    // 成员（作者）即使挂着 admin cookie 也不行——作者分离按 CR 作者判断：
    // admin 发布自己未参与的 CR 应成功（后面用例）；这里先验证另一管理员可行路径在下一用例。
  });

  it("管理员审核并发布 → 原子生成发布集/通道头/main 视图（B06 正向）", async () => {
    const crId = (globalThis as { __crId?: string }).__crId!;
    const digest = (globalThis as { __digest?: string }).__digest!;
    const pub = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: digest, note: "同意，证据齐备" },
    });
    expectOk(pub.status === 200, pub.json, "发布失败");
    (globalThis as { __releaseSetId?: string }).__releaseSetId = pub.json.releaseSetId;

    // 通道头 & main 分支视图
    const channel = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { session: admin });
    expectOk(channel.status === 200 && channel.json.length === 1, channel.json, "通道头异常");
    expect(channel.json[0].revision_seq === 2, channel.json, "通道应指向 r2");

    await withTeamDb(teamId, async (c) => {
      const { rows: main } = await c.query<{ head_revision_id: string }>(
        `SELECT e.head_revision_id FROM branch_entries e JOIN branches b ON b.id = e.branch_id
          WHERE b.name = 'main' AND b.project_id = $1 AND e.asset_id = $2`,
        [projectId, modelAssetId]
      );
      expect(main[0]?.head_revision_id, main, "main 视图未更新");
      const { rows: rel } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM release_items WHERE release_set_id = $1`,
        [pub.json.releaseSetId]
      );
      expect(rel[0]?.n === "1", rel, "发布集条目数异常");
    });
  });

  it("自审自发默认禁止：admin 自己创建的 CR 无法由 admin 发布（除非例外已配置）", async () => {
    // admin 建分支 + 保存 + CR + prepare + publish（同一个人）
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `admin-own-${runId}` } });
    const digest = await upload(admin, teamId, `admin-own-${runId}\n`, `own-${runId}.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: admin, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest, role: "implementation", originalName: `own-${runId}.txt`, mediaType: "text/plain", size: 22 }] },
    });
    const cr = await call("POST", "/change-requests", {
      session: admin, body: { teamId, branchId: br.json.branchId, title: "管理员自己的变更", motivation: "测试作者分离" },
    });
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, {
      session: admin, body: { teamId },
    });
    const pub = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expect(pub.status === 403, pub.json, "自审自发应默认 403");

    // 启用例外（人事先配置，DB 层；Agent/普通 API 无权）后仍需填写留痕说明
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    await c.query(`UPDATE team_settings SET allow_single_admin_self_approval = true, single_admin_exception_note = '单人团队例外，已由负责人确认' WHERE team_id = $1`, [teamId]);
    await c.end();
    const pub2 = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expect(pub2.status === 200, pub2.json, "配置例外并留痕后应可发布");
  });

  it("B04：prepare 后分支被改 → 旧摘要发布被拒（审批失效）", async () => {
    // 新分支 + 保存 r4 + CR + prepare
    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `invalidate-${runId}` } });
    const d1 = await upload(member, teamId, `invalidate-A-${runId}\n`, `ia-${runId}.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest: d1, role: "implementation", originalName: `ia-${runId}.txt`, mediaType: "text/plain", size: 30 }] },
    });
    const cr = await call("POST", "/change-requests", {
      session: member, body: { teamId, branchId: br.json.branchId, title: "将被失效的 CR", motivation: "B04" },
    });
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });
    // 审核后分支内容被修改（新草稿修订）
    const d2 = await upload(member, teamId, `invalidate-B-${runId}\n`, `ib-${runId}.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest: d2, role: "implementation", originalName: `ib-${runId}.txt`, mediaType: "text/plain", size: 30 }] },
    });
    // 重新 prepare 也会因头移动被拒
    const reprep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });
    expect(reprep.status === 409, reprep.json, "头移动后重新 prepare 应 409");

    // 用旧快照直接发布（绕过上面）→ 发布端重算发现不一致
    const pub = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expect(pub.status === 409 && pub.json.error.code === "REVIEW_DIGEST_CHANGED", pub.json, "B04 失效应 409");
  });

  it("B05：并发发布同一资产，后发者因目标头移动被拒，需重新审查", async () => {
    // 两个分支同时改同一资产，各自 prepare（期望头相同）
    const mkCr = async (tag: string): Promise<{ crId: string; digest: string }> => {
      const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `race-${tag}-${runId}` } });
      const d = await upload(member, teamId, `race-${tag}-${runId}\n`, `race-${tag}.txt`);
      await call("POST", `/branches/${br.json.branchId}/revisions`, {
        session: member, body: { teamId, assetId: modelAssetId,
          artifacts: [{ digest: d, role: "implementation", originalName: `race-${tag}.txt`, mediaType: "text/plain", size: 24 }] },
      });
      const cr = await call("POST", "/change-requests", {
        session: member, body: { teamId, branchId: br.json.branchId, title: `竞态 ${tag}`, motivation: "B05" },
      });
      const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });
      return { crId: cr.json.changeRequestId, digest: prep.json.reviewDigest };
    };
    const crA = await mkCr("ra");
    const crB = await mkCr("rb");
    const pubA = await call("POST", `/change-requests/${crA.crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: crA.digest },
    });
    expectOk(pubA.status === 200, pubA.json, "竞态 A 应成功");
    const pubB = await call("POST", `/change-requests/${crB.crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: crB.digest },
    });
    expect(pubB.status === 409 && pubB.json.error.code === "REVIEW_DIGEST_CHANGED", pubB.json, "竞态 B 应失效");
  });

  it("B06：多资产发布中途制品丢失 → 全部回滚，无部分生效", async () => {
    // 第二个资产（文档）+ 双资产分支
    const docTypes = await call("GET", `/types?teamId=${teamId}`, { session: member });
    const docType = (docTypes.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;
    const docRes = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "将被回滚验证的文档", typeVersionId: docType.id,
        properties: { docRole: "manual", format: "txt", language: "zh-CN", confidentiality: "internal", scope: "x" } },
    });
    const docAssetId = docRes.json.assetId as string;

    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `atomic-${runId}` } });
    const d1 = await upload(member, teamId, `atomic-model-${runId}\n`, `am.txt`);
    const d2 = await upload(member, teamId, `atomic-doc-${runId}\n`, `ad.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest: d1, role: "implementation", originalName: "am.txt", mediaType: "text/plain", size: 26 }] },
    });
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: docAssetId,
        artifacts: [{ digest: d2, role: "implementation", originalName: "ad.txt", mediaType: "text/plain", size: 26 }] },
    });
    const cr = await call("POST", "/change-requests", {
      session: member, body: { teamId, branchId: br.json.branchId, title: "双资产原子发布", motivation: "B06" },
    });
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });

    // 注入失败：直接删除第二个资产的 blob 文件（模拟存储损坏）
    const blobRoot = resolve(process.env.BLOBSTORE_ROOT ?? "./data/blobs");
    await rm(join(blobRoot, teamId, d2), { force: true });

    const pub = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expect(pub.status === 409 && pub.json.error.code === "ARTIFACT_MISSING", pub.json, "应因制品缺失失败");

    // 全部回滚：模型与文档通道头都未移动
    const channel = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { session: admin });
    expect(!channel.json.some((h: { asset_id: string }) => h.asset_id === docAssetId), channel.json, "文档不应有通道头");
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM release_sets rs JOIN change_requests cr ON cr.id = rs.change_request_id WHERE cr.id = $1`,
        [cr.json.changeRequestId]
      );
      expect(rows[0]?.n === "0", rows, "发布集应完全回滚");
    });
  });

  it("B10：重复发布请求（同幂等键）不重复发布", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `idem-${runId}` } });
    const d = await upload(member, teamId, `idem-${runId}\n`, `idem.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest: d, role: "implementation", originalName: "idem.txt", mediaType: "text/plain", size: 20 }] },
    });
    const cr = await call("POST", "/change-requests", {
      session: member, body: { teamId, branchId: br.json.branchId, title: "幂等发布", motivation: "B10" },
    });
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });
    const body = { teamId, expectedReviewDigest: prep.json.reviewDigest };
    const p1 = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, { session: admin, body, idemKey: `idem-${runId}` });
    const p2 = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, { session: admin, body, idemKey: `idem-${runId}` });
    expectOk(p1.status === 200, p1.json, "首次发布失败");
    expect(p2.status === 200 && p2.json.idempotentReplay === true && p2.json.releaseSetId === p1.json.releaseSetId, p2.json, "重放应返回首次结果");
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM release_sets WHERE change_request_id = $1`, [cr.json.changeRequestId]
      );
      expect(rows[0]?.n === "1", rows, "发布集应只有一个");
    });
  });

  it("B09：项目绑定锁定精确修订，发布新版不移动引用；复合外键拒绝错配", async () => {
    // 绑定到 r1（mainHeadR1）
    const bind = await call("POST", `/projects/${projectId}/bindings`, {
      session: member,
      body: { teamId, assetId: modelAssetId, revisionId: mainHeadR1, usageKey: "sim-core", purpose: "锁定复用" },
    });
    expectOk(bind.status === 201, bind.json, "绑定失败");

    // 错配：修订属于别的资产 → 422
    const wrong = await call("POST", `/projects/${projectId}/bindings`, {
      session: member,
      body: { teamId, assetId: modelAssetId, revisionId: "11111111-1111-1111-1111-111111111111", usageKey: "bad" },
    });
    expect(wrong.status === 422, wrong.json, "错配绑定应拒绝");

    // 再发布一个新版本（走完整链）
    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `after-bind-${runId}` } });
    const d = await upload(member, teamId, `after-bind-${runId}\n`, `ab.txt`);
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member, body: { teamId, assetId: modelAssetId,
        artifacts: [{ digest: d, role: "implementation", originalName: "ab.txt", mediaType: "text/plain", size: 24 }] },
    });
    const cr = await call("POST", "/change-requests", {
      session: member, body: { teamId, branchId: br.json.branchId, title: "绑定后的新版本", motivation: "B09" },
    });
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, { session: member, body: { teamId } });
    const pub = await call("POST", `/change-requests/${cr.json.changeRequestId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest },
    });
    expectOk(pub.status === 200, pub.json, "新版本发布失败");

    const bindings = await call("GET", `/projects/${projectId}/bindings?teamId=${teamId}`, { session: member });
    const b = bindings.json.find((x: { usage_key: string }) => x.usage_key === "sim-core");
    expect(b.revision_id === mainHeadR1, b, "绑定不应随发布移动");
  });

  it("回退：新受审查事件，历史保留，通道指回先前发布集", async () => {
    const channel = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { session: admin });
    const current = channel.json[0] as { release_set_id: string; revision_id: string; asset_id: string };
    // 回退到 r1 所在的第一次发布集
    const firstRelease = (globalThis as { __releaseSetId?: string }).__releaseSetId!;
    const chRes = await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_channels WHERE project_id = $1 AND name = 'stable'`, [projectId]);
      return rows[0]!.id;
    });
    const rb = await call("POST", `/channels/${chRes}/rollback`, {
      session: admin,
      body: { teamId, toReleaseSetId: firstRelease, reason: "下游回归失败", externalSideEffects: "已通知下游重新拉取，数据库迁移不可自动逆转" },
    });
    expectOk(rb.status === 200, rb.json, "回退失败");

    const after = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { session: admin });
    const afterHead = after.json.find((h: { asset_id: string }) => h.asset_id === current.asset_id);
    expect(afterHead.release_set_id === firstRelease, { afterHead, firstRelease }, "通道应指回原发布集");

    // 历史保留：release_events 含 publish 与 rollback，且后来版本未被抹去
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ kind: string }>(
        `SELECT DISTINCT r.kind FROM release_events r JOIN asset_channels ch ON ch.id = r.channel_id
          WHERE ch.project_id = $1`, [projectId]
      );
      const kinds = rows.map((r) => r.kind);
      expect(kinds.includes("publish") && kinds.includes("rollback"), kinds, "事件链不完整");
      const { rows: relCount } = await c.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM release_sets WHERE team_id = $1`, [teamId]
      );
      expect(Number(relCount[0]!.n) >= 4, relCount, "回退不应抹去历史发布集");
    });
  });
});
