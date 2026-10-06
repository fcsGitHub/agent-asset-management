// M17 Agent 提案审核测试 — proposal.create 落库内容的读取与审核闭环：
// 真实 LLM 生成提案 → 列表可见（含来源运行）→ 成员审核 → 状态机与回执如实。
// 全部真实集成：真实 PostgreSQL、真实 DeepSeek。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
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

const PORT = 4125;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M17 Agent 提案审核（真实 LLM 生成 + 审核状态机）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let projectId = "";
  let sessionId = "";
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
    const a = await reg(`m17-${runId}@t.dev`, "M17管理员", `M17团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m17member-${runId}@t.dev`, "M17审核员", `M17成员团队-${runId}`);
    member = m.session;
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m17member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M17项目-${runId}`, code: `m17${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: `M17会话`, visibility: "project" } });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("真实 LLM 生成提案：proposal.create 落库后立即在列表可见（含来源运行与发起人）", async () => {
    const run = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: { teamId, prompt: `请直接调用 proposal.create 工具，提交一条 kind 为 asset_registration 的资产整理提案：建议登记一份名为「M17轨道仿真报告」的文档资产，payload 里给出 name 与 typeKey（document）。不需要做其他事情。`, budget: { maxToolCalls: 3, maxTokens: 6000 } },
    });
    expectOk(run.status === 201, run.json, "创建运行失败");
    // 轮询列表直至提案出现（真实模型执行需要时间）
    const start = Date.now();
    let found: any = null;
    while (Date.now() - start < 120000) {
      const list = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=pending`, { session: admin });
      expectOk(list.status === 200, list.json, "读提案列表失败");
      const hit = (list.json as { run_prompt: string }[]).find((p) => p.run_prompt?.includes("M17轨道仿真报告"));
      if (hit) { found = hit; break; }
      await new Promise((r) => setTimeout(r, 1500));
    }
    expect(!!found, "120 秒内应看到真实提案出现在待审列表").toBe(true);
    expect(found!.kind === "asset_registration", `kind 应为 asset_registration：${found!.kind}`).toBe(true);
    expect(found!.initiated_by_name === "M17管理员", `发起人应如实：${found!.initiated_by_name}`).toBe(true);
  }, 150000);

  it("成员审核：接受带备注 → payload 合并审核回执、reviewed_by 如实；重复审核 409", async () => {
    // 种子一条待审 relation_suggestion（走真实表与 RLS）
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    let seedId = "";
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
      const { rows } = await c.query<{ run_id: string }>(
        `SELECT id AS run_id FROM agent_runs WHERE team_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [teamId, sessionId]
      );
      seedId = randomUUID();
      await c.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'relation_suggestion',$5)`,
        [teamId, seedId, rows[0]!.run_id, projectId, JSON.stringify({ source: `M17模型-${runId}`, target: `M17文档-${runId}`, type: "dependsOn" })]
      );
      const { rows: u } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m17-${runId}@t.dev`]);
      // 外团队不可见校验用例需要 issue_triage 回执种子（应被列表排除）
      await c.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1, gen_random_uuid(), $2, $3, 'issue_triage', $4)`,
        [teamId, rows[0]!.run_id, projectId, JSON.stringify({ external: true })]
      );
      void u;
      await c.query("COMMIT");
    } finally {
      await c.end();
    }
    const list = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=pending`, { session: member });
    const kinds = (list.json as { kind: string }[]).map((p) => p.kind);
    expect(!kinds.includes("issue_triage"), "issue_triage 回执不应出现在提案列表").toBe(true);
    // M72 语义对齐：提案审核需要项目成员身份（与批量审核端点同口径——单条端点此前
    // 只查团队成员，团队成员可审任意项目提案是授权缺口）——审核前把审核员加进项目
    const addPm = await call("POST", `/projects/${projectId}/members`, {
      session: admin, body: { teamId, email: `m17member-${runId}@t.dev`, role: "member" },
    });
    expectOk(addPm.status === 201, addPm.json, "把审核员加进项目失败");
    // 成员接受并附备注
    const rev = await call("POST", `/proposals/${seedId}/review`, {
      session: member, body: { teamId, decision: "accepted", note: "确有依赖关系，待登记后补充断言" },
    });
    expectOk(rev.status === 200, rev.json, "审核应成功");
    // accepted 列表可见且审核回执如实
    const acc = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}&status=accepted`, { session: admin });
    const row = (acc.json as { id: string; status: string; reviewed_by_name: string; payload: { review?: { note?: string } } }[]).find((p) => p.id === seedId);
    expect(!!row, "已接受提案应在 accepted 列表").toBe(true);
    expect(row!.reviewed_by_name === "M17审核员", `审核人应如实：${row!.reviewed_by_name}`).toBe(true);
    expect(row!.payload.review?.note === "确有依赖关系，待登记后补充断言", "审核备注应保留").toBe(true);
    // 重复审核 → 409 PROPOSAL_NOT_PENDING
    const again = await call("POST", `/proposals/${seedId}/review`, {
      session: member, body: { teamId, decision: "rejected" },
    });
    expect(again.status === 409, `重复审核应 409，实际 ${again.status}`).toBe(true);
    expect(again.json?.error?.code === "PROPOSAL_NOT_PENDING", `错误码应明确：${again.json?.error?.code}`).toBe(true);
  });

  it("鉴权：非本团队成员读列表 404", async () => {
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m17other-${runId}@t.dev`, password: "password-123", displayName: "M17外团队", teamName: `M17外团队-${runId}` }),
    });
    const other = sessionOf(o);
    const r = await call("GET", `/projects/${projectId}/proposals?teamId=${teamId}`, { session: other });
    expect(r.status === 404 || r.status === 403, `非成员应 404/403，实际 ${r.status}`).toBe(true);
  });
});
