// 图投影对账器（M49）：worker 托管的图库重建循环。
// 职责：处理 API 写路径盖的脏标记（graph_sync_state），并在启动时做全团队漂移对账——
// 图库是可再生投影（容器重建/内存丢失后自动恢复），PostgreSQL 是唯一事实源。
// 对账口径：图节点数 = 资产数 + 活跃类数；图边数 = OF_TYPE(资产数) + RELATES(存活断言数) + SUBCLASS_OF(带父类类数)。
import { Client } from "pg";
import {
  GraphUnavailableError,
  graphCounts,
  graphPing,
  listDirtyTeams,
  listTeamsWithAssets,
  pgSourceCounts,
  recordSyncFailure,
  syncTeamAndRecord,
  type PgExec,
} from "@taw/graph";

export interface ReconcileSummary {
  teams: string[];
  synced: number;
  failed: number;
}

export interface DriftSummary extends ReconcileSummary {
  skipped: boolean; // 图库不可达：诚实跳过，不做半吊子对账
  checked: number;
}

function pollMs(): number {
  const n = Number(process.env.GRAPH_RECONCILE_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 5000;
}

function connectWorker(): Client {
  return new Client({
    connectionString:
      process.env.OUTBOX_DATABASE_URL ?? "postgres://taw_worker:taw_worker_dev@127.0.0.1:5437/taw",
  });
}

/** 处理全部脏团队一轮；图库不可达时逐团队如实留痕（下轮重试）。 */
export async function reconcileOnce(client: Client): Promise<ReconcileSummary> {
  const exec: PgExec = (sql, params) => client.query(sql, params as never[]);
  const teams = await listDirtyTeams(exec);
  const summary: ReconcileSummary = { teams, synced: 0, failed: 0 };
  for (const teamId of teams) {
    try {
      await syncTeamAndRecord(exec, teamId);
      summary.synced += 1;
    } catch (err) {
      summary.failed += 1;
      const msg = err instanceof GraphUnavailableError ? err.message : String((err as Error).message ?? err);
      await recordSyncFailure(exec, teamId, msg).catch(() => undefined);
    }
  }
  return summary;
}

/** 启动漂移对账：逐团队比较 PG 源计数与图库计数，不一致即全量重建。 */
export async function reconcileDrift(client: Client): Promise<DriftSummary> {
  if (!(await graphPing())) return { teams: [], synced: 0, failed: 0, skipped: true, checked: 0 };
  const exec: PgExec = (sql, params) => client.query(sql, params as never[]);
  const teams = await listTeamsWithAssets(exec);
  const summary: DriftSummary = { teams: [], synced: 0, failed: 0, skipped: false, checked: 0 };
  for (const teamId of teams) {
    summary.checked += 1;
    try {
      const [pg, graph] = await Promise.all([pgSourceCounts(exec, teamId), graphCounts(teamId)]);
      const expectedNodes = pg.assets + pg.types;
      const expectedEdges = pg.assets + pg.relations + pg.subclasses;
      if (graph.nodes !== expectedNodes || graph.edges !== expectedEdges) {
        await syncTeamAndRecord(exec, teamId);
        summary.teams.push(teamId);
        summary.synced += 1;
      }
    } catch (err) {
      summary.failed += 1;
      const msg = err instanceof GraphUnavailableError ? err.message : String((err as Error).message ?? err);
      await recordSyncFailure(exec, teamId, msg).catch(() => undefined);
    }
  }
  return summary;
}

export function startGraphReconciler(log: (msg: string) => void): { stop(): Promise<void> } {
  const client = connectWorker();
  let stopped = false;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  const runCycle = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const summary = await reconcileOnce(client);
      if (summary.teams.length > 0) {
        log(`graph reconcile: synced=${summary.synced} failed=${summary.failed} teams=${summary.teams.length}`);
      }
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      // 连接失败如实记录但不打断循环（PG 尚未就绪 / 图库离线都是常态降级）
      log(`graph reconcile error: ${msg.slice(0, 200)}`);
    } finally {
      running = false;
    }
  };

  async function start(): Promise<void> {
    try {
      await client.connect();
    } catch (err) {
      log(`graph reconciler: PG connect failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
      return; // 无 DB 连接：不做定时重建（dispatcher 亦无法工作），如实不假装在跑
    }
    // 启动漂移对账：图库容器重建/丢失后自动恢复投影
    log("graph drift check started (scanning all teams with assets…)");
    try {
      const drift = await reconcileDrift(client);
      log(
        drift.skipped
          ? `graph drift check skipped (graphdb unreachable — will retry via dirty marks)`
          : `graph drift check: teams=${drift.checked} resynced=${drift.synced} failed=${drift.failed}`
      );
    } catch (err) {
      log(`graph drift check error: ${String((err as Error).message ?? err).slice(0, 200)}`);
    }
    timer = setInterval(() => void runCycle(), pollMs());
    timer.unref();
    log(`graph reconciler started (poll=${pollMs()}ms)`);
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) clearInterval(timer);
    await client.end().catch(() => undefined);
  }

  void start();
  return { stop };
}
