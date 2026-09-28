// 投影：以 PostgreSQL 为唯一事实源，把团队本体子图幂等重建进图库。
// 图模型：
//   (:AssetType {teamId, typeKey, title, version})-[:SUBCLASS_OF]->(:AssetType)   —— 类层次（active 版本解析到 type_key 粒度）
//   (:Asset {teamId, assetId, name, lifecycle, kind, typeKey, typeTitle})-[:OF_TYPE]->(:AssetType)
//   (:Asset)-[:RELATES {relId, relKey}]->(:Asset)                                —— 存活关系断言
// 幂等策略：先 DETACH DELETE 团队全部图节点再重建（小团队图规模，全量重建毫秒级；
// 并发重建最后一写胜出且收敛一致，status 端点以计数对账兜底）。
import { withGraphSession } from "./driver.js";

export interface PgExec {
  (sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ProjectionResult {
  teamId: string;
  nodes: number;
  edges: number;
  types: number;
  assets: number;
  relations: number;
}

interface TypeRow { type_key: string; version: string; title: string; parent_key: string | null }
interface AssetRow { id: string; name: string; lifecycle: string; kind: string; type_key: string; type_title: string }
interface RelRow { id: string; rel_key: string; source_asset_id: string; target_asset_id: string }

async function readSource(exec: PgExec, teamId: string): Promise<{ types: TypeRow[]; assets: AssetRow[]; rels: RelRow[] }> {
  const [typesRes, assetsRes, relsRes] = await Promise.all([
    exec(
      // 每个类只投影 active 最新版本（图里类节点以 type_key 为身份；层次边按其 parent 解析）
      `SELECT DISTINCT ON (v.type_key) v.type_key, v.version, v.title, p.type_key AS parent_key
         FROM asset_type_versions v
         LEFT JOIN asset_type_versions p ON p.team_id = v.team_id AND p.id = v.parent_type_version_id
        WHERE v.team_id = $1 AND v.status = 'active'
        ORDER BY v.type_key, v.created_at DESC`,
      [teamId]
    ),
    exec(
      `SELECT a.id, a.name, a.lifecycle, e.kind, tv.type_key, tv.title AS type_title
         FROM assets a
         JOIN entities e ON e.team_id = a.team_id AND e.id = a.id
         JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
        WHERE a.team_id = $1`,
      [teamId]
    ),
    exec(
      `SELECT ra.id, rt.type_key AS rel_key, ra.source_asset_id, ra.target_asset_id
         FROM relation_assertions ra
         JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
        WHERE ra.team_id = $1 AND ra.status <> 'withdrawn'`,
      [teamId]
    ),
  ]);
  return {
    types: typesRes.rows as TypeRow[],
    assets: assetsRes.rows as AssetRow[],
    rels: relsRes.rows as RelRow[],
  };
}

async function ensureSchema(): Promise<void> {
  // 已存在时 Memgraph 返回错误——索引创建幂等，逐条吞掉重复创建
  const stmts = ["CREATE INDEX ON :Asset(teamId)", "CREATE INDEX ON :Asset(assetId)", "CREATE INDEX ON :AssetType(teamId)"];
  await withGraphSession("WRITE", async (session) => {
    for (const stmt of stmts) {
      try {
        await session.run(stmt);
      } catch (err) {
        const msg = String((err as Error).message ?? err);
        if (!/exist|equivalent/i.test(msg)) throw err;
      }
    }
  });
}

/** 全量幂等重建一个团队的子图；返回投影规模。图库不可达时抛 GraphUnavailableError。 */
export async function projectTeam(exec: PgExec, teamId: string): Promise<ProjectionResult> {
  const { types, assets, rels } = await readSource(exec, teamId);
  await ensureSchema();
  const typeEdges = types
    .filter((t) => t.parent_key)
    .map((t) => ({ child: t.type_key, parent: t.parent_key as string }));
  const ofType = assets.map((a) => ({ assetId: a.id, typeKey: a.type_key }));

  await withGraphSession("WRITE", async (session) => {
    await session.executeWrite(async (tx) => {
      await tx.run("MATCH (n) WHERE (n:Asset OR n:AssetType) AND n.teamId = $teamId DETACH DELETE n", { teamId });
      if (types.length > 0) {
        await tx.run(
          `UNWIND $rows AS row CREATE (t:AssetType {teamId: $teamId, typeKey: row.typeKey, title: row.title, version: row.version})`,
          { teamId, rows: types.map((t) => ({ typeKey: t.type_key, title: t.title, version: t.version })) }
        );
      }
      if (typeEdges.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
             MATCH (c:AssetType {teamId: $teamId, typeKey: row.child})
             MATCH (p:AssetType {teamId: $teamId, typeKey: row.parent})
           CREATE (c)-[:SUBCLASS_OF]->(p)`,
          { teamId, rows: typeEdges }
        );
      }
      if (assets.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
           CREATE (a:Asset {teamId: $teamId, assetId: row.assetId, name: row.name,
                            lifecycle: row.lifecycle, kind: row.kind,
                            typeKey: row.typeKey, typeTitle: row.typeTitle})`,
          {
            teamId,
            rows: assets.map((a) => ({
              assetId: a.id, name: a.name, lifecycle: a.lifecycle, kind: a.kind,
              typeKey: a.type_key, typeTitle: a.type_title,
            })),
          }
        );
      }
      if (ofType.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
             MATCH (a:Asset {teamId: $teamId, assetId: row.assetId})
             MATCH (t:AssetType {teamId: $teamId, typeKey: row.typeKey})
           CREATE (a)-[:OF_TYPE]->(t)`,
          { teamId, rows: ofType }
        );
      }
      if (rels.length > 0) {
        await tx.run(
          `UNWIND $rows AS row
             MATCH (s:Asset {teamId: $teamId, assetId: row.s})
             MATCH (t:Asset {teamId: $teamId, assetId: row.t})
           CREATE (s)-[:RELATES {relId: row.relId, relKey: row.relKey}]->(t)`,
          {
            teamId,
            rows: rels.map((r) => ({
              s: r.source_asset_id, t: r.target_asset_id, relId: r.id, relKey: r.rel_key,
            })),
          }
        );
      }
    });
  });

  return {
    teamId,
    nodes: types.length + assets.length,
    edges: typeEdges.length + ofType.length + rels.length,
    types: types.length,
    assets: assets.length,
    relations: rels.length,
  };
}

/** 全量重建并回写投影状态（同库事务口径由 exec 决定：API 传租户内执行器，worker 传跨租户执行器）。 */
export async function syncTeamAndRecord(exec: PgExec, teamId: string): Promise<ProjectionResult> {
  const result = await projectTeam(exec, teamId);
  await exec(
    `INSERT INTO graph_sync_state (team_id, marked_at, last_synced_at, node_count, edge_count, last_error)
     VALUES ($1, now(), now(), $2, $3, NULL)
     ON CONFLICT (team_id) DO UPDATE
       SET last_synced_at = now(), node_count = $2, edge_count = $3, last_error = NULL`,
    [teamId, result.nodes, result.edges]
  );
  return result;
}

/** 同步失败留痕（诚实暴露，worker 下轮重试）。 */
export async function recordSyncFailure(exec: PgExec, teamId: string, error: string): Promise<void> {
  await exec(
    `INSERT INTO graph_sync_state (team_id, marked_at, last_error, last_error_at)
     VALUES ($1, now(), $2, now())
     ON CONFLICT (team_id) DO UPDATE SET last_error = $2, last_error_at = now()`,
    [teamId, error.slice(0, 500)]
  );
}

/** 待同步团队：盖过脏标记但尚未成功同步、或上次同步后又有脏标/报错的团队。 */
export async function listDirtyTeams(exec: PgExec): Promise<string[]> {
  const { rows } = await exec(
    `SELECT team_id FROM graph_sync_state
      WHERE last_synced_at IS NULL
         OR marked_at > COALESCE(last_synced_at, to_timestamp(0))
         OR last_error_at > COALESCE(last_synced_at, to_timestamp(0))`
  );
  return rows.map((r) => r.team_id as string);
}

/** 有资产数据的全部团队（worker 启动漂移对账的范围）。 */
export async function listTeamsWithAssets(exec: PgExec): Promise<string[]> {
  const { rows } = await exec(`SELECT DISTINCT team_id FROM assets`);
  return rows.map((r) => r.team_id as string);
}

/** PG 侧源数据计数（漂移对账基准）。subclasses = 带父类的活跃类版本数（SUBCLASS_OF 边期望数）。 */
export async function pgSourceCounts(exec: PgExec, teamId: string): Promise<{ assets: number; types: number; relations: number; subclasses: number }> {
  const [a, t, r, s] = await Promise.all([
    exec(`SELECT count(*)::int AS n FROM assets WHERE team_id = $1`, [teamId]),
    exec(`SELECT count(*)::int AS n FROM asset_type_versions WHERE team_id = $1 AND status = 'active'`, [teamId]),
    exec(`SELECT count(*)::int AS n FROM relation_assertions WHERE team_id = $1 AND status <> 'withdrawn'`, [teamId]),
    exec(`SELECT count(*)::int AS n FROM asset_type_versions WHERE team_id = $1 AND status = 'active' AND parent_type_version_id IS NOT NULL`, [teamId]),
  ]);
  return { assets: a.rows[0].n, types: t.rows[0].n, relations: r.rows[0].n, subclasses: s.rows[0].n };
}
