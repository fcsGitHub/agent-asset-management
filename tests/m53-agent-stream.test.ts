// M53 集成测试 — 真实 DeepSeek 流式运行：message_delta 增量事件先于终值落库，
// 同回合内增量拼接与 message 终值一致（SSE 逐字流式的服务端真值校验）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { randomBytes } from "node:crypto";
import { loadEnvFile } from "@taw/agent-adapter/env";

loadEnvFile();
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

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
}

const PORT = 4136;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M53 真实 LLM 流式运行（DeepSeek，真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let adminPool: Pool;
  let teamId = "", projectId = "", sessionId = "";

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m53stream-${runId}@t.dev`, password: "password-123", displayName: "流式管理员", teamName: `流式团队-${runId}` }),
    });
    admin = sessionOf(reg);
    teamId = ((await reg.json()) as { teamId: string }).teamId;
    const proj = await fetch(`${BASE}/projects`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ teamId, name: "流式验证", code: `stream-${runId}` }),
    });
    const projBody = await proj.text();
    expectOk(proj.status === 201, projBody, "项目创建失败");
    projectId = (JSON.parse(projBody) as { projectId: string }).projectId;
    const sess = await fetch(`${BASE}/projects/${projectId}/sessions`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ teamId, title: "流式测试", visibility: "project" }),
    });
    const sessBody = await sess.text();
    expectOk(sess.status === 201, sessBody, "Session 创建失败");
    sessionId = (JSON.parse(sessBody) as { sessionId: string }).sessionId;
  });
  afterAll(async () => {
    await app.close();
    await adminPool.end();
  });

  it("运行全程产出 message_delta 增量，拼接值与 message 终值一致", async () => {
    const create = await fetch(`${BASE}/sessions/${sessionId}/runs`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({
        teamId,
        prompt: "用一句中文说明：为什么资产管理要给资产之间建立关系？不要调用任何工具，直接回答。",
        budget: { maxToolCalls: 1, maxTokens: 800 },
      }),
    });
    const createBody = await create.text();
    expectOk(create.status === 201, createBody, "运行创建失败");
    const { runId: rid } = (JSON.parse(createBody) as { runId: string });

    // 等待终态（真实模型，180s 上限）
    const start = Date.now();
    let status = "", result = "";
    while (Date.now() - start < 180000) {
      const res = await fetch(`${BASE}/runs/${rid}?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
      const run = (await res.json()) as { status: string; result: string };
      status = run.status;
      result = run.result ?? "";
      if (status !== "queued" && status !== "running") break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    expectOk(status === "completed", { status, result }, "运行应完成（非流式改造不应破坏既有链路）");

    // 直查 run_events（真实落库）：message_delta 全部属于回合 0，拼接值 = message 终值
    const { rows } = await adminPool.query<{ type: string; payload: { delta?: string; turn?: number; role?: string; text?: string } }>(
      `SELECT type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 ORDER BY seq`,
      [teamId, rid]
    );
    const deltas = rows.filter((r) => r.type === "message_delta");
    // 短回答可能整体落在 300ms 合帧窗口内（仅 1 条增量）：正确性不变量是「拼接=终值」，
    // 条数不作硬断言（避免对网络速度/负载脆弱）。
    expectOk(deltas.length >= 1, deltas.length, "流式运行应产出 message_delta 增量");
    for (const d of deltas) expect(d.payload.turn).toBe(0);
    const concat = deltas.map((d) => d.payload.delta ?? "").join("");
    const message = rows.find((r) => r.type === "message" && r.payload.role === "assistant");
    expectOk(!!message, rows.map((r) => r.type), "应有 message 终值事件");
    expect(concat, `增量拼接应等于终值：concat=${concat.slice(0, 80)}… msg=${(message!.payload.text ?? "").slice(0, 80)}…`)
      .toBe(message!.payload.text);
    expect(result, "agent_runs.result 与终值一致").toBe(message!.payload.text);

    // 事件次序：增量先于终值（先事件后状态的不变量下，SSE 订阅方不会看到晚到的终值）
    const deltaLastSeq = rows.findIndex((r) => r.type === "message_delta");
    const messageSeq = rows.findIndex((r) => r.type === "message");
    expect(deltaLastSeq).toBeLessThan(messageSeq);
  }, 200000);
});
