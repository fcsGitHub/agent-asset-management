// 活动流 / 运行事件实时推送枢纽：Postgres LISTEN/NOTIFY → 按团队扇出 SSE。
// 数据链路（完全事件驱动，非轮询）：
//   触发器（0018 活动流、0019 运行事件）在落库的事务提交时 pg_notify
//   → 本模块的单例 LISTEN 连接收到通知（只含定位信息）
//   → 扇出给订阅者回调；事件正文由各订阅连接实时取
//     （与对应 GET 接口同一查询语义），保证推送内容与拉取接口同源。
// LISTEN 连接只收通知、不查表（无租户上下文需求）。
//
// 自愈（M19）：LISTEN 连接是单点——静默断链（网络分区/Postgres 重启且 TCP 未报错）
// 不会触发 error 事件，通知就此丢失。因此：
//   1) 周期健康探测（SELECT 1 带超时）主动发现死链并拆除；
//   2) 指数退避重连链（500ms 起步、封顶 8s），Postgres 恢复后自动重新 LISTEN；
//   3) 重连成功时向所有既有订阅者发 resync 信号：运行流按 DB 游标精确补取断窗事件
//      （seq 单调，恰好一次），活动流转发 SSE resync 帧、客户端重取历史对齐。
// 断窗内的事件不虚构：能精确补的补（运行流），不能精确补的明确要求重取（活动流），
// 不存在"假装没断过"的静默丢失。
import { Client } from "pg";
import { getPool } from "./db.js";

export interface ActivityNotification {
  kind: "audit" | "agent";
  team_id: string;
  id: string;
}

export type ActivitySignal = ActivityNotification | { resync: true };

export type RunNotification =
  | { type: "event"; team_id: string; run_id: string; seq: number }
  | { type: "status"; team_id: string; run_id: string }
  | { type: "resync" };

type Subscriber = (n: ActivitySignal) => void;
type RunSubscriber = (n: RunNotification) => void;

const subscribers = new Map<string, Set<Subscriber>>();
const runSubscribers = new Map<string, Set<RunSubscriber>>(); // key: `${teamId}:${runId}`
let listenClient: Client | null = null;
let connecting: Promise<void> | null = null;
let reconnectAttempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;

function parseActivity(raw: string): ActivityNotification | null {
  try {
    const v = JSON.parse(raw) as { kind?: string; team_id?: string; id?: string };
    if ((v.kind !== "audit" && v.kind !== "agent") || !v.team_id || !v.id) return null;
    return { kind: v.kind, team_id: v.team_id, id: v.id };
  } catch {
    return null;
  }
}

function parseRun(raw: string): Exclude<RunNotification, { type: "resync" }> | null {
  try {
    const v = JSON.parse(raw) as { type?: string; team_id?: string; run_id?: string; seq?: string };
    if (!v.team_id || !v.run_id) return null;
    if (v.type === "event") {
      const seq = Number(v.seq);
      if (!Number.isFinite(seq)) return null;
      return { type: "event", team_id: v.team_id, run_id: v.run_id, seq };
    }
    if (v.type === "status") return { type: "status", team_id: v.team_id, run_id: v.run_id };
    return null;
  } catch {
    return null;
  }
}

/** 重连成功且存在既有订阅者时扇出 resync：订阅方按各自游标/重取语义补齐断窗。 */
function fanoutResync(): void {
  for (const set of subscribers.values()) {
    for (const sub of set) {
      try { sub({ resync: true }); } catch { /* 单个订阅者失败不影响其他 */ }
    }
  }
  for (const set of runSubscribers.values()) {
    for (const sub of set) {
      try { sub({ type: "resync" }); } catch { /* 单个订阅者失败不影响其他 */ }
    }
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  if (subscribers.size === 0 && runSubscribers.size === 0) return;
  const base = Number(process.env.TAW_LISTEN_BACKOFF_MS ?? 500);
  const delay = Math.min((Number.isFinite(base) && base > 0 ? base : 500) * 2 ** reconnectAttempts, 8000);
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void ensureListening()
      .then(() => { reconnectAttempts = 0; })
      .catch(() => scheduleReconnect());
  }, delay);
  reconnectTimer.unref?.();
}

