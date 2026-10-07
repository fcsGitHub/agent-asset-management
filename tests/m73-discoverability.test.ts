// M73 可发现性与会话体验轮集成测试（真实 PostgreSQL + 真实网关，无 mock）：
// ①issue.list 工具：默认未结（open+in_progress），resolved 不出现；status=all 全量；
//   q 关键词命中标题/正文；q 含 % 按字面量匹配（m72 LIKE 口径）不恒真。
// ②collection.items 工具：条目带 note/类型/生命周期；集合按名称解析；不存在集合如实报错。
// ③会话占位标题：无 title 创建 → 「会话 MM-DD HH:mm」，DB title_is_auto=true。
// ④首条运行自动命名：prompt 首行截 24 字加省略号，title_is_auto 置 false；
//   显式命名的会话运行后标题不变（条件更新不覆盖）。
// ⑤PATCH 显式改名接管命名权：改后 title_is_auto=false，再发运行不再改写。
// ⑥overview 新字段：弃用计数单列（active 不再混入 deprecated）、待审提案/语义候选计数。
// ⑦allowed_tools 留档快照与真实工具清单同源（含本轮新增工具）。
// ⑧纯函数：sessionTitleFromPrompt 取首行/折空白/截断/空回退；autoSessionTitle 格式。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";
import { newCallId } from "../apps/api/src/agent/runner";
import { sessionTitleFromPrompt, autoSessionTitle } from "../apps/api/src/routes/projects";
import { withTeam } from "../apps/api/src/db";

const PORT = 4193;
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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
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

async function readInTeam<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
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
  expect(res.status === 201, `注册失败 ${res.status}`).toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M73 会话自动标题纯函数", () => {
  it("sessionTitleFromPrompt：取首个非空行、折叠空白、超 24 字截断加省略号、全空白回退", () => {
    expect(sessionTitleFromPrompt("请检索轨道分析资产\n第二行不算")).toBe("请检索轨道分析资产");
    expect(sessionTitleFromPrompt("  多   个 空白  \n\t下一行 ")).toBe("多 个 空白");
    const long = "这是一条非常长的任务描述远远超过二十四个字的边界应该被截断并附加省略号结尾";
    expect(long.length).toBeGreaterThan(24);
    const t = sessionTitleFromPrompt(long);
    expect(t.length).toBe(25); // 24 字 + …
    expect(t.endsWith("…")).toBe(true);
    expect(t.slice(0, 24)).toBe(long.slice(0, 24));
    expect(sessionTitleFromPrompt("   \n  \n")).toBe("新任务");
  });

  it("autoSessionTitle：占位格式「会话 MM-DD HH:mm」（本地时间，两位补零）", () => {
    expect(autoSessionTitle(new Date(2026, 9, 7, 8, 5))).toBe("会话 10-07 08:05");
    expect(autoSessionTitle(new Date(2026, 11, 31, 23, 59))).toBe("会话 12-31 23:59");
  });
});

