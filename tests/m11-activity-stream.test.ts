// M11 活动流实时推送测试 — Postgres 触发器 pg_notify（提交时投递）→ API LISTEN 扇出
// → SSE。全部真实集成：真实 PostgreSQL NOTIFY、真实 HTTP SSE 流、真实审计/运行落库。无轮询、无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import { closeActivityHub } from "@taw/api/src/activityHub.js";
import type { FastifyInstance } from "fastify";
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

interface SseEvent { event: string; data: string }
interface SseHandle {
  status: number;
  contentType?: string;
  events: SseEvent[];
  waitFor(pred: (e: SseEvent) => boolean, timeoutMs: number, what: string): Promise<SseEvent>;
  close(): void;
}

/** 打开真实 SSE 流并解析事件帧（fetch 流式读取，非 EventSource——需要自定义会话头）。 */
async function openSse(base: string, path: string, session?: Session): Promise<SseHandle> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (session) headers.cookie = session.cookie;
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok || !res.body) {
    return { status: res.status, contentType: res.headers.get("content-type") ?? "", events: [],
      waitFor: async () => { throw new Error("流未建立"); }, countSince: () => 0, close: () => undefined };
  }
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
          for (const l of frame.split("\n")) {
            if (l.startsWith("event:")) event = l.slice(6).trim();
            else if (l.startsWith("data:")) data += l.slice(5).trim();
          }
          events.push({ event, data });
          notify?.();
        }
      }
    } catch { /* 连接被客户端关闭 */ }
  })();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    events,
    async waitFor(pred, timeoutMs, what) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const hit = events.find(pred);
        if (hit) return hit;
        await Promise.race([
          new Promise((r) => setTimeout(r, 150)),
          new Promise<void>((r) => { notify = r; }),
        ]);
        notify = null;
      }
      throw new Error(`SSE 等待超时（${what}）：已收 ${events.length} 帧 ${JSON.stringify(events.slice(0, 6)).slice(0, 400)}`);
    },
    close() { void reader.cancel().catch(() => undefined); },
  };
}

const PORT = 4118;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

