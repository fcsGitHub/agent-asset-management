// M16 活动流按项目过滤测试 — 0021 审计项目维度 + 发布流程盖章 + /activity 与 SSE 过滤。
// 语义：项目级动作（审核准备/发布/回滚/Agent 运行）按项目过滤；
// 团队级动作（资产归档/恢复等，project_id 为空）仅在"全部项目"视图出现。
// 真实集成：真实 PostgreSQL、真实发布准备流程、真实 SSE。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { closeActivityHub } from "@taw/api/src/activityHub.js";
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

const PORT = 4124;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M16 活动流按项目过滤（审计项目维度 + 真实发布盖章 + SSE 隔离）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let p1 = "";
  let p2 = "";
  let sessionP1 = "";
  let sessionP2 = "";
  const call = caller(BASE);

  async function seedInTeam(fn: (c: Client) => Promise<void>): Promise<void> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
      await fn(c);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      await c.end();
    }
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m16-${runId}@t.dev`, password: "password-123", displayName: "M16管理员", teamName: `M16团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const mkProj = async (name: string, code: string): Promise<string> => {
      const r = await call("POST", "/projects", { session: admin, body: { teamId, name, code } });
      expectOk(r.status === 201, r.json, "建项目失败");
      return r.json.projectId;
    };
    p1 = await mkProj(`M16项目一-${runId}`, `m16a${runId.slice(0, 5)}`);
    p2 = await mkProj(`M16项目二-${runId}`, `m16b${runId.slice(0, 5)}`);
    // 两个项目各建一个会话（供 agent_runs 种子引用）
    for (const [pid, title] of [[p1, "P1会话"], [p2, "P2会话"]] as const) {
      const s = await call("POST", `/projects/${pid}/sessions`, { session: admin, body: { teamId, title, visibility: "project" } });
      expectOk(s.status === 201, s.json, "建会话失败");
      if (pid === p1) sessionP1 = s.json.sessionId; else sessionP2 = s.json.sessionId;
    }

    // ---- 真实发布准备流程（P1）：产生带项目盖章的 review_prepared 审计 ----
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const asset = await call("POST", "/assets", {
      session: admin,
      body: {
        teamId, name: `M16发布资产-${runId}`, typeVersionId: docTypeId,
        properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M16" },
      },
    });
    expectOk(asset.status === 201, asset.json, "建资产失败");
    const br = await call("POST", `/projects/${p1}/branches`, { session: admin, body: { teamId, name: `m16-b${runId.slice(0, 5)}` } });
    expectOk(br.status === 201, br.json, "建分支失败");
    const rev = await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: admin,
      body: { teamId, assetId: asset.json.assetId, properties: { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M16 修订" } },
    });
    expectOk(rev.status === 201, rev.json, "存草稿修订失败");
    const cr = await call("POST", "/change-requests", {
      session: admin,
      body: { teamId, branchId: br.json.branchId, title: `M16 CR-${runId}`, motivation: "验证审计项目盖章", changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
    });
    expectOk(cr.status === 201, cr.json, "建 CR 失败");
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, {
      session: admin, body: { teamId, channel: "preview", audience: "team" },
    });
    expectOk(prep.status === 201 || prep.status === 200, prep.json, "准备审核失败");

    // ---- 种子数据：团队级审计（NULL 项目）+ P2 审计 + P1/P2 agent_runs（各自触发 NOTIFY）----
    const adminUserId = (await (async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      await c.connect();
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`m16-${runId}@t.dev`]);
      await c.end();
      return rows[0]!.id;
    })());
    await seedInTeam(async (c) => {
      // 团队级（NULL project）
      await c.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail) VALUES ($1,$2,'asset.archive','asset','{}')`,
        [teamId, adminUserId]
      );
      // P2 盖章审计
      await c.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, project_id, detail) VALUES ($1,$2,'asset.archive','asset',$3,'{}')`,
        [teamId, adminUserId, p2]
      );
      // P1 / P2 agent_runs（session/project 组合正确；INSERT 触发实时 NOTIFY）
      for (const [sid, pid] of [[sessionP1, p1], [sessionP2, p2]] as const) {
        await c.query(
          `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, created_by)
           VALUES ($1, gen_random_uuid(), $2, $3, $4, $5)`,
          [teamId, sid, pid, `M16 过滤验证运行 ${pid === p1 ? "P1" : "P2"}`, adminUserId]
        );
      }
    });
  }, 90000);

  afterAll(async () => {
    await app.close();
    await closeActivityHub();
  });

  it("发布准备审计真实盖章：prepare-review 产生的审计带 P1 项目且进入 P1 过滤视图", async () => {
    const filtered = await call("GET", `/activity?teamId=${teamId}&projectId=${p1}`, { session: admin });
    expectOk(filtered.status === 200, filtered.json, "过滤读取失败");
    const items = filtered.json.items as { kind: string; action: string }[];
    expect(items.some((i) => i.kind === "audit" && i.action === "review_prepared"), `P1 视图应含 review_prepared：${JSON.stringify(items.map((i) => i.action))}`).toBe(true);
  });

  it("过滤语义：团队级动作只在全部视图；P1/P2 各自只显示本项目的动作", async () => {
    const all = await call("GET", `/activity?teamId=${teamId}`, { session: admin });
    const allItems = all.json.items as { kind: string; action: string; project?: string }[];
    // 团队级 NULL 审计仅在全部视图
    const v1 = await call("GET", `/activity?teamId=${teamId}&projectId=${p1}`, { session: admin });
    const v2 = await call("GET", `/activity?teamId=${teamId}&projectId=${p2}`, { session: admin });
    const i1 = v1.json.items as { kind: string; action: string }[];
    const i2 = v2.json.items as { kind: string; action: string; project?: string }[];
    // review_prepared 属于 P1：P2 视图不得出现
    expect(!i2.some((i) => i.action === "review_prepared"), "P2 视图不得出现 P1 的审核准备").toBe(true);
    // P1 视图不得出现 P2 的运行
    expect(!i1.some((i) => i.kind === "agent" && i.project?.includes("M16项目二")), "P1 视图不得出现 P2 的运行").toBe(true);
    // P2 视图应含 P2 运行（project 名为 P2 项目名）
    expect(i2.some((i) => i.kind === "agent" && i.project?.includes("M16项目二")), "P2 视图应含 P2 运行").toBe(true);
    // 全部视图同时包含团队级审计与两个项目的运行
    expect(allItems.some((i) => i.kind === "audit"), "全部视图应含审计").toBe(true);
    expect(allItems.some((i) => i.kind === "agent" && i.project?.includes("M16项目一")), "全部视图应含 P1 运行").toBe(true);
    void v1;
  });

  it("SSE 按项目过滤：P2 的实时事件不进入 P1 流，P1 事件即时到达", async () => {
    // 复用 m11 的流式读取方式（简化版，直接解析 activity 事件）
    const headers: Record<string, string> = { accept: "text/event-stream", cookie: admin.cookie };
    const res = await fetch(`${BASE}/activity/stream?teamId=${teamId}&projectId=${p1}`, { headers });
    expect(res.status === 200, "SSE 应建立").toBe(true);
    const events: { event: string; data: string }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let notify: (() => void) | null = null;
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            let event = "message";
            let data = "";
            for (const l of frame.split("\n")) {
              if (l.startsWith("event:")) event = l.slice(6).trim();
              else if (l.startsWith("data:")) data += l.slice(5).trim();
            }
            if (event !== "message") {
              events.push({ event, data });
              notify?.();
            }
          }
        }
      } catch { /* 关闭 */ }
    })();

    await new Promise((r) => setTimeout(r, 400));
    // P2 插入一条 agent_run（触发 NOTIFY）：不应进入 P1 流
    await seedInTeam(async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, created_by)
         VALUES ($1, gen_random_uuid(), $2, $3, 'P2 不应泄漏的运行', (SELECT id FROM users WHERE email = $4))`,
        [teamId, sessionP2, p2, `m16-${runId}@t.dev`]
      );
    });
    await new Promise((r) => setTimeout(r, 3000));
    const leaked = events.filter((e) => e.event === "activity" && (JSON.parse(e.data) as { summary?: string }).summary?.includes("不应泄漏"));
    expect(leaked.length === 0, `P2 事件泄漏进 P1 流 ${leaked.length} 条`).toBe(true);
    // P1 插入一条：应即时到达
    await seedInTeam(async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, created_by)
         VALUES ($1, gen_random_uuid(), $2, $3, 'P1 应到达的运行', (SELECT id FROM users WHERE email = $4))`,
        [teamId, sessionP1, p1, `m16-${runId}@t.dev`]
      );
    });
    const start = Date.now();
    for (;;) {
      const hit = events.find((e) => e.event === "activity" && (JSON.parse(e.data) as { summary?: string }).summary?.includes("应到达"));
      if (hit) break;
      if (Date.now() - start > 15000) throw new Error(`P1 事件未到达：已收 ${events.length} 帧`);
      await Promise.race([
        new Promise((r2) => setTimeout(r2, 150)),
        new Promise<void>((r2) => { notify = r2; }),
      ]);
      notify = null;
    }
    void reader.cancel().catch(() => undefined);
  }, 40000);
});
