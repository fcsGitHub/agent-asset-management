// M7 API 补强测试 — 会话级运行历史 + 修订历史分页（真实 PostgreSQL/HTTP）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = 4110;
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
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 300)}`);
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

/** 夹具播种专用：真实提交（withTeamDb 会回滚，不能用于写入测试数据）。 */
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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, "注册失败").toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M7 API 补强（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "", sessionId = "", assetId = "", typeVersionId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m7-${runId}@t.dev`, "M7验证员", `M7团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M7项目", code: `m7-${runId}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "运行历史验证", visibility: "project" },
    });
    sessionId = sess.json.sessionId;
    await call("GET", `/types?teamId=${teamId}`, { session: admin });
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
      typeVersionId = rows[0]!.id;
    });
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "分页验证资产", typeVersionId,
        properties: { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "分页" } },
    });
    assetId = asset.json.assetId;
  });

  afterAll(async () => { await app.close(); });

  it("会话运行历史：运行与工具调用按会话聚合返回（真实库夹具）", async () => {
    const me = await call("GET", "/auth/me", { session: admin });
    const userId = me.json.userId as string;
    const runA = randomUUID(), runB = randomUUID();
    await seedInTeam(teamId, async (c) => {
      for (const [id, status] of [[runA, "completed"], [runB, "blocked"]] as const) {
        await c.query(
          `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, result, error, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [teamId, id, sessionId, projectId, status, `任务-${id.slice(0, 6)}`,
           status === "completed" ? JSON.stringify({ finalText: "已完成整理" }) : "",
           status === "blocked" ? "预算已用尽" : "", userId]
        );
      }
      await c.query(
        `INSERT INTO tool_invocations (team_id, id, run_id, call_id, name, args, result, status)
         VALUES ($1,$2,$3,'call-1','asset__search','{}','{"hits":2}','ok'),
                ($1,$4,$5,'call-2','publish','{}',null,'denied')`,
        [teamId, randomUUID(), runA, randomUUID(), runB]
      );
    });

    const res = await call("GET", `/sessions/${sessionId}/runs?teamId=${teamId}`, { session: admin });
    expectOk(res.status === 200, res.json, "运行历史获取失败");
    expect(res.json).toHaveLength(2);
    const completed = res.json.find((r: any) => r.status === "completed");
    const blocked = res.json.find((r: any) => r.status === "blocked");
    expect(completed.invocations).toHaveLength(1);
    expect(completed.invocations[0].name === "asset__search" && completed.invocations[0].status === "ok", "工具调用映射错误").toBe(true);
    expect(blocked.invocations[0].status === "denied" && blocked.error === "预算已用尽", "blocked 运行信息错误").toBe(true);
    const parsed = typeof completed.result === "string" ? JSON.parse(completed.result) : completed.result;
    expect(parsed.finalText === "已完成整理", "result 应含最终回复").toBe(true);
    // 未登录不可见
    const anon = await fetch(`${BASE}/sessions/${sessionId}/runs?teamId=${teamId}`);
    expect(anon.status === 401, "未登录应 401").toBe(true);
  });

  it("修订历史分页：revisionsTotal 正确、revLimit/revOffset 翻页有序", async () => {
    // 通过分支草稿真实追加 3 个修订（共 4 个）
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `m7-page-${runId}` } });
    expectOk(br.status === 201, br.json, "建分支失败");
    for (const v of ["1.0.1", "1.0.2", "1.0.3"]) {
      const save = await call("POST", `/branches/${br.json.branchId as string}/revisions`, {
        session: admin, body: { teamId, assetId, properties: { scope: `分页-${v}` } },
      });
      expectOk(save.status === 201, save.json, `草稿 ${v} 失败`);
    }

    const full = await call("GET", `/assets/${assetId}?teamId=${teamId}`, { session: admin });
    expectOk(full.status === 200, full.json, "详情获取失败");
    expect(full.json.revisionsTotal === 4, "总数应为 4").toBe(true);
    expect(full.json.revisions).toHaveLength(4);
    expect(full.json.revisions[0].seq === 4, "默认按 seq 降序").toBe(true);

    const page1 = await call("GET", `/assets/${assetId}?teamId=${teamId}&revLimit=2`, { session: admin });
    expect(page1.json.revisions).toHaveLength(2);
    expect(page1.json.revisions.map((r: any) => r.seq)).toEqual([4, 3]);
    const page2 = await call("GET", `/assets/${assetId}?teamId=${teamId}&revLimit=2&revOffset=2`, { session: admin });
    expect(page2.json.revisions.map((r: any) => r.seq)).toEqual([2, 1]);
  });
});
