// /api/v1 — 批量关联下载（M58）：一次 HTTP 请求取走「资产 + confirmed 关系闭包」
// 或「策展集合」，返回自描述 ZIP（manifest.json + manifest-sha256.txt + 制品原文件）。
// 调研吸收：HF snapshot_download（批量=解析后整体取走，自托管下沉到服务端单请求）
// + BagIt（逐文件 sha256 清单）+ Frictionless Data Package（单一自描述描述符）。
import type { FastifyInstance } from "fastify";
import { q, withTeam } from "../db.js";
import type { PoolClient } from "pg";
import { ERR } from "../errors.js";
import { requireAuth } from "../auth.js";
import { blobStoreFromEnv } from "@taw/storage/local-cas";
import {
  traverseClosure,
  buildBundlePlan,
  buildStoreZip,
  sanitizeName,
  type BundleAsset,
  type BundleSourceInfo,
  type ClosureEdge,
  type ClosureVisit,
} from "@taw/domain/bundle";

// 单包体积上限：store-only ZIP 全量驻内存组装，超限引导减小范围分批下载
const BUNDLE_MAX_BYTES = 256 * 1024 * 1024;

interface EdgeRow {
  source_asset_id: string;
  target_asset_id: string;
  predicate: string;
  predicate_title: string;
}

function loadConfirmedEdges(rows: EdgeRow[]): ClosureEdge[] {
  return rows.map((e) => ({ fromAssetId: e.source_asset_id, toAssetId: e.target_asset_id, predicate: e.predicate }));
}

