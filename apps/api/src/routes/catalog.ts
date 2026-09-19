// /api/v1/types + assets + relations — 资产目录与本体（设计 7/8/9 章）。
// 资产创建即产生首个不可变修订；属性经类型 JSON Schema + 单位词表校验（A03）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { blobStoreFromEnv } from "@taw/storage/local-cas";
import { compileTypeSchema, validateProperties } from "@taw/domain/validate";
import {
  DEFAULT_RELATION_TYPES,
  DEFAULT_TYPE_DEFINITIONS,
} from "@taw/domain/defaults";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

/** 递归键排序的稳定 JSON 序列化（摘要规范化用）。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function catalogRoutes(app: FastifyInstance): Promise<void> {
  const store = blobStoreFromEnv();

  // ---------- 类型定义 ----------
  // 新团队首次访问时播种默认类型（幂等）；管理员可注册新类型版本（A02）。
  async function seedDefaultTypes(teamId: string, userId: string): Promise<void> {
    await withTeam(teamId, async (client) => {
      for (const def of DEFAULT_TYPE_DEFINITIONS) {
        await client.query(
          `INSERT INTO asset_type_versions (team_id, id, type_key, version, title, json_schema, unit_vocabularies, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (team_id, type_key, version) DO NOTHING`,
          [teamId, newId(), def.typeKey, def.version, def.title, JSON.stringify(def.jsonSchema), JSON.stringify(def.unitVocabularies), userId]
        );
      }
      for (const rel of DEFAULT_RELATION_TYPES) {
        await client.query(
          `INSERT INTO relation_type_versions (team_id, id, type_key, version, title, source_kinds, target_kinds, cyclic, is_symmetric, requires_revision, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (team_id, type_key, version) DO NOTHING`,
          [teamId, newId(), rel.typeKey, rel.version, rel.title, rel.sourceKinds, rel.targetKinds, rel.cyclic, rel.isSymmetric, rel.requiresRevision, userId]
        );
      }
    });
  }

  app.post("/types", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeKey: z.string().regex(/^[a-z][a-z0-9.\-]{1,63}$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        title: z.string().min(1).max(64),
        jsonSchema: z.object({}).passthrough(),
        unitVocabularies: z.record(z.string(), z.array(z.string())).default({}),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    if (!compileTypeSchema(body.jsonSchema)) throw ERR.INVALID("jsonSchema 不是可编译的 JSON Schema");
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const dup = await client.query(`SELECT 1 FROM asset_type_versions WHERE team_id = $1 AND type_key = $2 AND version = $3`, [body.teamId, body.typeKey, body.version]);
      if (dup.rowCount) throw ERR.CONFLICT("TYPE_VERSION_EXISTS", "该类型版本已存在");
      await client.query(
        `INSERT INTO asset_type_versions (team_id, id, type_key, version, title, json_schema, unit_vocabularies, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [body.teamId, id, body.typeKey, body.version, body.title, JSON.stringify(body.jsonSchema), JSON.stringify(body.unitVocabularies), auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, typeVersionId: id, typeKey: body.typeKey, version: body.version });
  });

  app.post("/relation-types", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        title: z.string().min(1).max(64),
        cyclic: z.boolean().default(true),
        isSymmetric: z.boolean().default(false),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(
        `INSERT INTO relation_type_versions (team_id, id, type_key, version, title, source_kinds, target_kinds, cyclic, is_symmetric, requires_revision, created_by)
         VALUES ($1, $2, $3, $4, $5, '{asset}', '{asset}', $6, $7, true, $8)`,
        [body.teamId, id, body.typeKey, body.version, body.title, body.cyclic, body.isSymmetric, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, relationTypeVersionId: id });
  });

  app.get("/types", async (req) => {
    const auth = requireAuth(req);
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    await seedDefaultTypes(teamId, auth.userId);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query(
        `SELECT id, type_key, version, title, status, json_schema, unit_vocabularies, created_at
           FROM asset_type_versions WHERE team_id = $1 ORDER BY type_key, version`,
        [teamId]
      )
    );
    return rows;
  });

  // ---------- 资产登记（创建身份 + 首个不可变修订） ----------
  app.post("/assets", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().min(1).max(256),
        typeVersionId: z.string().uuid(),
        properties: z.object({}).passthrough().default({}),
        categoryPath: z.string().regex(/^[a-z0-9/\-]{1,128}$/).optional(),
        labels: z.array(z.string().min(1).max(32)).max(16).default([]),
        // 首修订可携带制品（已上传 blob）
        artifacts: z
          .array(
            z.object({
              digest: z.string().length(64),
              role: z.string().min(1).max(32).default("implementation"),
              originalName: z.string().min(1).max(255),
              mediaType: z.string().min(1).max(128),
              size: z.number().int().nonnegative(),
            })
          )
          .max(20)
          .default([]),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);

    const assetId = newId();
    const revisionId = newId();

    await withTeam(body.teamId, async (client) => {
      // 锁定类型定义并校验属性（A03）
      const { rows: typeRows } = await client.query<{ json_schema: object; unit_vocabularies: Record<string, string[]> }>(
        `SELECT json_schema, unit_vocabularies FROM asset_type_versions WHERE team_id = $1 AND id = $2 AND status = 'active'`,
        [body.teamId, body.typeVersionId]
      );
      const typeDef = typeRows[0];
      if (!typeDef) throw ERR.INVALID("typeVersionId 不存在或已停用");
      const check = validateProperties(
        { jsonSchema: typeDef.json_schema, unitVocabularies: typeDef.unit_vocabularies },
        body.properties
      );
      if (!check.valid) throw ERR.INVALID("属性不满足类型约束", check.errors);

      // 制品 blob 必须已在本团队内容库（防止引用他团队摘要）
      for (const art of body.artifacts) {
        const { rows: blob } = await client.query(`SELECT 1 FROM blobs WHERE team_id = $1 AND digest = $2`, [
          body.teamId,
          art.digest,
        ]);
        if (!blob[0]) throw ERR.INVALID(`制品摘要 ${art.digest.slice(0, 8)}… 未在本团队上传`);
      }

      // 内容摘要：对属性规范化序列 + 全部制品摘要的哈希（修订指纹）。
      // 规范化规则固定：键递归排序，避免字段顺序不稳定（设计 13 章）。
      const canonical = stableStringify({
        p: body.properties,
        arts: body.artifacts.map((a) => a.digest).sort(),
        type: body.typeVersionId,
      });
      const contentDigest = createHash("sha256").update(canonical).digest("hex");

      await client.query(`INSERT INTO entities (team_id, id, kind) VALUES ($1, $2, 'asset')`, [
        body.teamId,
        assetId,
      ]);
      await client.query(
        `INSERT INTO assets (team_id, id, name, current_type_version_id, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [body.teamId, assetId, body.name, body.typeVersionId, auth.userId]
      );
      const { rows: seqRows } = await client.query<{ n: number }>(
        `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM asset_revisions WHERE team_id = $1 AND asset_id = $2`,
        [body.teamId, assetId]
      );
      await client.query(
        `INSERT INTO asset_revisions (team_id, id, asset_id, type_version_id, properties, content_digest, seq, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [body.teamId, revisionId, assetId, body.typeVersionId, JSON.stringify(body.properties), contentDigest, seqRows[0].n, auth.userId]
      );
      for (const art of body.artifacts) {
        await client.query(
          `INSERT INTO revision_artifacts (team_id, revision_id, blob_digest, artifact_role, original_name, media_type, size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [body.teamId, revisionId, art.digest, art.role, art.originalName, art.mediaType, art.size]
        );
      }
      if (body.categoryPath) {
        await client.query(
          `INSERT INTO asset_categories (team_id, asset_id, category_path, is_primary) VALUES ($1, $2, $3, true)`,
          [body.teamId, assetId, body.categoryPath]
        );
      }
      for (const label of body.labels) {
        await client.query(
          `INSERT INTO asset_labels (team_id, asset_id, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [body.teamId, assetId, label]
        );
      }
    });
    return reply.code(201).send({ teamId: body.teamId, assetId, revisionId });
  });

  // ---------- 查询 ----------
  app.get("/assets/search", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; q?: string; type?: string; label?: string; limit?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query(
        `SELECT a.id, a.name, a.lifecycle, tv.type_key, tv.version AS type_version,
                r.id AS head_revision_id, r.content_digest, r.created_at
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN LATERAL (
             SELECT id, content_digest, created_at FROM asset_revisions
              WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1
           ) r ON true
          WHERE a.team_id = $1
            AND ($2 = '' OR a.name ILIKE '%' || $2 || '%')
            AND ($3 = '' OR tv.type_key = $3)
            AND a.lifecycle <> 'archived'
          ORDER BY a.created_at DESC LIMIT $4`,
        [teamId, query.q ?? "", query.type ?? "", limit]
      )
    );
    return rows;
  });

  app.get("/assets/:assetId", async (req) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.name, a.lifecycle, a.created_at, tv.type_key, tv.version AS type_version, tv.id AS type_version_id
           FROM assets a JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, assetId]
      );
      const asset = rows[0];
      if (!asset) throw ERR.NOT_FOUND();
      const { rows: revisions } = await client.query(
        `SELECT id, seq, content_digest, properties, created_at, created_by FROM asset_revisions
          WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC`,
        [teamId, assetId]
      );
      const { rows: labels } = await client.query<{ label: string }>(
        `SELECT label FROM asset_labels WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      const { rows: categories } = await client.query<{ category_path: string; is_primary: boolean }>(
        `SELECT category_path, is_primary FROM asset_categories WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      return { ...asset, revisions, labels: labels.map((l) => l.label), categories };
    });
  });

  app.get("/assets/:assetId/revisions/:revisionId", async (req) => {
    const auth = requireAuth(req);
    const { assetId, revisionId } = req.params as { assetId: string; revisionId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT r.id, r.asset_id, r.seq, r.properties, r.content_digest, r.created_at, r.created_by,
                tv.type_key, tv.version AS type_version
           FROM asset_revisions r JOIN asset_type_versions tv ON tv.team_id = r.team_id AND tv.id = r.type_version_id
          WHERE r.team_id = $1 AND r.asset_id = $2 AND r.id = $3`,
        [teamId, assetId, revisionId]
      );
      const rev = rows[0];
      if (!rev) throw ERR.NOT_FOUND();
      const { rows: arts } = await client.query(
        `SELECT blob_digest, artifact_role, original_name, media_type, size FROM revision_artifacts
          WHERE team_id = $1 AND revision_id = $2`,
        [teamId, revisionId]
      );
      return { ...rev, artifacts: arts };
    });
  });

  // ---------- 关系 ----------
  app.post("/relations", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        relationTypeVersionId: z.string().uuid(),
        sourceAssetId: z.string().uuid(),
        sourceRevisionId: z.string().uuid().optional(),
        targetAssetId: z.string().uuid(),
        targetRevisionId: z.string().uuid().optional(),
        conditions: z.object({}).passthrough().default({}),
        evidenceNote: z.string().max(2000).optional(),
        confirm: z.boolean().default(true),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    const status = body.confirm ? "confirmed" : "proposed";
    await withTeam(body.teamId, async (client) => {
      // 目标必须在同一团队（复合外键语义 + A08 负例的服务端层）
      const { rows: src } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        body.sourceAssetId,
      ]);
      const { rows: tgt } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        body.targetAssetId,
      ]);
      if (!src[0] || !tgt[0]) throw ERR.INVALID("源或目标资产不存在于本团队");
      if (body.sourceRevisionId) {
        const { rows: sr } = await client.query(
          `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND id = $2 AND asset_id = $3`,
          [body.teamId, body.sourceRevisionId, body.sourceAssetId]
        );
        if (!sr[0]) throw ERR.INVALID("源修订与资产不匹配");
      }
      if (body.targetRevisionId) {
        const { rows: tr } = await client.query(
          `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND id = $2 AND asset_id = $3`,
          [body.teamId, body.targetRevisionId, body.targetAssetId]
        );
        if (!tr[0]) throw ERR.INVALID("目标修订与资产不匹配");
      }
      await client.query(
        `INSERT INTO relation_assertions (team_id, id, relation_type_version_id, source_asset_id, source_revision_id,
          target_asset_id, target_revision_id, conditions, evidence_note, status, proposed_by, confirmed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          body.teamId, id, body.relationTypeVersionId,
          body.sourceAssetId, body.sourceRevisionId ?? null,
          body.targetAssetId, body.targetRevisionId ?? null,
          JSON.stringify(body.conditions), body.evidenceNote ?? null,
          status, auth.userId, body.confirm ? auth.userId : null,
        ]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, relationId: id, status });
  });

  app.get("/relations", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; assetId?: string; direction?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const assetId = String(query.assetId ?? "");
    const filterByAsset = /^[0-9a-f-]{36}$/.test(assetId);
    return withTeam(teamId, async (client) => {
      const outgoing = await client.query(
        `SELECT ra.id, rt.type_key, ra.status, ra.source_asset_id, ra.source_revision_id,
                ra.target_asset_id, ra.target_revision_id, ra.conditions, ra.evidence_note,
                sa.name AS source_name, ta.name AS target_name
           FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
          WHERE ra.team_id = $1 AND ra.status <> 'withdrawn'
            AND ($2::uuid IS NULL OR ra.source_asset_id = $2::uuid)`,
        [teamId, filterByAsset ? assetId : null]
      );
      const incoming = await client.query(
        `SELECT ra.id, rt.type_key, ra.status, sa.name AS source_name, ta.name AS target_name,
                ra.source_asset_id, ra.target_asset_id
           FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
          WHERE ra.team_id = $1 AND ra.status <> 'withdrawn'
            AND ($2::uuid IS NULL OR ra.target_asset_id = $2::uuid)`,
        [teamId, filterByAsset ? assetId : null]
      );
      return { outgoing: outgoing.rows, incoming: incoming.rows };
    });
  });
}
