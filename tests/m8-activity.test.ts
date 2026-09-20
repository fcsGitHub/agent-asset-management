// M8 项目管理测试 — 项目总览统计 + 团队活动流（审计 + Agent 运行）。
// 真实 PostgreSQL/HTTP；跨团队隔离负例。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = 4112;
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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, `register ${email} → ${res.status}`, "注册失败");
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

const DOC_PROPS = (scope: string) => ({ docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope });

describe("M8 项目总览与团队动态", () => {
  let app: FastifyInstance;
  let admin: Session, otherSession: Session;
  let teamId = "", projectId = "", sessionId = "", assetId = "", docTypeId = "";
  let otherTeamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m8a-${runId}@t.dev`, "M8动态管理员", `M8动态团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M8动态项目", code: `m8a-${runId}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "动态验证会话", visibility: "project" },
    });
    sessionId = sess.json.sessionId;

    await call("GET", `/types?teamId=${teamId}`, { session: admin });
    await seedInTeam(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
      docTypeId = rows[0]!.id;
    });
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `动态资产-${runId}`, typeVersionId: docTypeId, properties: DOC_PROPS("动态") },
    });
    assetId = asset.json.assetId;

    // 一个他团队（隔离负例用）
    const otherReg = await register(`m8o-${runId}@t.dev`, "M8隔离团队", `M8隔离团队-${runId}`);
    otherTeamId = otherReg.teamId;
    otherSession = otherReg.session;
  });

  afterAll(async () => { await app.close(); });

  it("项目总览：分支/CR/发布与团队资产计数与真实状态一致", async () => {
    // 归档又恢复：审计两条，资产仍是 active
    const arch = await call("POST", `/assets/${assetId}/archive`, {
      session: admin, body: { teamId, reason: "总览验证归档" },
    });
    expectOk(arch.status === 200, arch.json, "归档失败");
    const restore = await call("POST", `/assets/${assetId}/restore`, {
      session: admin, body: { teamId, reason: "总览验证恢复" },
    });
    expectOk(restore.status === 200, restore.json, "恢复失败");

    // 开一个工作分支
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `m8-ov-${runId}` } });
    expectOk(br.status === 201, br.json, "建分支失败");

    const ov = await call("GET", `/projects/${projectId}/overview?teamId=${teamId}`, { session: admin });
    expectOk(ov.status === 200, ov.json, "总览获取失败");
    expect(ov.json.project.name === "M8动态项目", ov.json.project, "项目名应正确");
    expect(ov.json.projectScope.branches.open === 2, ov.json.projectScope.branches, "main + 新分支 = 2 个开放分支");
    expect(ov.json.projectScope.changeRequests.awaitingReview === 0, ov.json.projectScope.changeRequests, "无待审 CR");
    expect(ov.json.projectScope.releases.total === 0, ov.json.projectScope.releases, "无发布");
    expect(ov.json.teamScope.assets.active === 1, ov.json.teamScope.assets, "1 个活跃资产");
    expect(ov.json.teamScope.assets.archived === 0, ov.json.teamScope.assets, "归档后已恢复 → 0");
    expect(ov.json.teamScope.revisions >= 1, ov.json.teamScope, "至少 1 个修订");
  });

  it("团队活动流：审计动作与 Agent 运行人机混排、时间倒序、limit 生效、跨团队隔离", async () => {
    const me = await call("GET", "/auth/me", { session: admin });
    const userId = me.json.userId as string;
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, result, created_by)
         VALUES ($1,$2,$3,$4,'completed','整理轨道参数汇总','{"finalText":"完成"}',$5)`,
        [teamId, randomUUID(), sessionId, projectId, userId]
      );
    });

    const feed = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expectOk(feed.status === 200, feed.json, "活动流获取失败");
    const items = feed.json.items as any[];
    expect(items.length >= 3, items, "应含归档/恢复审计 + Agent 运行");
    // 时间倒序
    for (let i = 1; i < items.length; i += 1) {
      expect(items[i - 1].ts >= items[i].ts, [items[i - 1].ts, items[i].ts], "应按时间倒序");
    }
    const archive = items.find((i) => i.action === "asset.archive");
    expectOk(archive && archive.kind === "audit" && archive.actor === "M8动态管理员", archive, "归档审计项应带动作人与标签");
    expect(archive.summary === "归档资产", archive, "归档动作应映射为中文标签");
    const agentItem = items.find((i) => i.kind === "agent");
    expectOk(agentItem && agentItem.summary === "整理轨道参数汇总", agentItem, "Agent 运行应入流");
    expect(agentItem.action === "agent.run.completed", agentItem, "Agent 动作应带状态");
    expect(agentItem.project === "M8动态项目", agentItem, "Agent 项应带项目名");

    // limit 生效
    const limited = await call("GET", `/activity?teamId=${teamId}&limit=1`, { session: admin });
    expect((limited.json.items as any[]).length === 1, limited.json, "limit=1 应只返回 1 条");

    // 跨团队隔离：他团队的管理员看不到本团队动态（RLS + 成员资格双重约束）
    const other = await call("GET", `/activity?teamId=${otherTeamId}`, { session: otherSession });
    expectOk(other.status === 200, other.json, "他团队活动流失败");
    const otherItems = other.json.items as any[];
    expect((otherItems.filter((i) => i.action === "asset.archive")).length === 0, otherItems, "他团队不应看到本团队归档事件");
    // 本团队成员访问他团队动态 → 404（非成员不可见）
    const intrude = await call("GET", `/activity?teamId=${otherTeamId}`, { session: admin });
    expect(intrude.status === 404, intrude, "非成员访问他团队动态应 404");

    // 未登录 401
    const anon = await fetch(`${BASE}/activity?teamId=${teamId}`);
    expect(anon.status === 401, anon.status, "未登录应 401");
  });
});
