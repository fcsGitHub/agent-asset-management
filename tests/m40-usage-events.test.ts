// M40 运行预算与用量可视化测试 —
// 1) 预算默认值真实落库（修复：创建端 .partial() 曾吞掉内层 default，预算闸门口径形同虚设）；
// 2) 运行期间 runner 发 usage 事件（tokens/toolCalls + 预算上限），SSE 原样送达，终态与 agent_runs.used 一致；
// 3) 会话运行历史端点返回 budget 列（界面历史元信息行依赖）。
// 全部真实集成：真实 PostgreSQL、真实 SSE、真实 DeepSeek。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { closeActivityHub } from "@taw/api/src/activityHub.js";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { loadEnvFile } from "@taw/agent-adapter/env";

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
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, timeoutMs: number, what: string): Promise<SseEvent>;
  close(): void;
}

/** 打开真实 SSE 流并解析完整帧（与 m12 同口径）。 */
async function openSse(base: string, path: string, opts: { session?: Session } = {}): Promise<SseHandle> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (opts.session) headers.cookie = opts.session.cookie;
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok || !res.body) throw new Error(`SSE 建立失败：HTTP ${res.status}`);
  const events: SseEvent[] = [];
  let notify: (() => void) | null = null;
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
    notify?.();
  })();
  return {
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
    close() { void reader.cancel().catch(() => undefined); },
  };
}

interface UsagePayload { toolCalls: number; tokens: number; maxToolCalls: number; maxTokens: number }

const PORT = 4140;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M40 运行预算默认值与用量事件流（真实 DeepSeek 运行）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let sessionId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m40-${runId}@t.dev`, password: "password-123", displayName: "M40管理员", teamName: `M40团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M40项目-${runId}`, code: `m40${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    const sess = await call("POST", `/projects/${proj.json.projectId}/sessions`, {
      session: admin, body: { teamId, title: `M40会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    sessionId = sess.json.sessionId;
  }, 60000);

  afterAll(async () => {
    await app.close();
    await closeActivityHub();
  });

  it("省略 budget 创建运行：默认值 8/20000 真实落库（不再因 .partial() 吞默认而失效）", async () => {
    const created = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: { teamId, prompt: `请直接回答"已完成"，不要调用任何工具。` },
    });
    expectOk(created.status === 201, created.json, "创建运行失败");
    const rid = created.json.runId as string;
    const got = await call("GET", `/runs/${rid}?teamId=${teamId}`, { session: admin });
    expectOk(got.status === 200, got.json, "读取运行失败");
    const budget = got.json.budget as { maxToolCalls?: number; maxTokens?: number };
    expect(budget?.maxToolCalls === 8 && budget?.maxTokens === 20000,
      `默认预算应落库为 8/20000，实际 ${JSON.stringify(budget)}`).toBe(true);
    // 等运行终结，避免悬空执行器拖住 afterAll
    const sse = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin });
    await sse.waitFor((e) => e.event === "done", 120000, "等待运行终结");
    sse.close();
  }, 180000);

  it("部分提供 budget：缺失字段补默认值（maxTokens 5000 → maxToolCalls 8）", async () => {
    const created = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: { teamId, prompt: `请直接回答"好"，不要调用任何工具。`, budget: { maxTokens: 5000 } },
    });
    expectOk(created.status === 201, created.json, "创建运行失败");
    const got = await call("GET", `/runs/${created.json.runId}?teamId=${teamId}`, { session: admin });
    const budget = got.json.budget as { maxToolCalls?: number; maxTokens?: number };
    expect(budget?.maxToolCalls === 8 && budget?.maxTokens === 5000,
      `部分预算应补齐为 8/5000，实际 ${JSON.stringify(budget)}`).toBe(true);
    const sse = await openSse(BASE, `/runs/${created.json.runId}/events?teamId=${teamId}`, { session: admin });
    await sse.waitFor((e) => e.event === "done", 120000, "等待运行终结");
    sse.close();
  }, 180000);

  it("usage 事件随运行推送：上限随事件下发、tokens 单调不减、终态与 used 一致；历史端点返回 budget", async () => {
    const created = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin,
      body: {
        teamId,
        prompt: `请先用 asset.search 检索"轨道"，再用一句话总结检索结果。`,
        budget: { maxToolCalls: 4, maxTokens: 20000 },
      },
    });
    expectOk(created.status === 201, created.json, "创建运行失败");
    const rid = created.json.runId as string;
    const sse = await openSse(BASE, `/runs/${rid}/events?teamId=${teamId}`, { session: admin });
    await sse.waitFor((e) => e.event === "done", 150000, "等待运行终结");
    sse.close();

    const usages = sse.events.filter((e) => e.event === "usage")
      .map((e) => JSON.parse(e.data) as UsagePayload);
    expect(usages.length >= 1, `至少应有一个 usage 事件：${JSON.stringify(sse.events.map((e) => e.event))}`).toBe(true);
    for (const u of usages) {
      expect(u.maxToolCalls === 4 && u.maxTokens === 20000,
        `usage 应携带本次预算上限 4/20000：${JSON.stringify(u)}`).toBe(true);
      expect(u.tokens > 0, "tokens 应大于 0").toBe(true);
    }
    for (let i = 1; i < usages.length; i++) {
      expect(usages[i]!.tokens >= usages[i - 1]!.tokens, "tokens 应单调不减").toBe(true);
      expect(usages[i]!.toolCalls >= usages[i - 1]!.toolCalls, "toolCalls 应单调不减").toBe(true);
    }
    // 若发生了工具调用，工具结果之后必有 toolCalls≥1 的 usage（界面工具计数的实时来源）
    const sawTool = sse.events.some((e) => e.event === "tool_result");
    if (sawTool) {
      expect(usages.some((u) => u.toolCalls >= 1), "工具调用后应有 toolCalls≥1 的 usage 事件").toBe(true);
    }

    const got = await call("GET", `/runs/${rid}?teamId=${teamId}`, { session: admin });
    expectOk(got.status === 200, got.json, "读取运行失败");
    const used = got.json.used as { toolCalls: number; tokens: number } | null;
    const last = usages[usages.length - 1]!;
    if (got.json.status === "completed" && used) {
      expect(last.tokens === used.tokens && last.toolCalls === used.toolCalls,
        `终态 used 应与最后一条 usage 一致：used=${JSON.stringify(used)} usage=${JSON.stringify(last)}`).toBe(true);
    }

    const history = await call("GET", `/sessions/${sessionId}/runs?teamId=${teamId}`, { session: admin });
    expectOk(history.status === 200, history.json, "运行历史获取失败");
    const row = (history.json as { id: string; budget?: { maxToolCalls?: number; maxTokens?: number } }[])
      .find((r) => r.id === rid);
    expect(row?.budget?.maxToolCalls === 4 && row?.budget?.maxTokens === 20000,
      `历史端点应返回 budget：${JSON.stringify(row?.budget)}`).toBe(true);
  }, 240000);
});