describe("M73 可发现性与会话体验（真实端到端）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let adminUserId = "";
  let teamId = "", projectId = "";
  let assetA = "", assetB = "";
  let autoSessionId = "", namedSessionId = "", renamedSessionId = "";
  let autoSessionPlaceholder = "";
  // 工具网关留痕外键指向 agent_runs：与 m50 同款真实运行行
  let toolRunRowId = "";

  async function invokeAs(name: string, args: unknown, projectIdCtx: string): Promise<{ status: string; result?: unknown; error?: string }> {
    return readInTeam(teamId, async (client) =>
      invokeTool(
        client,
        { teamId, userId: adminUserId, projectId: projectIdCtx, runId: toolRunRowId },
        allAgentTools(),
        newCallId(),
        name,
        JSON.stringify(args)
      )
    );
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m73-${runId}@t.dev`, "M73管理员", `M73可发现性团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const me = await call("GET", "/auth/me", { session: admin });
    adminUserId = me.json.userId as string;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M73项目-${runId}`, code: `m73${runId.slice(0, 6)}` } });
    projectId = proj.json.projectId;

    // 两个资产（后续：集合条目、弃用计数）
    const t = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m73.doc.${runId}`, version: "1.0.0", title: "M73文档",
              jsonSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    });
    const typeId = t.json.typeVersionId as string;
    const mk = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: typeId, properties: { name } } });
      expectOk(r.status === 201, r.json, `建资产 ${name} 失败`);
      return r.json.assetId as string;
    };
    assetA = await mk(`M73轨道分析-${runId}`);
    assetB = await mk(`M73热控报告-${runId}`);

    // 三个工单：open / in_progress / resolved（issue.list 默认只看未结）
    await seedInTeam(teamId, async (c) => {
      for (const [title, body, status] of [
        [`登录页导出报错-${runId}`, "导出 CSV 时 500，含 % 符号的文件名", "open"],
        [`图谱偶发超时-${runId}`, "邻域深度 3 偶发超时", "in_progress"],
        [`别名重复已修复-${runId}`, "重名别名已合并", "resolved"],
      ] as const) {
        await c.query(
          `INSERT INTO issues (team_id, id, project_id, title, body, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [teamId, randomUUID(), projectId, title, body, status, adminUserId]
        );
      }
    });

    // 集合 + 条目（一条带收录备注）
    const col = await call("POST", "/collections", { session: admin, body: { teamId, name: `M73新人入门包-${runId}`, description: "新人起步" } });
    expectOk(col.status === 201, col.json, "建集合失败");
    await call("POST", `/collections/${col.json.collectionId}/items`, { session: admin, body: { teamId, assetId: assetA, note: "作为轨道分析的权威起点" } });
    await call("POST", `/collections/${col.json.collectionId}/items`, { session: admin, body: { teamId, assetId: assetB } });

    // 三个会话：自动标题 / 显式命名 / 建后改名
    const s1 = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, visibility: "project" } });
    expectOk(s1.status === 201, s1.json, "无 title 建会话失败");
    autoSessionId = s1.json.sessionId;
    autoSessionPlaceholder = s1.json.title as string;
    const s2 = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: `显式命名-${runId}`, visibility: "project" } });
    namedSessionId = s2.json.sessionId;
    const s3 = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, visibility: "project" } });
    renamedSessionId = s3.json.sessionId;

    // 工具网关留痕行（tool_invocations.run_id 外键，同 m50）
    toolRunRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,'M73 工具验证', $5, $6, $7, 'deepseek', $8)`,
        [teamId, toolRunRowId, autoSessionId, projectId,
         JSON.stringify([]), JSON.stringify(allAgentTools().map((t) => t.name)),
         JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), adminUserId]
      );
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("③无 title 创建会话 → 占位标题 + title_is_auto=true", async () => {
    expect(new RegExp(`^会话 \\d{2}-\\d{2} \\d{2}:\\d{2}$`).test(autoSessionPlaceholder), `占位标题格式（实际 ${autoSessionPlaceholder}）`).toBe(true);
    const db = await readInTeam(teamId, async (c) =>
      c.query<{ title_is_auto: boolean }>(`SELECT title_is_auto FROM sessions WHERE id = $1`, [autoSessionId])
    );
    expect(db.rows[0]!.title_is_auto, "DB 标记自动命名").toBe(true);
    // 列表带 titleIsAuto 字段（前端据此渲染占位样式）
    const list = (await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin })).json as { sessionId: string; titleIsAuto?: boolean }[];
    expect(list.find((s) => s.sessionId === autoSessionId)?.titleIsAuto, "列表 titleIsAuto=true").toBe(true);
  });

  it("①issue.list：默认未结、status=all、q 过滤、% 按字面量", async () => {
    const dflt = await invokeAs("issue.list", {}, projectId);
    expect(dflt.status, `issue.list 默认 ${JSON.stringify(dflt.error ?? "")}`).toBe("ok");
    const dfltTitles = ((dflt.result as { issues: { title: string }[] }).issues ?? []).map((i) => i.title);
    expect(dfltTitles.some((t) => t.includes(`导出报错-${runId}`)), "open 在列").toBe(true);
    expect(dfltTitles.some((t) => t.includes(`超时-${runId}`)), "in_progress 在列").toBe(true);
    expect(dfltTitles.some((t) => t.includes(`已修复-${runId}`)), "resolved 默认不出现").toBe(false);

    const all = await invokeAs("issue.list", { status: "all" }, projectId);
    const allTitles = ((all.result as { issues: { title: string }[] }).issues ?? []).map((i) => i.title);
    expect(allTitles.some((t) => t.includes(`已修复-${runId}`)), "status=all 含 resolved").toBe(true);

    const byQ = await invokeAs("issue.list", { q: "超时" }, projectId);
    const qTitles = ((byQ.result as { issues: { title: string }[] }).issues ?? []).map((i) => i.title);
    expect(qTitles.length === 1 && qTitles[0]!.includes(`超时-${runId}`), "q 唯一命中").toBe(true);

    // m72 口径：q 含 % 是字面量，不再充当通配符
    const pct = await invokeAs("issue.list", { q: "超时%" }, projectId);
    const pctCount = ((pct.result as { issues: unknown[] }).issues ?? []).length;
    expect(pctCount === 0, `% 字面量不再恒真命中`).toBe(true);
  });

  it("②collection.items：条目带备注/类型/生命周期；幽灵集合如实报错", async () => {
    const ok = await invokeAs("collection.items", { collection: `M73新人入门包-${runId}` }, projectId);
    expect(ok.status, `collection.items ${JSON.stringify(ok.error ?? "")}`).toBe("ok");
    const r = ok.result as { collectionName: string; count: number; items: { id: string; note: string; type_key: string; lifecycle: string }[] };
    expect(r.collectionName).toBe(`M73新人入门包-${runId}`);
    expect(r.count).toBe(2);
    const noted = r.items.find((i) => i.id === assetA);
    expect(noted?.note, "收录备注如实返回").toBe("作为轨道分析的权威起点");
    expect(noted?.type_key).toBe(`m73.doc.${runId}`);
    expect(noted?.lifecycle).toBe("active");

    const ghost = await invokeAs("collection.items", { collection: "不存在的集合" }, projectId);
    expect(ghost.status).toBe("error");
    expect((ghost.error ?? "").includes("不存在"), "报错引导 collection.search").toBe(true);
  });

  it("④首条运行自动命名 + 显式命名不被改写", async () => {
    const prompt = "请检索团队资产目录并用表格总结各资产的完整度状况与缺失项（这条很长会被截断）";
    const run1 = await call("POST", `/sessions/${autoSessionId}/runs`, { session: admin, body: { teamId, prompt } });
    expectOk(run1.status === 201, run1.json, "创建运行失败");
    await call("POST", `/runs/${run1.json.runId}/cancel`, { session: admin, body: { teamId } });

    const expected = `${prompt.slice(0, 24)}…`;
    const list = (await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin })).json as { sessionId: string; title: string; titleIsAuto: boolean }[];
    const auto = list.find((s) => s.sessionId === autoSessionId)!;
    expect(auto.title, `自动命名后标题（实际 ${auto.title}）`).toBe(expected);
    expect(auto.titleIsAuto, "改写后标记复位").toBe(false);

    const run2 = await call("POST", `/sessions/${namedSessionId}/runs`, { session: admin, body: { teamId, prompt: "第二个任务" } });
    expectOk(run2.status === 201, run2.json, "显式命名会话建运行失败");
    await call("POST", `/runs/${run2.json.runId}/cancel`, { session: admin, body: { teamId } });
    const list2 = (await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin })).json as { sessionId: string; title: string }[];
    expect(list2.find((s) => s.sessionId === namedSessionId)!.title, "显式命名不被改写").toBe(`显式命名-${runId}`);
  });

  it("⑤PATCH 改名接管命名权：改后再发运行不再自动改写", async () => {
    const patch = await call("PATCH", `/sessions/${renamedSessionId}`, { session: admin, body: { teamId, title: `手动改名-${runId}` } });
    expectOk(patch.status === 200, patch.json, "改名失败");
    const run = await call("POST", `/sessions/${renamedSessionId}/runs`, { session: admin, body: { teamId, prompt: "改名后的第一条任务" } });
    expectOk(run.status === 201, run.json, "改名后建运行失败");
    await call("POST", `/runs/${run.json.runId}/cancel`, { session: admin, body: { teamId } });
    const list = (await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin })).json as { sessionId: string; title: string; titleIsAuto: boolean }[];
    const s = list.find((x) => x.sessionId === renamedSessionId)!;
    expect(s.title).toBe(`手动改名-${runId}`);
    expect(s.titleIsAuto, "改名后标记 false").toBe(false);
  });

  it("⑥overview 新字段：弃用单列、待审提案、语义候选计数", async () => {
    // 待审提案：直接落库（proposal.create 属 Agent 工具，留档口径一致）
    const runRow = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,'m73 提案载体', $5, $6, $7, 'deepseek', $8)`,
        [teamId, runRow, autoSessionId, projectId, JSON.stringify([]), JSON.stringify([]), JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), adminUserId]
      );
      await c.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload, status)
         VALUES ($1,$2,$3,$4,'asset_registration',$5,'pending')`,
        [teamId, randomUUID(), runRow, projectId, JSON.stringify({ name: `M73提案资产-${runId}` })]
      );
      await c.query(
        `INSERT INTO semantic_candidates (team_id, id, asset_id, relation_type, source_text, target_text, created_by)
         VALUES ($1,$2,$3,'dependsOn','源文本','目标文本',$4)`,
        [teamId, randomUUID(), assetA, adminUserId]
      );
    });
    // 弃用 assetB（M70 端点）
    const dep = await call("POST", `/assets/${assetB}/deprecate`, { session: admin, body: { teamId, note: "m73 总览验证弃用" } });
    expectOk(dep.status === 200 || dep.status === 201, dep.json, "弃用失败");

    const ov = await call("GET", `/projects/${projectId}/overview?teamId=${teamId}`, { session: admin });
    expectOk(ov.status === 200, ov.json, "总览获取失败");
    expect(ov.json.teamScope.assets.deprecated, "弃用单列计数").toBe(1);
    expect(ov.json.teamScope.assets.active, "active 不再混入 deprecated").toBe(1);
    expect(ov.json.projectScope.pendingProposals, "待审提案计数").toBe(1);
    expect(ov.json.teamScope.pendingSemanticCandidates, "语义候选计数").toBe(1);
  });

  it("⑦allowed_tools 留档与真实清单同源（含本轮新工具）", async () => {
    const run = await call("POST", `/sessions/${autoSessionId}/runs`, { session: admin, body: { teamId, prompt: "留档快照验证" } });
    expectOk(run.status === 201, run.json, "建运行失败");
    await call("POST", `/runs/${run.json.runId}/cancel`, { session: admin, body: { teamId } });
    const detail = await call("GET", `/runs/${run.json.runId}?teamId=${teamId}`, { session: admin });
    expectOk(detail.status === 200, detail.json, "读取运行失败");
    const allowed = detail.json.allowed_tools as string[];
    expect(allowed.includes("issue.list"), "含 issue.list").toBe(true);
    expect(allowed.includes("collection.items"), "含 collection.items").toBe(true);
    expect(allowed.length, "与 allAgentTools 同源").toBe(allAgentTools().length);
  });
});