async function register(base: string, email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, "注册失败").toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M11 活动流实时推送（Postgres NOTIFY → SSE，真实事件驱动）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let other: Session;
  let teamId = "";
  let otherTeamId = "";
  let projectId = "";
  let docTypeId = "";
  let assetA = "";
  let assetOther = "";
  const call = caller(BASE);

  async function mkAsset(session: Session, team: string, typeId: string, name: string): Promise<string> {
    const r = await call("POST", "/assets", {
      session,
      body: {
        teamId: team, name, typeVersionId: typeId,
        properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M11" },
      },
    });
    expectOk(r.status === 201, r.json, `建资产失败：${name}`);
    return r.json.assetId;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(BASE, `m11-${runId}@t.dev`, "M11管理员", `M11团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const o = await register(BASE, `m11other-${runId}@t.dev`, "M11外团队", `M11外团队-${runId}`);
    other = o.session; otherTeamId = o.teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M11项目-${runId}`, code: `m11${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const otherTypes = await call("GET", `/types?teamId=${otherTeamId}`, { session: other });
    const otherDocId = (otherTypes.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    assetA = await mkAsset(admin, teamId, docTypeId, `M11审计资产-${runId}`);
    assetOther = await mkAsset(other, otherTeamId, otherDocId, `M11外部资产-${runId}`);
  }, 60000);

  afterAll(async () => {
    await app.close();
    await closeActivityHub();
  });

  it("鉴权：匿名 401/403，非本团队成员 404", async () => {
    const anon = await openSse(BASE, `/activity/stream?teamId=${teamId}`);
    expect(anon.status === 401 || anon.status === 403, `匿名应 401/403，实际 ${anon.status}`).toBe(true);
    const outsider = await openSse(BASE, `/activity/stream?teamId=${teamId}`, other);
    expect(outsider.status === 404, `非成员应 404，实际 ${outsider.status}`).toBe(true);
  });

  it("审计事件实时推送：归档落库即收到 activity 事件，内容与列表接口同源", async () => {
    const stream = await openSse(BASE, `/activity/stream?teamId=${teamId}`, admin);
    expect(stream.status === 200, "SSE 应建立").toBe(true);
    expect(String(stream.contentType).includes("text/event-stream"), "content-type 应为 text/event-stream").toBe(true);
    // 给连接建立与 LISTEN 订阅留出时间
    await new Promise((r) => setTimeout(r, 400));
    const baseCount = stream.events.filter((e) => e.event === "activity").length;

    const t0 = Date.now();
    const arch = await call("POST", `/assets/${assetA}/archive`, { session: admin, body: { teamId, reason: "M11 实时推送验证" } });
    expectOk(arch.status === 200, arch.json, "归档失败");
    const hit = await stream.waitFor(
      (e) => {
        if (e.event !== "activity") return false;
        const d = JSON.parse(e.data) as { kind: string; action: string; summary: string; actor: string; key: string };
        return d.kind === "audit" && d.action === "asset.archive";
      },
      15000,
      "等待归档审计推送"
    );
    const d = JSON.parse(hit.data) as { kind: string; action: string; summary: string; actor: string; key: string; ts: string };
    expect(d.summary === "归档资产", `summary 应与列表接口同源：${d.summary}`).toBe(true);
    expect(d.actor === "M11管理员", `actor 应为操作者：${d.actor}`).toBe(true);
    expect(d.key.startsWith("audit:"), `事件应带稳定 key：${d.key}`).toBe(true);
    expect(typeof d.ts === "string" && d.ts.length > 0, "应带时间戳").toBe(true);
    expect(Date.now() - t0 < 15000, "推送应在动作后即时到达").toBe(true);
    expect(stream.events.filter((e) => e.event === "activity").length > baseCount, "事件计数应增加").toBe(true);
    stream.close();
  });

  it("团队隔离：其他团队的审计动作不会推送到本团队流", async () => {
    const stream = await openSse(BASE, `/activity/stream?teamId=${teamId}`, admin);
    await new Promise((r) => setTimeout(r, 400));
    const baseCount = stream.events.length;
    // 外团队动作（归档外团队资产）
    const archOther = await call("POST", `/assets/${assetOther}/archive`, { session: other, body: { teamId: otherTeamId, reason: "M11 隔离验证" } });
    expectOk(archOther.status === 200, archOther.json, "外团队归档失败");
    // 有界窗口内外团队事件不得到达
    await new Promise((r) => setTimeout(r, 4000));
    const leaked = stream.events.slice(baseCount).filter((e) => {
      if (e.event !== "activity") return false;
      const d = JSON.parse(e.data) as { actor?: string };
      return d.actor === "M11外团队";
    });
    expect(leaked.length === 0, `外团队事件泄漏 ${leaked.length} 条`).toBe(true);
    stream.close();
  });

  it("Agent 运行实时推送：创建运行即收到 agent 事件（按运行 id 稳定 key），取消后终止", async () => {
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: admin, body: { teamId, title: `M11流验证会话`, visibility: "project" },
    });
    expectOk(sess.status === 201, sess.json, "建会话失败");
    const sessionId = sess.json.sessionId;
    const stream = await openSse(BASE, `/activity/stream?teamId=${teamId}`, admin);
    await new Promise((r) => setTimeout(r, 400));
    const run = await call("POST", `/sessions/${sessionId}/runs`, {
      session: admin, body: { teamId, prompt: `请分别检索关键词 "轨道"、"推进"、"仿真" 三次，每次说明结果，然后总结。` },
    });
    expectOk(run.status === 201, run.json, "创建运行失败");
    const newRunId = run.json.runId as string;
    const hit = await stream.waitFor(
      (e) => {
        if (e.event !== "activity") return false;
        return (JSON.parse(e.data) as { key?: string }).key === `agent:${newRunId}`;
      },
      15000,
      "等待 Agent 运行推送"
    );
    const d = JSON.parse(hit.data) as { kind: string; action: string; actor: string; project?: string };
    expect(d.kind === "agent", "应为 agent 事件").toBe(true);
    expect(d.action.startsWith("agent.run."), `action 应为运行状态：${d.action}`).toBe(true);
    expect(d.project === `M11项目-${runId}`, `应带项目名：${d.project}`).toBe(true);
    // 同一运行的后续状态变化应按 key 原地更新（再次收到相同 key）
    await call("POST", `/runs/${newRunId}/cancel`, { session: admin, body: { teamId, reason: "M11 验证完成" } });
    const update = await stream.waitFor(
      (e) => e.event === "activity" && (JSON.parse(e.data) as { key?: string }).key === `agent:${newRunId}`
        && (JSON.parse(e.data) as { action?: string }).action === "agent.run.cancelled",
      30000,
      "等待取消状态推送"
    );
    expect(JSON.parse(update.data).action === "agent.run.cancelled", "取消状态应实时推送").toBe(true);
    stream.close();
  }, 90000);
});
