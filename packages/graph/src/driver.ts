// 图库（Bolt 协议，Memgraph）连接层。
// 图库是可再生投影：不可达不抛致命错误——上层一律转 GraphUnavailableError 做诚实降级。
import neo4j, { type Driver, type Session } from "neo4j-driver";

let driver: Driver | null = null;
let driverUrl = "";

function currentUrl(): string {
  return process.env.GRAPHDB_URL ?? "bolt://127.0.0.1:7687";
}

export function getGraphDriver(): Driver {
  const url = currentUrl();
  if (!driver || driverUrl !== url) {
    if (driver) {
      const old = driver;
      driver = null;
      void old.close().catch(() => undefined);
    }
    driverUrl = url;
    driver = neo4j.driver(url, undefined, {
      connectionTimeout: 2000,
      maxConnectionPoolSize: 10,
    });
  }
  return driver;
}

export class GraphUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`图数据库不可用：${(cause as Error | undefined)?.message ?? String(cause)}`);
    this.name = "GraphUnavailableError";
  }
}

export type GraphMode = "READ" | "WRITE";

/** 在图库会话中执行；任何失败都归一为 GraphUnavailableError（调用方决定降级还是 503）。 */
export async function withGraphSession<T>(mode: GraphMode, fn: (session: Session) => Promise<T>): Promise<T> {
  const session = getGraphDriver().session({
    defaultAccessMode: mode === "WRITE" ? neo4j.session.WRITE : neo4j.session.READ,
  });
  try {
    return await fn(session);
  } catch (err) {
    throw err instanceof GraphUnavailableError ? err : new GraphUnavailableError(err);
  } finally {
    await session.close().catch(() => undefined);
  }
}

/** 可达性探测：true/false，不抛出。 */
export async function graphPing(): Promise<boolean> {
  try {
    await withGraphSession("READ", async (session) => {
      await session.run("RETURN 1 AS ok");
      return true;
    });
    return true;
  } catch {
    return false;
  }
}

/** 进程退出时关闭连接（测试与优雅停机用）。 */
export async function closeGraph(): Promise<void> {
  if (driver) {
    const d = driver;
    driver = null;
    driverUrl = "";
    await d.close().catch(() => undefined);
  }
}
