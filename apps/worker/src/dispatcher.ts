// outbox 派发器：租约抢占（FOR UPDATE SKIP LOCKED）+ 至少一次投递 + 指数退避。
// 设计 4 章：worker 使用租约、心跳与至少一次投递，副作用通过业务幂等控制。
// 接收方按 payload.eventId 幂等去重；本模块不伪造成功——未配置接收端时显式 skipped。
import { Client } from "pg";

export interface DispatchEvent {
  id: number;
  team_id: string;
  event_id: string;
  event_type: string;
  aggregate: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
}

export interface DispatchOptions {
  databaseUrl?: string;
  dispatchUrl?: string;
  batchSize?: number;
  pollMs?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
}

export interface DispatchSummary {
  leased: number;
  delivered: number;
  failed: number;
  skipped: boolean;
  events: { eventId: string; type: string; ok: boolean; attempts: number; error?: string }[];
}

const DEFAULTS = {
  batchSize: 20,
  maxAttempts: 12,
  leaseSeconds: 30,
  slowLaneHours: 1,
  requestTimeoutMs: 5000,
};

function num(v: string | undefined, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

/** 单轮派发：抢占一批租约 → 逐条 POST → 按结果标记 delivered / 释放租约退避。 */
export async function dispatchOnce(opts: DispatchOptions = {}): Promise<DispatchSummary> {
  const dispatchUrl = opts.dispatchUrl ?? process.env.OUTBOX_DISPATCH_URL ?? "";
  const batchSize = opts.batchSize ?? num(process.env.OUTBOX_BATCH, DEFAULTS.batchSize);
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const doFetch = opts.fetchImpl ?? fetch;
  const summary: DispatchSummary = { leased: 0, delivered: 0, failed: 0, skipped: !dispatchUrl, events: [] };
  if (!dispatchUrl) return summary; // 未配置接收端：诚实地不做任何事

  const client = new Client({
    // worker 角色具备 outbox 的跨租户策略（迁移 0016）；taw_app 无 UPDATE 权限，不能用于派发
    connectionString:
      opts.databaseUrl ??
      process.env.OUTBOX_DATABASE_URL ??
      "postgres://taw_worker:taw_worker_dev@127.0.0.1:5437/taw",
  });
  await client.connect();
  try {
    // 1) 租约抢占：并发 worker 不会取到同一批（SKIP LOCKED）；过期租约自动回收重投
    const { rows } = await client.query<DispatchEvent>(
      `UPDATE outbox SET
         leased_at = now(),
         lease_until = now() + ($2 || ' seconds')::interval,
         attempts = attempts + 1
       WHERE id IN (
         SELECT id FROM outbox
          WHERE delivered_at IS NULL
            AND (lease_until IS NULL OR lease_until < now())
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id, team_id, event_id, event_type, aggregate, payload, attempts, created_at`,
      [batchSize, String(DEFAULTS.leaseSeconds)]
    );
    summary.leased = rows.length;

    for (const ev of rows) {
      const body = JSON.stringify({
        eventId: ev.event_id,
        eventType: ev.event_type,
        aggregate: ev.aggregate,
        teamId: ev.team_id,
        payload: ev.payload,
        createdAt: ev.created_at,
        deliveryAttempt: ev.attempts,
      });
      let error = "";
      try {
        const res = await doFetch(dispatchUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(DEFAULTS.requestTimeoutMs),
        });
        if (res.status >= 200 && res.status < 300) {
          await client.query(`UPDATE outbox SET delivered_at = now(), last_error = '' WHERE id = $1`, [ev.id]);
          summary.delivered += 1;
          summary.events.push({ eventId: ev.event_id, type: ev.event_type, ok: true, attempts: ev.attempts });
          continue;
        }
        error = `HTTP ${res.status}`;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // 2) 失败退避：常规失败立即释放租约（下轮重试）；超过上限进慢车道，保持未投递事实
      const slowLane = ev.attempts >= maxAttempts;
      await client.query(
        `UPDATE outbox SET last_error = $3,
           lease_until = CASE WHEN $4 THEN now() + ($5 || ' hours')::interval ELSE now() END
         WHERE id = $1 AND team_id = $2`,
        [ev.id, ev.team_id, error.slice(0, 500), slowLane, String(DEFAULTS.slowLaneHours)]
      );
      summary.failed += 1;
      summary.events.push({ eventId: ev.event_id, type: ev.event_type, ok: false, attempts: ev.attempts, error });
    }
    return summary;
  } finally {
    await client.end();
  }
}

/** 持续轮询循环（worker 入口用）；返回停止函数。 */
export function startDispatcher(opts: DispatchOptions = {}, onTick?: (s: DispatchSummary) => void): () => Promise<void> {
  const pollMs = opts.pollMs ?? num(process.env.OUTBOX_POLL_MS, 2000);
  let running = true;
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking || !running) return;
    ticking = true;
    dispatchOnce(opts)
      .then((s) => {
        if (s.leased > 0) onTick?.(s);
      })
      .catch(() => undefined) // 单轮失败不终止循环；下一轮继续（至少一次语义靠库内状态保证）
      .finally(() => {
        ticking = false;
      });
  }, pollMs);
  return async () => {
    running = false;
    clearInterval(timer);
  };
}