export async function bundleRoutes(app: FastifyInstance): Promise<void> {
  const store = blobStoreFromEnv();

  async function teamRole(userId: string, teamId: string): Promise<void> {
    const { rows } = await q<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    );
    // M57 教训：RLS 只隔离行不校验调用者归属，读侧同样要显式成员校验
    if (!rows[0]) throw ERR.NOT_FOUND();
  }

  /** 在已打开的租户事务内把闭包资产集组装成 ZIP（读制品、计使用度）。 */
  async function assembleBundle(
    client: PoolClient,
    teamId: string,
    actorId: string,
    source: BundleSourceInfo,
    visits: Map<string, ClosureVisit>,
    warnings: string[],
    filenameBase: string
  ): Promise<{ zip: Buffer; filename: string; assetCount: number; fileCount: number }> {
    const ids = [...visits.keys()];
    const { rows: assets } = await client.query<{
      id: string; name: string; lifecycle: string; type_key: string; type_version: string;
      revision_id: string; seq: number; content_digest: string; properties: Record<string, unknown>;
    }>(
      `SELECT a.id, a.name, a.lifecycle, tv.type_key, tv.version AS type_version,
              r.id AS revision_id, r.seq, r.content_digest, r.properties
         FROM assets a
         JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
         JOIN LATERAL (
           SELECT id, seq, content_digest, properties FROM asset_revisions r2
            WHERE r2.team_id = a.team_id AND r2.asset_id = a.id ORDER BY seq DESC LIMIT 1
         ) r ON true
        WHERE a.team_id = $1 AND a.id = ANY($2::uuid[])`,
      [teamId, ids]
    );
    if (assets.length === 0) throw ERR.NOT_FOUND();
    const { rows: arts } = await client.query<{
      revision_id: string; blob_digest: string; artifact_role: string; original_name: string; media_type: string; size: number;
    }>(
      `SELECT revision_id, blob_digest, artifact_role, original_name, media_type, size
         FROM revision_artifacts WHERE team_id = $1 AND revision_id = ANY($2::uuid[])`,
      [teamId, assets.map((a) => a.revision_id)]
    );
    const artsByRev = new Map<string, typeof arts>();
    for (const a of arts) {
      const list = artsByRev.get(a.revision_id) ?? [];
      list.push(a);
      artsByRev.set(a.revision_id, list);
    }
    const { rows: aliasRows } = await client.query<{ asset_id: string; alias: string }>(
      `SELECT asset_id, alias FROM asset_aliases WHERE team_id = $1 AND asset_id = ANY($2::uuid[]) ORDER BY alias`,
      [teamId, ids]
    );
    const { rows: edgeRows } = await client.query<EdgeRow>(
      `SELECT ra.source_asset_id, ra.target_asset_id, rtv.type_key AS predicate, rtv.title AS predicate_title
         FROM relation_assertions ra
         JOIN relation_type_versions rtv ON rtv.team_id = ra.team_id AND rtv.id = ra.relation_type_version_id
        WHERE ra.team_id = $1 AND ra.status = 'confirmed'`,
      [teamId]
    );
    const edges = loadConfirmedEdges(edgeRows);
    const relationNames = new Map(edgeRows.map((e) => [e.predicate, e.predicate_title]));
    const assetNames = new Map(assets.map((a) => [a.id, a.name]));
    const bundleAssets: BundleAsset[] = assets.map((a) => ({
      id: a.id,
      name: a.name,
      typeKey: a.type_key,
      typeVersion: a.type_version,
      lifecycle: a.lifecycle,
      aliases: aliasRows.filter((x) => x.asset_id === a.id).map((x) => x.alias),
      revisionId: a.revision_id,
      revisionSeq: a.seq,
      contentDigest: a.content_digest,
      properties: a.properties,
      artifacts: (artsByRev.get(a.revision_id) ?? []).map((x) => ({
        digest: x.blob_digest,
        role: x.artifact_role,
        originalName: x.original_name,
        mediaType: x.media_type,
        size: x.size,
      })),
      hop: visits.get(a.id)?.hop ?? 0,
      via: visits.get(a.id)?.via ?? null,
    }));
    const plan = buildBundlePlan(source, bundleAssets, edges, relationNames, assetNames, new Date().toISOString(), warnings);
    const totalBytes = plan.files.reduce((s, f) => s + f.size, 0);
    if (totalBytes > BUNDLE_MAX_BYTES) {
      throw ERR.INVALID(
        `打包体积超过 ${Math.floor(BUNDLE_MAX_BYTES / 1024 / 1024)}MB 上限（当前 ${Math.floor(totalBytes / 1024 / 1024)}MB、${plan.files.length} 个文件），请减小深度或范围后分批下载`
      );
    }
    const cache = new Map<string, Uint8Array>();
    const entries: import("@taw/domain/bundle").ZipEntry[] = [
      { path: "manifest.json", data: Buffer.from(JSON.stringify(plan.manifest, null, 2), "utf8") },
      { path: "manifest-sha256.txt", data: Buffer.from(plan.checksumLines, "utf8") },
    ];
    for (const f of plan.files) {
      let buf = cache.get(f.digest);
      if (!buf) {
        buf = await store.get(teamId, f.digest);
        cache.set(f.digest, buf);
      }
      entries.push({ path: f.path, data: buf });
    }
    const zip = buildStoreZip(entries);
    // 使用度（M55 白名单既有 kind）：包内每个资产计一次真实下载
    await client.query(
      `INSERT INTO usage_events (team_id, asset_id, kind, actor_id)
       SELECT $1, x, 'download', $3 FROM unnest($2::uuid[]) AS x`,
      [teamId, ids, actorId]
    );
    const stamp = new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    return { zip, filename: `${filenameBase}-${stamp}.zip`, assetCount: bundleAssets.length, fileCount: plan.files.length };
  }

  function sendZip(reply: import("fastify").FastifyReply, result: { zip: Buffer; filename: string }): void {
    reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`)
      .send(result.zip);
  }

  // 资产 + 关系闭包打包（?depth=1..3 默认 1；?direction=out|in|both 默认 both）
  app.get("/assets/:assetId/bundle", async (req, reply) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const query = (req.query ?? {}) as { teamId?: string; depth?: string; direction?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const depth = Math.min(Math.max(Math.trunc(Number(query.depth ?? 1)) || 1, 1), 3);
    const directionRaw = String(query.direction ?? "both");
    const direction = directionRaw === "out" || directionRaw === "in" ? directionRaw : "both";
    const result = await withTeam(teamId, async (client) => {
      const { rows: seed } = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM assets WHERE team_id = $1 AND id = $2`,
        [teamId, assetId]
      );
      if (!seed[0]) throw ERR.NOT_FOUND();
      const { rows: edgeRows } = await client.query<EdgeRow>(
        `SELECT ra.source_asset_id, ra.target_asset_id, rtv.type_key AS predicate, rtv.title AS predicate_title
           FROM relation_assertions ra
           JOIN relation_type_versions rtv ON rtv.team_id = ra.team_id AND rtv.id = ra.relation_type_version_id
          WHERE ra.team_id = $1 AND ra.status = 'confirmed'`,
        [teamId]
      );
      const { visits, warnings } = traverseClosure([assetId], loadConfirmedEdges(edgeRows), { depth, direction });
      return assembleBundle(
        client,
        teamId,
        auth.userId,
        { kind: "asset", id: assetId, name: seed[0].name, depth, direction },
        visits,
        warnings,
        `bundle-${sanitizeName(seed[0].name, 60)}`
      );
    });
    sendZip(reply, result);
  });

  // 策展集合打包（M56 集合即批量范围：flat 不扩散闭包——策展就是范围）
  app.get("/collections/:collectionId/bundle", async (req, reply) => {
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const result = await withTeam(teamId, async (client) => {
      const { rows: coll } = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM asset_collections WHERE team_id = $1 AND id = $2`,
        [teamId, collectionId]
      );
      if (!coll[0]) throw ERR.NOT_FOUND();
      const { rows: items } = await client.query<{ asset_id: string }>(
        `SELECT asset_id FROM asset_collection_items WHERE team_id = $1 AND collection_id = $2`,
        [teamId, collectionId]
      );
      if (!items[0]) throw ERR.INVALID("集合为空，没有可打包的资产");
      const visits = new Map<string, ClosureVisit>();
      for (const it of items) visits.set(it.asset_id, { hop: 0, via: null });
      return assembleBundle(
        client,
        teamId,
        auth.userId,
        { kind: "collection", id: collectionId, name: coll[0].name },
        visits,
        [],
        `collection-${sanitizeName(coll[0].name, 60)}`
      );
    });
    sendZip(reply, result);
  });
}
