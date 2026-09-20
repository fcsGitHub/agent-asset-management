// M6 outbox 派发器测试 — 租约 + 至少一次投递（真实 HTTP 接收端 + 真实 PostgreSQL）。
// 不 mock：接收端是测试内启动的真实 HTTP 服务器；失败/重试/租约语义全部真实执行。
// 注意：派发器按设计处理全库未投递事件（开发库可能含历史遗留事件），断言只针对本次播种的事件。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { dispatchOnce } from "@taw/worker/dispatcher";

const WORKER_DB = "postgres://taw_worker:taw_worker_dev@127.0.0.1:5437/taw";
const APP_DB = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

interface Received { eventId: string; attempt: number; eventType: string }

async function seedEvent(teamId: string, eventId: string): Promise<number> {
  const c = new Client({ connectionString: APP_DB });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO outbox (team_id, event_id, event_type, aggregate, payload)
       VALUES ($1, $2, 'test.event', 'test', $3::jsonb) RETURNING id`,
      [teamId, eventId, JSON.stringify({ hello: eventId.slice(0, 8) })]
    );
    await c.query("COMMIT");
    return rows[0]!.id;
  } finally {
    await c.end();
  }
}

async function outboxRow(teamId: string, eventId: string): Promise<{ delivered_at: Date | null; attempts: number; last_error: string; lease_until: Date | null }> {
  const c = new Client({ connectionString: WORKER_DB });
  await c.connect();
  try {
    const { rows } = await c.query(
      `SELECT delivered_at, attempts, last_error, lease_until FROM outbox WHERE team_id = $1 AND event_id = $2`,
      [teamId, eventId]
    );
    return rows[0]!;
  } finally {
    await c.end();
  }
}

describe("M6 outbox 派发器（真实 HTTP + PG）", () => {
  let server: Server, baseUrl = "";
  let received: Received[] = [];
  let failIds = new Set<string>();

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const ev = JSON.parse(body) as { eventId: string; deliveryAttempt: number; eventType: string };
        if (failIds.has(ev.eventId)) {
          res.writeHead(500);
          res.end("boom");
          return;
        }
        received.push({ eventId: ev.eventId, attempt: ev.deliveryAttempt, eventType: ev.eventType });
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}/outbox`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("未配置接收端时显式 skipped，不触碰任何事件", async () => {
    const s = await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: "" });
    expect(s.skipped).toBe(true);
    expect(s.leased).toBe(0);
  });

  it("投递成功：事件到达真实 HTTP 端点、payload 带 eventId、delivered_at 落库", async () => {
    const teamId = randomUUID();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids) await seedEvent(teamId, id);

    const s = await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    expect(s.leased).toBeGreaterThanOrEqual(3);
    expect(s.failed).toBe(0);
    for (const id of ids) {
      const hits = received.filter((r) => r.eventId === id);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.attempt).toBe(1);
      expect(hits[0]!.eventType).toBe("test.event");
      const row = await outboxRow(teamId, id);
      expect(row.delivered_at).not.toBeNull();
      expect(row.attempts).toBe(1);
    }
    // 已投递事件不会被再次租约投递（至少一次 + 恰好标记）
    received = [];
    await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    for (const id of ids) {
      expect(received.filter((r) => r.eventId === id)).toHaveLength(0);
    }
  });

  it("失败与重试：接收端 500 → 未投递、attempts 递增、错误入账；恢复后重投成功（至少一次）", async () => {
    const teamId = randomUUID();
    const id = randomUUID();
    await seedEvent(teamId, id);
    failIds = new Set([id]);

    const fail1 = await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    expect(fail1.events.some((e) => e.eventId === id && !e.ok && e.error?.includes("500"))).toBe(true);
    let row = await outboxRow(teamId, id);
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("500");

    // 接收端恢复 → 下一轮投递成功，attempt=2
    failIds = new Set();
    received = [];
    const retry = await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    expect(retry.delivered).toBeGreaterThanOrEqual(1);
    row = await outboxRow(teamId, id);
    expect(row.delivered_at).not.toBeNull();
    expect(row.attempts).toBe(2);
    const got = received.find((r) => r.eventId === id)!;
    expect(got.attempt).toBe(2);
  });

  it("租约保护：租约未过期的事件不被重复租约投递（并发安全语义）", async () => {
    const teamId = randomUUID();
    const id = randomUUID();
    const rowId = await seedEvent(teamId, id);
    // 手动置有效租约（模拟另一 worker 正在投递）
    const c = new Client({ connectionString: WORKER_DB });
    await c.connect();
    await c.query(`UPDATE outbox SET lease_until = now() + interval '60 seconds', attempts = 1 WHERE id = $1`, [rowId]);
    await c.end();

    failIds = new Set();
    received = [];
    await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    expect(received.filter((r) => r.eventId === id)).toHaveLength(0);
    const row = await outboxRow(teamId, id);
    expect(row.delivered_at).toBeNull();
    expect(row.attempts).toBe(1); // 租约期内 attempts 不增长
  });

  it("慢车道：超过尝试上限后保持未投递事实，且进入长退避（不无限高频重试）", async () => {
    const teamId = randomUUID();
    const id = randomUUID();
    const rowId = await seedEvent(teamId, id);
    // 预置 attempts 已达上限
    const c = new Client({ connectionString: WORKER_DB });
    await c.connect();
    await c.query(`UPDATE outbox SET attempts = 12 WHERE id = $1`, [rowId]);
    await c.end();

    failIds = new Set([id]);
    await dispatchOnce({ databaseUrl: WORKER_DB, dispatchUrl: baseUrl });
    const row = await outboxRow(teamId, id);
    expect(row.delivered_at).toBeNull();
    expect(row.lease_until).not.toBeNull();
    expect(new Date(row.lease_until!).getTime() - Date.now()).toBeGreaterThan(55 * 60 * 1000);
  });
});
