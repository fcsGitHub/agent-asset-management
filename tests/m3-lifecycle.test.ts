// M3 集成测试 — 需求基线、任务、测试运行、追踪矩阵、阶段门与结题包。
// 覆盖验收：C02/C03/C04/C05 + 结题包内容校验（C06 数据层）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { Client } from "pg";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4102;
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
}

async function upload(session: Session, teamId: string, content: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
    method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, body: form,
  });
  const json = (await res.json()) as { digest?: string };
  expect(res.status === 201 && !!json.digest, "上传失败").toBe(true);
  return json.digest!;
}

async function withTeamDb<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw" });
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

describe("M3 项目闭环（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session;
  let teamId = "", projectId = "";
  let typeVersionIds: Record<string, string> = {};
  let modelAssetId = "", testAssetId = "";
  let r1 = "", r2 = ""; // 模型修订
  let reqId = "", reqRev1 = "", reqRev2 = "";
  let workItemId = "";
  let testRunId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m3admin-${runId}@t.dev`, password: "password-123", displayName: "结题管理员", teamName: `闭环团队-${runId}` }),
    });
    admin = sessionOf(a); teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m3member-${runId}@t.dev`, password: "password-123", displayName: "闭环成员", teamName: `旁队-${runId}` }),
    });
    member = sessionOf(m);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m3member-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "闭环验证项目", code: `life-${runId}` } });
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    for (const t of types.json as { id: string; type_key: string }[]) typeVersionIds[t.type_key] = t.id;
  });

  afterAll(async () => { await app.close(); });

  it("登记模型与测试资产（r1 / 测试定义）", async () => {
    const d1 = await upload(member, teamId, `m3-model-r1-${runId}`, "model.txt");
    const model = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "闭环模型", typeVersionId: typeVersionIds["simulation.model"],
        properties: { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "v1", validStepSeconds: { min: 0.1, max: 10 } },
        artifacts: [{ digest: d1, role: "implementation", originalName: "model.txt", mediaType: "text/plain", size: 30 }] },
    });
    expectOk(model.status === 201, model.json, "模型登记失败");
    modelAssetId = model.json.assetId; r1 = model.json.revisionId;

    const d2 = await upload(member, teamId, `m3-test-${runId}`, "test.txt");
    const test = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "闭环回归测试集", typeVersionId: typeVersionIds["test.suite"],
        properties: { testTarget: "v1", execProtocol: "pytest-v1", fixtureVersion: "fx-1", passThreshold: 1 },
        artifacts: [{ digest: d2, role: "implementation", originalName: "test.txt", mediaType: "text/plain", size: 30 }] },
    });
    expectOk(test.status === 201, test.json, "测试登记失败");
    testAssetId = test.json.assetId;
  });

  it("需求创建（R-1）与修订演进（r1→r2）", async () => {
    const req = await call("POST", `/projects/${projectId}/requirements`, {
      session: admin,
      body: { teamId, reqKey: `R-${runId.slice(0, 4)}`, title: "接口输入输出符合约定",
        description: "输入姿态、输出位置", acceptanceCriteria: "回归测试通过且摘要匹配", priority: "must", isKey: true },
    });
    expectOk(req.status === 201, req.json, "需求创建失败");
    reqId = req.json.requirementId; reqRev1 = req.json.revisionId;
    const rev2 = await call("POST", `/requirements/${reqId}/revisions`, {
      session: admin, body: { teamId, description: "输入姿态、输出位置（补充坐标系 ECI）", acceptanceCriteria: "回归测试通过且摘要匹配" },
    });
    expectOk(rev2.status === 201, rev2.json, "需求修订失败");
    reqRev2 = rev2.json.revisionId;
  });

  it("需求基线快照：固化当前修订", async () => {
    const bl = await call("POST", `/projects/${projectId}/requirement-baseline`, {
      session: admin, body: { teamId, name: "BL-1 需求基线" },
    });
    expectOk(bl.status === 201, bl.json, "基线失败");
  });

  it("任务创建（覆盖需求 r2 + 交付模型修订）与状态推进", async () => {
    // 模型先产生 r2（分支草稿）
    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `impl-${runId}` } });
    const d = await upload(member, teamId, `m3-model-r2-${runId}`, "model2.txt");
    const save = await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member,
      body: { teamId, assetId: modelAssetId, properties: { interfaceVersion: "v2" },
        artifacts: [{ digest: d, role: "implementation", originalName: "model2.txt", mediaType: "text/plain", size: 30 }] },
    });
    expectOk(save.status === 201, save.json, "草稿保存失败");
    r2 = save.json.revisionId;

    const wi = await call("POST", `/projects/${projectId}/work-items`, {
      session: member,
      body: { teamId, title: "实现并交付接口 v2", assigneeId: (await call("GET", "/auth/me", { session: member })).json.userId,
        completionEvidence: "回归测试通过截图+运行记录",
        requirementRevisionIds: [reqRev2],
        deliverables: [{ assetId: modelAssetId, revisionId: r2 }] },
    });
    expectOk(wi.status === 201, wi.json, "任务创建失败");
    workItemId = wi.json.workItemId;

    // 依赖链：B→A，C→B，D→[C,A]。创建期依赖边只指向既有任务，
    // 环在结构上不可能形成（后端仍有 DFS 兜底）；此处如实验证链的持久化。
    const wi2 = await call("POST", `/projects/${projectId}/work-items`, {
      session: member, body: { teamId, title: "任务B", dependsOnIds: [workItemId] },
    });
    const chain = await call("POST", `/projects/${projectId}/work-items`, {
      session: member, body: { teamId, title: "任务C", dependsOnIds: [wi2.json.workItemId] },
    });
    const chainEnd = await call("POST", `/projects/${projectId}/work-items`, {
      session: member, body: { teamId, title: "任务D", dependsOnIds: [chain.json.workItemId, workItemId] },
    });
    expectOk(chainEnd.status === 201, chainEnd.json, "依赖链创建失败");
    await withTeamDb(teamId, async (cx) => {
      const { rows: deps } = await cx.query<{ work_item_id: string; depends_on_id: string }>(
        `SELECT work_item_id, depends_on_id FROM work_item_deps WHERE team_id = $1 AND work_item_id = $2 ORDER BY depends_on_id`,
        [teamId, chainEnd.json.workItemId]
      );
      expect(deps.length === 2, `任务D应有两条依赖边，实际 ${deps.length}`).toBe(true);
      expect(deps.some((d) => d.depends_on_id === chain.json.workItemId) && deps.some((d) => d.depends_on_id === workItemId), "依赖边指向错误").toBe(true);
    });

    // 任务完成 ≠ 验收通过（C03 反例流程）
    const done = await call("POST", `/work-items/${workItemId}/status`, { session: member, body: { teamId, status: "done" } });
    expectOk(done.status === 200, done.json, "任务完成失败");
    const matrix0 = await call("GET", `/projects/${projectId}/traceability?teamId=${teamId}`, { session: admin });
    const row0 = matrix0.json.find((m: any) => m.requirement.id === reqId);
    expect(row0.acceptance === null, "任务完成后不应自动出现验收记录").toBe(true);
  });

  it("测试运行：先失败后通过（证据绑定精确修订）", async () => {
    const failRun = await call("POST", `/projects/${projectId}/test-runs`, {
      session: member,
      body: { teamId, testAssetId, testRevisionId: testAssetId, targetAssetId: modelAssetId, targetRevisionId: r2,
        result: "fail", environment: "linux-ci", summary: "边界样本失败" },
    });
    expectOk(failRun.status === 201, failRun.json, "失败运行记录失败");

    // 失败运行不能作为 pass 验收证据
    const badAcc = await call("POST", `/projects/${projectId}/acceptance`, {
      session: admin, body: { teamId, requirementRevisionId: reqRev2, verdict: "pass", evidenceRunId: failRun.json.testRunId },
    });
    expect(badAcc.status === 422, "失败证据应被拒绝").toBe(true);

    const passRun = await call("POST", `/projects/${projectId}/test-runs`, {
      session: member,
      body: { teamId, testAssetId, testRevisionId: testAssetId, targetAssetId: modelAssetId, targetRevisionId: r2,
        result: "pass", environment: "linux-ci", summary: "全部用例通过" },
    });
    expectOk(passRun.status === 201, passRun.json, "通过运行记录失败");
    testRunId = passRun.json.testRunId;
  });

  it("C04：制品更新后旧证据失效，未重新验证阻止结题", async () => {
    // 先用 r2 证据做 pass 验收
    const acc = await call("POST", `/projects/${projectId}/acceptance`, {
      session: admin, body: { teamId, requirementRevisionId: reqRev2, verdict: "pass", evidenceRunId: testRunId },
    });
    expectOk(acc.status === 201, acc.json, "验收失败");

    // 结题门：应通过（证据与当前制品头一致）
    const gate1 = await call("POST", `/projects/${projectId}/gate-reviews`, { session: admin, body: { teamId, gate: "closure" } });
    expectOk(gate1.status === 201 && gate1.json.verdict === "pass", gate1.json, "证据一致时结题门应通过");

    // 制品被更新（模型 r3），需求未变
    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `post-evidence-${runId}` } });
    const d3 = await upload(member, teamId, `m3-model-r3-${runId}`, "model3.txt");
    await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: member,
      body: { teamId, assetId: modelAssetId, properties: { interfaceVersion: "v3" },
        artifacts: [{ digest: d3, role: "implementation", originalName: "model3.txt", mediaType: "text/plain", size: 30 }] },
    });
    const gate2 = await call("POST", `/projects/${projectId}/gate-reviews`, { session: admin, body: { teamId, gate: "closure" } });
    expect(gate2.status === 201 && gate2.json.verdict === "blocked", "制品更新后结题门应阻塞").toBe(true);
    expect(JSON.stringify(gate2.json.blockers)).toContain("证据失效", gate2.json);
  });

  it("C05：关键需求缺验收阻止结题；豁免需管理员+原因+期限且可见", async () => {
    // 新增一条关键需求，无验收
    const req2 = await call("POST", `/projects/${projectId}/requirements`, {
      session: admin, body: { teamId, reqKey: `R-${runId.slice(4, 8)}b`, title: "指定范围内稳定运行", priority: "must", isKey: true },
    });
    expectOk(req2.status === 201, req2.json, "需求创建失败");

    const gate1 = await call("POST", `/projects/${projectId}/gate-reviews`, { session: admin, body: { teamId, gate: "closure" } });
    expect(gate1.json.verdict === "blocked", "缺验收应阻塞").toBe(true);
    expect(JSON.stringify(gate1.json.blockers)).toContain("没有任何验收记录", gate1.json);

    // 成员不能记录豁免
    const waiveByMember = await call("POST", `/projects/${projectId}/acceptance`, {
      session: member, body: { teamId, requirementRevisionId: req2.json.revisionId, verdict: "waived", reason: "x",
        waiverExpiresAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(waiveByMember.status === 403, "成员豁免应 403").toBe(true);

    // 管理员豁免（带期限），缺原因被拒
    const waiveNoReason = await call("POST", `/projects/${projectId}/acceptance`, {
      session: admin, body: { teamId, requirementRevisionId: req2.json.revisionId, verdict: "waived",
        waiverExpiresAt: new Date(Date.now() + 86400000).toISOString() },
    });
    expect(waiveNoReason.status === 422, "豁免缺原因应 422").toBe(true);

    const waive = await call("POST", `/projects/${projectId}/acceptance`, {
      session: admin, body: { teamId, requirementRevisionId: req2.json.revisionId, verdict: "waived",
        reason: "边界条件在运行环境不可复现，列入后续任务", waiverExpiresAt: new Date(Date.now() + 7 * 86400000).toISOString() },
    });
    expectOk(waive.status === 201, waive.json, "豁免失败");
  });

  it("C02：追踪矩阵由真实数据生成（需求→任务→测试→验收）", async () => {
    const matrix = await call("GET", `/projects/${projectId}/traceability?teamId=${teamId}`, { session: admin });
    expectOk(matrix.status === 200, matrix.json, "矩阵获取失败");
    const row = matrix.json.find((m: any) => m.requirement.id === reqId);
    expectOk(!!row, matrix.json, "矩阵缺行");
    expect(row.workItems.length >= 1 && row.workItems[0].title === "实现并交付接口 v2", "任务链缺失").toBe(true);
    expect(row.workItems[0].deliverables && row.workItems[0].deliverables[0].revisionId === r2, "交付物链缺失").toBe(true);
    expect(row.testRuns.length >= 1, "测试链缺失").toBe(true);
    expect(row.testRuns[0].evidence_current === false, "r3 之后旧证据应标记为过期").toBe(true);
    expect(row.acceptance.verdict === "pass", "验收链缺失").toBe(true);
  });

  it("C06：结题包数据完整（基线/绑定/发布/豁免/遗留）", async () => {
    const pkg = await call("GET", `/projects/${projectId}/closure-package?teamId=${teamId}`, { session: admin });
    expectOk(pkg.status === 200, pkg.json, "结题包失败");
    expect(pkg.json.requirementBaselines.length >= 1, "缺基线").toBe(true);
    expect(pkg.json.gateReviews.length >= 2, "缺阶段门记录").toBe(true);
    expect(pkg.json.waivers.length === 1 && pkg.json.waivers[0].approver, "豁免留痕缺失").toBeTruthy();
    expect(pkg.json.assetBindings !== undefined && pkg.json.openIssues !== undefined, "包字段缺失").toBe(true);
  });
});