function teardownListener(reason: string): void {
  const c = listenClient;
  listenClient = null;
  connecting = null;
  if (c) void c.end().catch(() => undefined);
  console.error(`activity listen dropped (${reason}); reconnect scheduled`);
  scheduleReconnect();
}

function startHealthProbe(): void {
  if (healthTimer) return;
  healthTimer = setInterval(() => {
    const c = listenClient;
    if (!c) return; // 未连接由重连链负责
    const timeout = new Promise<never>((_, rej) => {
      const t = setTimeout(() => rej(new Error("health probe timeout")), 5000);
      t.unref();
    });
    timeout.catch(() => undefined); // 竞态败方的 rejection 不能成为 unhandled
    Promise.race([c.query("SELECT 1"), timeout]).catch(() => {
      if (listenClient === c) teardownListener("health probe failed");
    });
  }, 15000);
  healthTimer.unref?.();
}

async function ensureListening(): Promise<void> {
  if (listenClient) return;
  if (connecting) return connecting;
  const p = (async () => {
    getPool(); // 确保 .env 已加载、DATABASE_URL 就绪
    // application_name 供 pg_stat_activity 识别本连接（运维排障与断线注入测试都靠它精确定位）
    const client = new Client({ connectionString: process.env.DATABASE_URL, application_name: "taw_activity_hub" });
    client.on("notification", (msg) => {
      if (msg.channel === "taw_activity" && msg.payload) {
        const n = parseActivity(msg.payload);
        if (!n) return;
        for (const sub of subscribers.get(n.team_id) ?? []) {
          try { sub(n); } catch { /* 单个订阅者失败不影响其他 */ }
        }
        return;
      }
      if (msg.channel === "taw_run" && msg.payload) {
        const n = parseRun(msg.payload);
        if (!n) return;
        for (const sub of runSubscribers.get(`${n.team_id}:${n.run_id}`) ?? []) {
          try { sub(n); } catch { /* 单个订阅者失败不影响其他 */ }
        }
      }
    });
    client.on("end", () => {
      if (listenClient === client) teardownListener("connection ended");
    });
    client.on("error", (err) => {
      console.error("activity listen error:", err.message);
      if (listenClient === client) teardownListener("connection error");
    });
    await client.connect();
    await client.query("LISTEN taw_activity");
    await client.query("LISTEN taw_run");
    listenClient = client;
    startHealthProbe();
    // 断窗恢复：有订阅者经历过通知缺口，扇出 resync 让各订阅方按自身语义补齐
    if (subscribers.size > 0 || runSubscribers.size > 0) fanoutResync();
  })();
  connecting = p;
  // 连接期失败（Postgres 暂不可达）：清空缓存，否则后续调用永远拿到同一个被拒 promise
  p.catch(() => {
    if (connecting === p) connecting = null;
    scheduleReconnect();
  });
  return p;
}

/** 注册某团队的活动订阅；返回取消函数。首次订阅时建立 LISTEN 连接。 */
export async function subscribeActivity(teamId: string, sub: Subscriber): Promise<() => void> {
  await ensureListening();
  let set = subscribers.get(teamId);
  if (!set) {
    set = new Set();
    subscribers.set(teamId, set);
  }
  set.add(sub);
  return () => {
    const s = subscribers.get(teamId);
    if (!s) return;
    s.delete(sub);
    if (s.size === 0) subscribers.delete(teamId);
  };
}

/** 注册某运行的 run_events / 状态变化订阅；返回取消函数。 */
export async function subscribeRunEvents(teamId: string, runId: string, sub: RunSubscriber): Promise<() => void> {
  await ensureListening();
  const key = `${teamId}:${runId}`;
  let set = runSubscribers.get(key);
  if (!set) {
    set = new Set();
    runSubscribers.set(key, set);
  }
  set.add(sub);
  return () => {
    const s = runSubscribers.get(key);
    if (!s) return;
    s.delete(sub);
    if (s.size === 0) runSubscribers.delete(key);
  };
}

/** 测试与运维自检：LISTEN 连接是否存活。 */
export function isListening(): boolean {
  return listenClient !== null;
}

/** 测试收尾：关闭 LISTEN 连接与自愈定时器（进程退出由 closePool 之外单独调用）。 */
export async function closeActivityHub(): Promise<void> {
  const c = listenClient;
  listenClient = null;
  connecting = null;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (c) await c.end().catch(() => undefined);
}
