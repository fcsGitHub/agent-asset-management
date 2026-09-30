// 数据库访问层。应用始终以受限角色 taw_app 连接；
// 所有租户表查询必须在 withTeam 事务内执行（RLS 依赖 SET LOCAL app.team_id）。
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";

function loadEnvFile(): void {
  try {
    const content = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* 无 .env 时依赖真实环境变量 */
  }
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    loadEnvFile();
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 未设置");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
    });
    // 空闲连接错误（如数据库重启 57P01）：记录并让连接池自动重建，不崩溃进程
    pool.on("error", (err) => {
      console.error("pg pool idle-client error:", err.message);
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** 非 RLS 的全局查询（users/teams/auth_sessions/team_members）。 */
export async function q<T = unknown>(
  text: string,
  params?: unknown[]
): Promise<{ rows: T[]; rowCount: number | null }> {
  const res = await getPool().query(text, params as never[]);
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

/** 全局表事务（无租户上下文）。 */
export async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 连接已损坏时忽略 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 租户上下文事务：BEGIN → SET LOCAL app.team_id → handler → COMMIT。
 * RLS 策略读取 app.team_id；未设置时所有租户行不可见、写入被拒。
 */
export async function withTeam<T>(
  teamId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 连接已损坏时忽略 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * 公开分享读事务（M67⑤）：只开 app.share_read 这一个非租户读通道——
 * asset_collection_snapshots 的 public_share_read 策略据此放行 SELECT；
 * 其余租户表没有同名策略，照常不可见。仅分享查看端点使用。
 */
export async function withShareRead<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.share_read', 'on', true)");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 连接已损坏时忽略 */
    }
    throw err;
  } finally {
    client.release();
  }
}
