// 活动流实时推送枢纽：Postgres LISTEN/NOTIFY → 按团队扇出 SSE。
// 数据链路（完全事件驱动，非轮询）：
//   触发器（0018）在 audit_events / agent_runs 落库的事务提交时 pg_notify('taw_activity')
//   → 本模块的单例 LISTEN 连接收到通知（只含 kind/team_id/id）
//   → 扇出给该团队所有 SSE 订阅者的回调；事件正文由各连接用 withTeam 实时取
//     （与 GET /activity 同一查询语义），保证推送内容与列表接口同源。
// LISTEN 连接只收通知、不查表（无租户上下文需求）；断线自动重连并重新 LISTEN。
import { Client } from "pg";
import { getPool } from "./db.js";

export interface ActivityNotification {
  kind: "audit" | "agent";
  team_id: string;
  id: string;
}

type Subscriber = (n: ActivityNotification) => void;

const subscribers = new Map<string, Set<Subscriber>>();
let listenClient: Client | null = null;
let connecting: Promise<void> | null = null;

function parseNotification(raw: string): ActivityNotification | null {
  try {
    const v = JSON.parse(raw) as { kind?: string; team_id?: string; id?: string };
    if ((v.kind !== "audit" && v.kind !== "agent") || !v.team_id || !v.id) return null;
    return { kind: v.kind, team_id: v.team_id, id: v.id };
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
      if (msg.channel !== "taw_activity" || !msg.payload) return;
      const n = parseNotification(msg.payload);
      if (!n) return;
      for (const sub of subscribers.get(n.team_id) ?? []) {
        try { sub(n); } catch { /* 单个订阅者失败不影响其他 */ }
      }
    });
    client.on("error", (err) => {
      console.error("activity listen error:", err.message);
      listenClient = null;
      connecting = null;
      // 有订阅者时自动重建 LISTEN 连接（指数不做，直接重连；pg Client 会重试连接）
      if (subscribers.size > 0) void ensureListening().catch(() => undefined);
    });
    await client.connect();
    await client.query("LISTEN taw_activity");
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
