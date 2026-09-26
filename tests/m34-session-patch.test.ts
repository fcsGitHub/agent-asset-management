// M34 会话维护端点（PATCH /sessions/:id 改名/归档）— 真实 PostgreSQL/HTTP。
// 权限口径：创建者本人可改；团队管理员可改他人会话；普通成员不可改他人会话。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4115;
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

async function register(email: string, name: string, team: string): Promise<Session & { teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status).toBe(201);
  return { ...sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M34 会话改名/归档（真实集成）", () => {
  let app: FastifyInstance;
  let teamId = "", sessionId = "";
  let creator: Session, member: Session, secondAdmin: Session;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });

    const a = await register(`m34-a-${runId}@t.dev`, "甲", `M34团队-${runId}`);
    creator = a; teamId = a.teamId;
    member = await register(`m34-b-${runId}@t.dev`, "乙", `M34乙团队-${runId}`);
    secondAdmin = await register(`m34-c-${runId}@t.dev`, "丙", `M34丙团队-${runId}`);
    // 乙以普通成员、丙以管理员身份加入甲的团队
    await call("POST", `/teams/${teamId}/members`, { session: creator, body: { email: `m34-b-${runId}@t.dev` } });
    await call("POST", `/teams/${teamId}/members`, { session: creator, body: { email: `m34-c-${runId}@t.dev`, role: "admin" } });

    const proj = await call("POST", "/projects", { session: creator, body: { teamId, name: "M34项目", code: `m34-${runId}` } });
    const sess = await call("POST", `/projects/${proj.json.projectId}/sessions`, {
      session: creator, body: { teamId, title: "原始标题", visibility: "project" },
    });
    sessionId = sess.json.sessionId;
  });

  afterAll(async () => { await app.close(); });

  it("普通成员不能修改他人会话（403）", async () => {
    const res = await call("PATCH", `/sessions/${sessionId}`, { session: member, body: { teamId, title: "乙改名" } });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("ACTION_NOT_ALLOWED");
  });

  it("空补丁如实 422", async () => {
    const res = await call("PATCH", `/sessions/${sessionId}`, { session: creator, body: { teamId } });
    expect(res.status).toBe(422);
  });

  it("创建者改名并归档，列表如实反映", async () => {
    const ren = await call("PATCH", `/sessions/${sessionId}`, { session: creator, body: { teamId, title: "轨道模型梳理·终稿" } });
    expect(ren.status).toBe(200);
    expect(ren.json.title).toBe("轨道模型梳理·终稿");
    expect(ren.json.archived).toBe(false);

    const arc = await call("PATCH", `/sessions/${sessionId}`, { session: creator, body: { teamId, archived: true } });
    expect(arc.status).toBe(200);
    expect(arc.json.archived).toBe(true);
    expect(arc.json.title).toBe("轨道模型梳理·终稿");

    // 列表仍返回（带 archived 标记），由界面折叠进「已归档」区
    const proj = await call("GET", "/projects", { session: creator });
    const list = await call("GET", `/projects/${proj.json[0].projectId}/sessions?teamId=${teamId}`, { session: creator });
    const row = (list.json as { sessionId: string; title: string; archived: boolean }[]).find((s) => s.sessionId === sessionId);
    expect(row?.title).toBe("轨道模型梳理·终稿");
    expect(row?.archived).toBe(true);
  });

  it("团队管理员可恢复他人归档的会话", async () => {
    const res = await call("PATCH", `/sessions/${sessionId}`, { session: secondAdmin, body: { teamId, archived: false } });
    expect(res.status).toBe(200);
    expect(res.json.archived).toBe(false);
  });

  it("不存在或他团队会话返回 404", async () => {
    const res = await call("PATCH", `/sessions/00000000-0000-0000-0000-000000000000`, { session: creator, body: { teamId, title: "x" } });
    expect(res.status).toBe(404);
  });
});
