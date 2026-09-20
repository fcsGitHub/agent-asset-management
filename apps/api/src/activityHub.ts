// 活动流 / 运行事件实时推送枢纽：Postgres LISTEN/NOTIFY → 按团队扇出 SSE。
// 数据链路（完全事件驱动，非轮询）：
//   触发器（0018 活动流、0019 运行事件）在落库的事务提交时 pg_notify
//   → 本模块的单例 LISTEN 连接收到通知（只含定位信息）
//   → 扇出给订阅者回调；事件正文由各订阅连接实时取
//     （与对应 GET 接口同一查询语义），保证推送内容与拉取接口同源。
// LISTEN 连接只收通知、不查表（无租户上下文需求）；断线自动重连并重新 LISTEN。
import { Client } from "pg";
import { getPool } from "./db.js";

export interface ActivityNotification {
  kind: "audit" | "agent";
  team_id: string;
  id: string;
}

export type RunNotification =
  | { type: "event"; team_id: string; run_id: string; seq: number }
  | { type: "status"; team_id: string; run_id: string };

type Subscriber = (n: ActivityNotification) => void;
type RunSubscriber = (n: RunNotification) => void;

const subscribers = new Map<string, Set<Subscriber>>();
const runSubscribers = new Map<string, Set<RunSubscriber>>(); // key: `${teamId}:${runId}`
let listenClient: Client | null = null;
let connecting: Promise<void> | null = null;

function parseActivity(raw: string): ActivityNotification | null {
  try {
    const v = JSON.parse(raw) as { kind?: string; team_id?: string; id?: string };
    if ((v.kind !== "audit" && v.kind !== "agent") || !v.team_id || !v.id) return null;
    return { kind: v.kind, team_id: v.team_id, id: v.id };
  } catch {
    return null;
  }
}

function parseRun(raw: string): RunNotification | null {
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

async function ensureListening(): Promise<void> {
  if (listenClient) return;
  if (connecting) return connecting;
  connecting = (async () => {
    getPool(); // 确保 .env 已加载、DATABASE_URL 就绪
    const client = new Client({ connectionString: process.env.DATABASE_URL });
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
    client.on("error", (err) => {
      console.error("activity listen error:", err.message);
      listenClient = null;
      connecting = null;
      // 有订阅者时自动重建 LISTEN 连接（pg Client 会重试连接）
      if (subscribers.size > 0 || runSubscribers.size > 0) void ensureListening().catch(() => undefined);
    });
    await client.connect();
    await client.query("LISTEN taw_activity");
    await client.query("LISTEN taw_run");
    listenClient = client;
  })();
  return connecting;
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

/** 测试收尾：关闭 LISTEN 连接（进程退出由 closePool 之外单独调用）。 */
export async function closeActivityHub(): Promise<void> {
  const c = listenClient;
  listenClient = null;
  connecting = null;
  if (c) await c.end().catch(() => undefined);
}
