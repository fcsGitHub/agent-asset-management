// M19 实时层自愈测试 — activityHub 单 LISTEN 连接的可用性收敛：
// 真实 pg_terminate_backend 断线注入（非 mock）→ 退避重连 → 重新 LISTEN →
// 重连后 resync：运行流按 DB 游标精确补取断窗事件（恰好一次），活动流转发 resync
// 帧（客户端重取对齐）；恢复后新通知实时到达。含 NL「打开提案页」规则。
// SQL 直接造运行/事件（admin 角色），避免真实模型时序抖动；断线本身是真实的。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { closeActivityHub, isListening } from "@taw/api/src/activityHub.js";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
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

interface SseEvent { id: number; event: string; data: string }
interface SseHandle {
  status: number;
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, timeoutMs: number, what: string): Promise<SseEvent>;
  waitForClose(timeoutMs: number): Promise<boolean>;
  close(): void;
}

async function openSse(base: string, path: string, opts: { session?: Session } = {}): Promise<SseHandle> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (opts.session) headers.cookie = opts.session.cookie;
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok || !res.body) {
    return { status: res.status, events: [],
      waitFor: async () => { throw new Error("流未建立"); },
      waitForClose: async () => true, close: () => undefined };
  }
  const events: SseEvent[] = [];
  let notify: (() => void) | null = null;
  let streamDone = false;
  const decoder = new TextDecoder();
  let buf = "";
  const reader = res.body.getReader();
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
          let id = 0;
          let isEvent = false;
          for (const l of frame.split("\n")) {
            if (l.startsWith("event:")) { event = l.slice(6).trim(); isEvent = true; }
            else if (l.startsWith("data:")) data += l.slice(5).trim();
            else if (l.startsWith("id:")) { id = Number(l.slice(3).trim()); isEvent = true; }
          }
          if (!isEvent) continue;
          events.push({ id, event, data });
          notify?.();
        }
      }
    } catch { /* 连接被客户端关闭 */ }
    streamDone = true;
    notify?.();
  })();
  return {
    status: res.status,
    events,
    async waitFor(pred, timeoutMs, what) {
      const start = Date.now();
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() - start >= timeoutMs) {
          throw new Error(`SSE 等待超时（${what}）：已收 ${events.length} 帧 ${JSON.stringify(events.map((e) => e.event))}`);
        }
        await Promise.race([
          new Promise((r) => setTimeout(r, 120)),
          new Promise<void>((r) => { notify = r; }),
        ]);
        notify = null;
      }
    },
    async waitForClose(timeoutMs) {
      const start = Date.now();
      while (!streamDone && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 120));
      }
      return streamDone;
    },
    close() { void reader.cancel().catch(() => undefined); },
  };
}

/** 真实断线注入：终止本进程 hub（与同机其他 hub 实例）的 LISTEN 后端。 */
async function killListenBackends(adminPool: Pool): Promise<number> {
  const { rows } = await adminPool.query<{ pid: number }>(
    `SELECT pid FROM pg_stat_activity
      WHERE application_name = 'taw_activity_hub' AND pid <> pg_backend_pid()`
  );
  for (const r of rows) {
    await adminPool.query(`SELECT pg_terminate_backend($1)`, [r.pid]);
  }
  return rows.length;
}

