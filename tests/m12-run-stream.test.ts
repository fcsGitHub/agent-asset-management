// M12 运行事件流测试 — /runs/:id/events 从 400ms 轮询迁移到 Postgres NOTIFY（0019）
// → activityHub 扇出。全部真实集成：真实 PostgreSQL、真实 HTTP SSE 流、真实 DeepSeek 运行。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { closeActivityHub } from "@taw/api/src/activityHub.js";
import type { FastifyInstance } from "fastify";
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

/** 打开真实 SSE 流并解析完整帧（含 id: 行，验证 Last-Event-ID 续传语义）。 */
async function openSse(base: string, path: string, opts: { session?: Session; lastEventId?: number } = {}): Promise<SseHandle> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (opts.session) headers.cookie = opts.session.cookie;
  if (opts.lastEventId !== undefined) headers["last-event-id"] = String(opts.lastEventId);
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
            // retry: 与 ": ping" 心跳注释帧不计入事件
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

const PORT = 4119;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M12 运行事件流实时推送（NOTIFY 替代轮询，真实 DeepSeek 运行）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let other: Session;
  let teamId = "";
  let sessionId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m12-${runId}@t.dev`, password: "password-123", displayName: "M12管理员", teamName: `M12团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m12other-${runId}@t.dev`, password: "password-123", displayName: "M12外团队", teamName: `M12外团队-${runId}` }),
    });
    other = sessionOf(o);
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M12项目-${runId}`, code: `m12${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    const sess = await call("POST", `/projects/${proj.json.projectId}/sessions`, {
      session: admin, body: { teamId, title: `M12流会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await closeActivityHub();
  });

  it("鉴权与边界：匿名 401/403；非成员 404；不存在的运行静默关闭", async () => {
    const anon = await openSse(BASE, `/runs/${randomUUID()}/events?teamId=${teamId}`);
    expect(anon.status === 401 || anon.status === 403, `匿名应 401/403，实际 ${anon.status}`).toBe(true);
    const outsider = await openSse(BASE, `/runs/${randomUUID()}/events?teamId=${teamId}`, { session: other });
    expect(outsider.status === 404, `非成员应 404，实际 ${outsider.status}`).toBe(true);
    // 本团队成员访问不存在的 run：流建立后应快速静默结束（不再无限等待）
    const missing = await openSse(BASE, `/runs/${randomUUID()}/events?teamId=${teamId}`, { session: admin });
    expect(missing.status === 200, "成员访问应 200").toBe(true);
    const closed = await missing.waitForClose(8000);
    expect(closed, "不存在的运行应静默关闭流").toBe(true);
    expect(missing.events.length === 0, "不应有事件帧").toBe(true);
  });

  it("真实运行：run_started→completed→done 送达（订阅期间推送+重放共同覆盖），seq 严格递增", async () => {
    const created = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: { teamId, prompt: `请直接用一句话说明团队资产工作台的价值，不要调用任何工具。`, budget: { maxToolCalls: 2, maxTokens: 4000 } },
    });
    expectOk(created.status === 201, created.json, "创建运行失败");
    const rid = created.json.runId as string;

    // 运行进行中订阅：其余事件应经 NOTIFY 即时推送直至 done
    const live = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin });
    expect(live.status === 200, "SSE 应建立").toBe(true);
    const started = await live.waitFor((e) => e.event === "run_started", 20000, "等待 run_started 推送");
    expect(started.id > 0, "run_started 应带递增 seq").toBe(true);
    const completed = await live.waitFor((e) => e.event === "completed", 120000, "等待 completed 推送");
    const done = await live.waitFor((e) => e.event === "done", 15000, "等待 done");
    expect(JSON.parse(done.data).status === "completed", `done 应为 completed：${done.data}`).toBe(true);
    // 事件帧 seq 严格递增，且首帧是 run_started、completed 是最后一个事件
    const seqs = live.events.filter((e) => e.id > 0).map((e) => e.id);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]! > seqs[i - 1]!, `seq 应严格递增：${seqs.join(",")}`).toBe(true);
    }
    expect(live.events[0]!.event === "run_started", `首帧应为 run_started：${live.events[0]!.event}`).toBe(true);
    expect(seqs[seqs.length - 1] === completed.id, "completed 应是最后一个事件").toBe(true);
    live.close();
  }, 180000);

  it("Last-Event-ID 续传：部分重放只补其后的事件，done 仍正确", async () => {
    // 用上一次运行太耦合；本用例自建一次运行并等终态后验证重放
    const created = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: { teamId, prompt: `请直接回答"已完成"，不要调用任何工具。`, budget: { maxToolCalls: 2, maxTokens: 2000 } },
    });
    expectOk(created.status === 201, created.json, "创建运行失败");
    const rid = created.json.runId as string;
    const full = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin });
    await full.waitFor((e) => e.event === "done", 120000, "等待首次流 done");
    full.close();
    const all = full.events.filter((e) => e.id > 0);
    expect(all.length >= 2, `至少两个事件帧：${all.length}`).toBe(true);
    const mid = all[0]!.id;

    // 从第一个事件之后续传：只应收到其后的事件 + done
    const resumed = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin, lastEventId: mid });
    await resumed.waitFor((e) => e.event === "done", 15000, "等待续传 done");
    const resumedSeqs = resumed.events.filter((e) => e.id > 0).map((e) => e.id);
    expect(resumedSeqs.every((s) => s > mid), `续传帧必须大于游标：${resumedSeqs.join(",")}`).toBe(true);
    const expectedTail = all.filter((e) => e.id > mid).map((e) => `${e.id}:${e.event}`);
    const actualTail = resumed.events.filter((e) => e.id > 0).map((e) => `${e.id}:${e.event}`);
    expect(JSON.stringify(actualTail) === JSON.stringify(expectedTail), `续传序列应与全量尾部一致：${actualTail} vs ${expectedTail}`).toBe(true);
    resumed.close();
  }, 180000);
});
