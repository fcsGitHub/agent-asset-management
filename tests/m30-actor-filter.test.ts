// M30 操作者筛选测试 — 列表/翻页/导出同源按团队成员过滤（审计 actor_id 与运行
// created_by 一并命中），actors 名单同源下发，盖章与 JSON 元数据记录过滤人。
// 全部真实集成，无 mock。
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

const PORT = 4137;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M30 按操作者筛选（同源）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let projectId = "";
  let adminId = "";
  let memberId = "";
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
    const a = await reg(`m30-${runId}@t.dev`, "M30队长", `M30团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m30member-${runId}@t.dev`, "M30成员", `M30成员团队-${runId}`);
    member = m.session;
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m30member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M30项目-${runId}`, code: `m30${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: "M30 会话", visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");

    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    const uid = async (email: string): Promise<string> => {
      const { rows } = await adminPool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [email]);
      return rows[0]!.id;
    };
    adminId = await uid(`m30-${runId}@t.dev`);
    memberId = await uid(`m30member-${runId}@t.dev`);
    const { rows: s } = await adminPool.query<{ id: string }>(`SELECT id FROM sessions WHERE team_id = $1 LIMIT 1`, [teamId]);
    // 两人各自的审计与运行
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, created_at)
       VALUES ($1,$2,'asset.archive','audit','{}'::jsonb,now())`,
      [teamId, adminId]
    );
    await adminPool.query(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail, project_id, created_at)
       VALUES ($1,$2,'release_published','release','{}'::jsonb,$3,now())`,
      [teamId, memberId, projectId]
    );
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by)
       VALUES ($1,$2,$3,$4,'completed',$5,$6)`,
      [teamId, randomUUID(), s[0]!.id, projectId, `M30 运行甲 ${runId}`, adminId]
    );
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by)
       VALUES ($1,$2,$3,$4,'failed',$5,$6)`,
      [teamId, randomUUID(), s[0]!.id, projectId, `M30 运行乙 ${runId}`, memberId]
    );
  }, 60000);

  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("按操作者过滤：列表恰为该成员的动作与运行，actors 名单同源下发，与动作过滤叠加", async () => {
    const byAdmin = await call("GET", `/activity?teamId=${teamId}&actorId=${adminId}&limit=50`, { session: admin });
    expectOk(byAdmin.status === 200, byAdmin.json, "队长过滤失败");
    expect(byAdmin.json.items.length === 2, `队长应 2 条（审计+运行）：${byAdmin.json.items.length}`).toBe(true);
    expect(byAdmin.json.items.every((i: { actor: string }) => i.actor === "M30队长"), "全部条目应为队长").toBe(true);
    expect(byAdmin.json.items.some((i: { kind: string }) => i.kind === "agent") && byAdmin.json.items.some((i: { kind: string }) => i.kind === "audit"),
      "应同时含审计与运行").toBe(true);

    const byMember = await call("GET", `/activity?teamId=${teamId}&actorId=${memberId}&limit=50`, { session: admin });
    expect(byMember.json.items.length === 2, `成员应 2 条：${byMember.json.items.length}`).toBe(true);

    // 叠加动作过滤：队长的运行
    const combo = await call("GET", `/activity?teamId=${teamId}&actorId=${adminId}&action=agent&limit=50`, { session: admin });
    expect(combo.json.items.length === 1 && combo.json.items[0]!.kind === "agent", `队长+agent 应恰 1 条运行：${JSON.stringify(combo.json.items)}`).toBe(true);

    // 无过滤全集 4 条；actors 名单含两人且与服务端标签同源
    const all = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expect(all.json.items.length === 4, `全集应 4 条：${all.json.items.length}`).toBe(true);
    const actors = (all.json.actors ?? []) as Array<{ id: string; label: string }>;
    expect(actors.length === 2, `名单应两人：${JSON.stringify(actors)}`).toBe(true);
    expect(actors.some((o) => o.id === adminId && o.label === "M30队长") && actors.some((o) => o.id === memberId && o.label === "M30成员"),
      `名单应含双方 id 与名：${JSON.stringify(actors)}`).toBe(true);

    const bad = await call("GET", `/activity?teamId=${teamId}&actorId=not-a-uuid`, { session: admin });
    expect(bad.status === 422, `非法 actorId 应 422：${bad.status}`).toBe(true);
  });

  it("导出同源：按人导出恰为子集，盖章与 JSON 元数据记录 actorId", async () => {
    const lst = await call("GET", `/activity?teamId=${teamId}&actorId=${memberId}`, { session: admin });
    const listKeys = (lst.json.items as Array<{ key: string }>).map((i) => i.key);

    const j = await call("GET", `/activity/export?teamId=${teamId}&actorId=${memberId}&format=json`, { session: admin });
    expectOk(j.status === 200, j.json, "JSON 导出失败");
    expect(j.json.total === 2 && j.json.actorId === memberId, `元数据应回显 actorId：${JSON.stringify({ total: j.json.total, actorId: j.json.actorId })}`).toBe(true);
    expect(JSON.stringify((j.json.items as Array<{ entryId: string }>).map((i) => i.entryId).sort()) === JSON.stringify([...listKeys].sort()),
      "导出与列表应同源").toBe(true);

    await call("GET", `/activity/export?teamId=${teamId}&actorId=${adminId}&format=json`, { session: admin });
    const { rows: stamps } = await adminPool.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE team_id = $1 AND action = 'audit.export' AND detail ? 'actorId'
        ORDER BY created_at DESC LIMIT 1`,
      [teamId]
    );
    // 注意：第一次导出（admin 调用）的章也是 admin 的审计，会被第二次 admin 过滤捕获
    expect(stamps.length === 1 && stamps[0]!.detail.actorId === adminId && stamps[0]!.detail.count === 3,
      `章应记录操作者过滤（2 种子 + 1 前次导出章）：${JSON.stringify(stamps[0]?.detail)}`).toBe(true);
  });
});