async function waitHubState(expectUp: boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (isListening() !== expectUp) {
    if (Date.now() - start >= timeoutMs) throw new Error(`hub 未在 ${timeoutMs}ms 内${expectUp ? "重连" : "检测到断线"}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const PORT = 4127;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M19 实时层自愈（真实断线注入 + resync 补齐）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let adminPool: Pool;
  let teamId = "";
  let sessionId = "";
  let projectId = "";
  let userId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    expectOk(!!process.env.DATABASE_ADMIN_URL, process.env.DATABASE_ADMIN_URL, "需要 DATABASE_ADMIN_URL 做断线注入");
    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m19-${runId}@t.dev`, password: "password-123", displayName: "M19管理员", teamName: `M19团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    const body = (await res.json()) as { teamId: string; userId: string };
    teamId = body.teamId; userId = body.userId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M19项目-${runId}`, code: `m19${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: `M19自愈会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await closeActivityHub();
    await adminPool.end();
  });

  it("运行流断窗回填：断线期间落库的事件经重连 resync 精确补齐（恰好一次），终态 done 不丢", async () => {
    // SQL 直接造一个 running 状态的运行（不经真实模型，时序完全可控）
    const rid = randomUUID();
    await adminPool.query(
      `INSERT INTO agent_runs (team_id, id, session_id, project_id, status, prompt, created_by)
       VALUES ($1,$2,$3,$4,'running','M19 断窗回填测试运行',$5)`,
      [teamId, rid, sessionId, projectId, userId]
    );

    // 先订阅（此时无事件、非终态 → 流保持打开）
    const live = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin });
    expect(live.status === 200, "SSE 应建立").toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    // 真实断线：终止 LISTEN 后端
    const killed = await killListenBackends(adminPool);
    expectOk(killed >= 1, killed, "应至少终止一个 LISTEN 后端");
    await waitHubState(false, 5000);

    // 断窗内：两条事件落库 + 运行转终态（其 NOTIFY 全部丢失）
    await adminPool.query(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES
         ($1,$2,'tool_invocation',jsonb_build_object('name','search.assets','note','断窗内事件A')),
         ($1,$2,'llm_delta',jsonb_build_object('text','断窗内事件B'))`,
      [teamId, rid]
    );
    await adminPool.query(`UPDATE agent_runs SET status='completed', result='ok' WHERE team_id=$1 AND id=$2`, [teamId, rid]);

    // 自愈：退避重连 → resync → 按游标补取断窗事件 + 终态 done
    await waitHubState(true, 15000);
    const done = await live.waitFor((e) => e.event === "done", 15000, "等待重连后 done");
    expect(JSON.parse(done.data).status === "completed", `done 应为 completed：${done.data}`).toBe(true);

    // 恰好一次、严格递增：收到的 seq 集与 DB 完全一致
    const { rows: dbSeqs } = await adminPool.query<{ seq: string }>(
      `SELECT seq FROM run_events WHERE team_id=$1 AND run_id=$2 ORDER BY seq`, [teamId, rid]
    );
    const got = live.events.filter((e) => e.id > 0).map((e) => e.id);
    expect(JSON.stringify(got) === JSON.stringify(dbSeqs.map((r) => Number(r.seq))),
      `补齐序列应与 DB 完全一致且无重复：got=${got} db=${dbSeqs.map((r) => r.seq)}`).toBe(true);
    const kinds = live.events.filter((e) => e.id > 0).map((e) => e.event);
    expect(JSON.stringify(kinds) === JSON.stringify(["tool_invocation", "llm_delta"]), `事件类型应保序：${kinds}`).toBe(true);
    live.close();
  }, 60000);

  it("活动流断窗：重连后发 resync 帧，客户端重取可见断窗事件；恢复后新事件实时到达", async () => {
    const live = await openSse(BASE, `/activity/stream?teamId=${teamId}`, { session: admin });
    expect(live.status === 200, "活动流 SSE 应建立").toBe(true);
    await new Promise((r) => setTimeout(r, 300));

    const killed = await killListenBackends(adminPool);
    expectOk(killed >= 1, killed, "应至少终止一个 LISTEN 后端");
    await waitHubState(false, 5000);

    // 断窗内落库的审计事件（通知丢失）
    const { rows: missed } = await adminPool.query<{ id: string }>(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail)
       VALUES ($1,$2,'asset.archive','asset',jsonb_build_object('note','M19 断窗内事件'))
       RETURNING id`,
      [teamId, userId]
    );
    const missedId = missed[0]!.id;

    await waitHubState(true, 15000);
    await live.waitFor((e) => e.event === "resync", 15000, "等待 resync 信号帧");

    // resync 的客户端语义：整体重取（与列表同源）→ 断窗事件可见
    const list = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expectOk(list.status === 200, list.json, "重取活动失败");
    const keys = (list.json.items as Array<{ key: string }>).map((x) => x.key);
    expect(keys.includes(`audit:${missedId}`), `重取应包含断窗内审计事件：${JSON.stringify(keys.slice(0, 5))}…`).toBe(true);

    // 恢复验证：重连后的新通知实时到达（LISTEN 通道真正恢复，而非一次性补齐）
    const { rows: after } = await adminPool.query<{ id: string }>(
      `INSERT INTO audit_events (team_id, actor_id, action, object_kind, detail)
       VALUES ($1,$2,'asset.restore','asset',jsonb_build_object('note','M19 重连后事件'))
       RETURNING id`,
      [teamId, userId]
    );
    const frame = await live.waitFor((e) => e.event === "activity" && e.data.includes(after[0]!.id), 15000, "等待重连后实时事件");
    expect(JSON.parse(frame.data).key === `audit:${after[0]!.id}`, `实时帧应对应新事件：${frame.data}`).toBe(true);
    live.close();
  }, 60000);

  it("NL 规则：打开提案页 → navigate proposals（L1 确定性命中，零模型成本）", async () => {
    for (const text of ["打开提案页", "跳到提案", "去提案"]) {
      const r = await call("POST", "/nl/parse", { session: admin, body: { teamId, text, page: "dashboard" } });
      expectOk(r.status === 200, r.json, `解析失败：${text}`);
      expect(r.json.intent === "navigate" && r.json.params.page === "proposals",
        `"${text}" 应解析为 navigate proposals：${JSON.stringify(r.json)}`).toBe(true);
      expect(r.json.parser.kind === "rules", `应走 L1 规则路径：${JSON.stringify(r.json.parser)}`).toBe(true);
    }
  });
});
