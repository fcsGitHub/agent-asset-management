// /api/v1 图数据库本体检索（M49）。
// 图库（Memgraph）是 PostgreSQL 的可再生投影：类型层次 SUBCLASS_OF、资产 OF_TYPE、
// 存活关系断言 RELATES。检索端点优先走图库；图库不可用时诚实降级——
// 闭包/按类检索回落 SQL（响应带 engine 标注），邻域/路径返回 503 DEPENDENCY_UNAVAILABLE。
// 同步：API 写路径在业务事务内盖脏标记（graph_sync_state），worker 周期重建；
// 管理员可 POST /graph/sync 立即同步；status 端点如实暴露滞后与漂移。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import {
  GraphUnavailableError,
  findShortestPath,
  graphCounts,
  graphPing,
  neighborhood,
  recordSyncFailure,
  resolveTypeClosure,
  syncTeamAndRecord,
} from "@taw/graph";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

function isUuid(s: string): boolean {
  return /^[0-9a-f-]{36}$/.test(s);
}

export async function graphRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 投影状态（诚实可观测） ----------
  app.get("/graph/status", async (req) => {
    const auth = requireAuth(req);
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!isUuid(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const reachable = await graphPing();
    const stateRows = await withTeam(teamId, async (client) =>
      client.query<{ marked_at: string; last_synced_at: string | null; node_count: number | null; edge_count: number | null; last_error: string | null; last_error_at: string | null }>(
        `SELECT marked_at, last_synced_at, node_count, edge_count, last_error, last_error_at
           FROM graph_sync_state WHERE team_id = $1`,
        [teamId]
      )
    );
    const state = stateRows.rows[0] ?? null;
    const pg = await withTeam(teamId, async (client) => {
      const [a, t, r, s] = await Promise.all([
        client.query(`SELECT count(*)::int AS n FROM assets WHERE team_id = $1`, [teamId]),
        client.query(`SELECT count(*)::int AS n FROM asset_type_versions WHERE team_id = $1 AND status = 'active'`, [teamId]),
        client.query(`SELECT count(*)::int AS n FROM relation_assertions WHERE team_id = $1 AND status <> 'withdrawn'`, [teamId]),
        client.query(`SELECT count(*)::int AS n FROM asset_type_versions WHERE team_id = $1 AND status = 'active' AND parent_type_version_id IS NOT NULL`, [teamId]),
      ]);
      return { assets: a.rows[0].n, types: t.rows[0].n, relations: r.rows[0].n, subclasses: s.rows[0].n };
    });
    let graph: { nodes: number; edges: number } | null = null;
    if (reachable) {
      try {
        graph = await graphCounts(teamId);
      } catch {
        graph = null; // 刚掉线：如实按不可达以下口径处理
      }
    }
    const expectedNodes = pg.assets + pg.types;
    const expectedEdges = pg.assets + pg.relations + pg.subclasses; // OF_TYPE + RELATES + SUBCLASS_OF
    const pendingMark = state ? new Date(state.marked_at) > new Date(state.last_synced_at ?? 0) : false;
    return {
      graphDb: { reachable },
      projection: state
        ? {
            markedAt: state.marked_at,
            lastSyncedAt: state.last_synced_at,
            nodeCount: state.node_count,
            edgeCount: state.edge_count,
            lastError: state.last_error,
            lastErrorAt: state.last_error_at,
            pendingSync: pendingMark,
          }
        : null,
      drift: {
        pg,
        graph,
        inSync: graph !== null && graph.nodes === expectedNodes && graph.edges === expectedEdges,
      },
    };
  });

  // ---------- 手动同步（管理员） ----------
  app.post("/graph/sync", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    const started = Date.now();
    try {
      const result = await withTeam(body.teamId, async (client) => {
        const exec = (sql: string, params?: unknown[]) => client.query(sql, params as never[]);
        return syncTeamAndRecord(exec, body.teamId);
      });
      return { durationMs: Date.now() - started, ...result };
    } catch (err) {
      if (err instanceof GraphUnavailableError) {
        // 失败留痕，状态端点如实可见；投影数据不变
        await withTeam(body.teamId, async (client) => recordSyncFailure(
          (sql, params) => client.query(sql, params as never[]), body.teamId, err.message
        )).catch(() => undefined);
        throw ERR.DEPENDENCY(`图数据库不可用，同步未执行：${err.message}`);
      }
      throw err;
    }
  });

  // ---------- 类闭包（本体检索） ----------
  app.get("/ontology/type-closure", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; typeKey?: string };
    const teamId = String(query.teamId ?? "");
    const typeKey = String(query.typeKey ?? "");
    if (!isUuid(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    if (!/^[a-zA-Z][a-zA-Z0-9.\-]{0,63}$/.test(typeKey)) throw ERR.INVALID("typeKey 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const { engine, keys } = await withTeam(teamId, (client) =>
      resolveTypeClosure((sql, params) => client.query(sql, params as never[]), teamId, typeKey)
    );
    return { teamId, typeKey, engine, keys };
  });

  // ---------- 按类检索资产（含闭包） ----------
  app.get("/ontology/assets-by-type", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; typeKey?: string; q?: string; limit?: string; lifecycle?: string };
    const teamId = String(query.teamId ?? "");
    const typeKey = String(query.typeKey ?? "");
    if (!isUuid(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    if (!/^[a-zA-Z][a-zA-Z0-9.\-]{0,63}$/.test(typeKey)) throw ERR.INVALID("typeKey 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
    const lifecycle = query.lifecycle === "archived" || query.lifecycle === "all" ? query.lifecycle : "active";

    const closure = await withTeam(teamId, (client) =>
      resolveTypeClosure((sql, params) => client.query(sql, params as never[]), teamId, typeKey)
    );
    const { engine, keys } = closure;

    const rows = await withTeam(teamId, async (client) =>
      client.query(
        `SELECT a.id, a.name, a.lifecycle, tv.type_key, tv.title AS type_title,
                r.id AS head_revision_id, r.created_at
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN LATERAL (
             SELECT id, created_at FROM asset_revisions
              WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1
           ) r ON true
          WHERE a.team_id = $1
            AND tv.type_key = ANY($2::text[])
            AND ($3 = '' OR a.name ILIKE '%' || $3 || '%')
            AND ($4 = 'all' OR ($4 = 'active' AND a.lifecycle IN ('active', 'deprecated')) OR a.lifecycle = $4)
          ORDER BY (a.lifecycle = 'deprecated'), a.name LIMIT $5`,
        [teamId, keys, String(query.q ?? ""), lifecycle, limit]
      )
    );
    return { teamId, typeKey, engine, keys, assets: rows.rows };
  });

  // ---------- 多跳邻域（图库原生，无 SQL 兜底——图库离线时 503 诚实降级） ----------
  app.get("/graph/neighborhood", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; assetId?: string; depth?: string };
    const teamId = String(query.teamId ?? "");
    const assetId = String(query.assetId ?? "");
    if (!isUuid(teamId) || !isUuid(assetId)) throw ERR.INVALID("teamId/assetId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const depth = Math.min(Math.max(Number(query.depth ?? 2), 1), 3);
    let sub;
    try {
      sub = await neighborhood(teamId, assetId, depth);
    } catch (err) {
      if (err instanceof GraphUnavailableError) {
        throw ERR.DEPENDENCY(`图数据库不可用，多跳邻域暂不可用：${err.message}`);
      }
      throw err;
    }
    if (!sub.seed) {
      // 资产存在但不在投影中 = 投影滞后（诚实提示）；PG 里也无 = 404
      const exists = await withTeam(teamId, async (client) =>
        client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [teamId, assetId])
      );
      if (!exists.rows[0]) throw ERR.NOT_FOUND();
      return { teamId, assetId, depth, found: false, reason: "projection-stale", hint: "该资产尚未同步进图库投影，请稍候或让管理员执行同步", ...sub };
    }
    return { teamId, assetId, depth, found: true, ...sub };
  });

  // ---------- 两资产关联路径（图库边集 + 应用层 BFS） ----------
  app.get("/graph/path", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; from?: string; to?: string };
    const teamId = String(query.teamId ?? "");
    const from = String(query.from ?? "");
    const to = String(query.to ?? "");
    if (!isUuid(teamId) || !isUuid(from) || !isUuid(to)) throw ERR.INVALID("teamId/from/to 查询参数缺失");
    await teamRole(auth.userId, teamId);
    if (from === to) throw ERR.INVALID("from 与 to 不得相同");
    let path;
    try {
      path = await findShortestPath(teamId, from, to);
    } catch (err) {
      if (err instanceof GraphUnavailableError) {
        throw ERR.DEPENDENCY(`图数据库不可用，路径检索暂不可用：${err.message}`);
      }
      throw err;
    }
    return { teamId, from, to, found: path !== null, ...(path ?? {}) };
  });
}
