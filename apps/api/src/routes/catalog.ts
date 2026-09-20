// /api/v1/types + assets + relations — 资产目录与本体（设计 7/8/9 章）。
// 资产创建即产生首个不可变修订；属性经类型 JSON Schema + 单位词表校验（A03）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import type { PoolClient } from "pg";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { blobStoreFromEnv } from "@taw/storage/local-cas";
import {
  compileTypeSchema,
  validateProperties,
  diffJsonSchemas,
  countPropertyUsage,
  danglingVocabularies,
  inheritanceViolations,
} from "@taw/domain/validate";
import { stableStringify } from "@taw/domain/digest";
import {
  DEFAULT_RELATION_TYPES,
  DEFAULT_TYPE_DEFINITIONS,
  ENTITY_KINDS,
} from "@taw/domain/defaults";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

/** 递归键排序的稳定 JSON 序列化见 @taw/domain/digest（与发布摘要共用同一实现）。 */
export { stableStringify };

const TYPE_CHAIN_MAX_DEPTH = 16;

type TypeDefRow = {
  id: string;
  type_key: string;
  version: string;
  title: string;
  json_schema: object;
  unit_vocabularies: Record<string, string[]>;
  parent_type_version_id: string | null;
  status?: string;
};

/**
 * 载入类型定义链（子 → 父 → … → 根）。注册时父引用必须已存在且边指向已有定义，
 * 因此链不可能成环；深度上限是防御性兜底（M8 本体层次）。
 */
async function loadTypeChain(client: PoolClient, teamId: string, typeVersionId: string): Promise<TypeDefRow[]> {
  const chain: TypeDefRow[] = [];
  let cursor: string | null = typeVersionId;
  const seen = new Set<string>();
  while (cursor) {
    if (chain.length > TYPE_CHAIN_MAX_DEPTH || seen.has(cursor)) {
      throw ERR.CONFLICT("TYPE_HIERARCHY_CORRUPT", "类型层次异常：链过深或成环，联系管理员检查数据");
    }
    seen.add(cursor);
    const result: { rows: TypeDefRow[] } = await client.query<TypeDefRow>(
      `SELECT id, type_key, version, title, json_schema, unit_vocabularies, parent_type_version_id
         FROM asset_type_versions WHERE team_id = $1 AND id = $2`,
      [teamId, cursor]
    );
    const row: TypeDefRow | undefined = result.rows[0];
    if (!row) throw ERR.INVALID("类型定义不存在（层次链断裂）");
    chain.push(row);
    const next: string | null = row.parent_type_version_id;
    cursor = next;
  }
  return chain;
}

/** 子定义必须收窄链上每个祖先定义；返回首个违规描述（无违规返回 null）。 */
function firstInheritanceViolation(chain: TypeDefRow[]): string | null {
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i]!;
    const parent = chain[i + 1]!;
    for (const v of inheritanceViolations(parent.json_schema, child.json_schema)) {
      return `${child.type_key} v${child.version} 相对父 ${parent.type_key} v${parent.version}：${v}`;
    }
  }
  return null;
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
        parentTypeVersionId: z.string().uuid().optional(),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    if (!compileTypeSchema(body.jsonSchema)) throw ERR.INVALID("jsonSchema 不是可编译的 JSON Schema");
    // 本体质量门：词表悬挂引用（<name> 与 <name>Unit 属性均不存在 → 词表静默失效）
    const dangling = danglingVocabularies(body.jsonSchema, body.unitVocabularies);
    if (dangling.length > 0) {
      throw ERR.INVALID(`单位词表悬挂引用：词表 ${dangling.join("、")} 对应的属性（<name> 或 <name>Unit）均不在 jsonSchema.properties 中`);
    }
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const dup = await client.query(`SELECT 1 FROM asset_type_versions WHERE team_id = $1 AND type_key = $2 AND version = $3`, [body.teamId, body.typeKey, body.version]);
      if (dup.rowCount) throw ERR.CONFLICT("TYPE_VERSION_EXISTS", "该类型版本已存在");
      // 类型层次（subClassOf）：父版本必须存在；子定义必须是父定义的收窄。
      let chain: TypeDefRow[] = [
        {
          id,
          type_key: body.typeKey,
          version: body.version,
          title: body.title,
          json_schema: body.jsonSchema,
          unit_vocabularies: body.unitVocabularies,
          parent_type_version_id: body.parentTypeVersionId ?? null,
        },
      ];
      if (body.parentTypeVersionId) {
        const ancestors = await loadTypeChain(client, body.teamId, body.parentTypeVersionId);
        chain = [chain[0]!, ...ancestors];
        const violation = firstInheritanceViolation(chain);
        if (violation) throw ERR.INVALID(`子类型定义不是父类型的收窄：${violation}`);
      }
      await client.query(
        `INSERT INTO asset_type_versions (team_id, id, type_key, version, title, json_schema, unit_vocabularies, parent_type_version_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [body.teamId, id, body.typeKey, body.version, body.title, JSON.stringify(body.jsonSchema), JSON.stringify(body.unitVocabularies), body.parentTypeVersionId ?? null, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, typeVersionId: id, typeKey: body.typeKey, version: body.version });
  });

  // ---------- 本体迁移影响预览（管理员） ----------
  // 注册新类型版本前，先看：多少资产受影响、哪些头修订会在新定义下失败、结构上动了什么。
  // 纯只读计算，不做任何写入。
  app.post("/types/migration-preview", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeKey: z.string().regex(/^[a-z][a-z0-9.\-]{1,63}$/),
        jsonSchema: z.object({}).passthrough(),
        unitVocabularies: z.record(z.string(), z.array(z.string())).default({}),
        parentTypeVersionId: z.string().uuid().optional(),
        sampleLimit: z.number().int().min(1).max(50).default(10),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    if (!compileTypeSchema(body.jsonSchema)) throw ERR.INVALID("jsonSchema 不是可编译的 JSON Schema");
    const dangling = danglingVocabularies(body.jsonSchema, body.unitVocabularies);
    if (dangling.length > 0) {
      throw ERR.INVALID(`单位词表悬挂引用：词表 ${dangling.join("、")} 对应的属性（<name> 或 <name>Unit）均不在 jsonSchema.properties 中`);
    }

    return withTeam(body.teamId, async (client) => {
      const { rows: cur } = await client.query<{
        id: string;
        version: string;
        json_schema: object;
        unit_vocabularies: Record<string, string[]>;
        parent_type_version_id: string | null;
      }>(
        `SELECT id, version, json_schema, unit_vocabularies, parent_type_version_id FROM asset_type_versions
          WHERE team_id = $1 AND type_key = $2 AND status = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        [body.teamId, body.typeKey]
      );
      if (!cur[0]) {
        throw ERR.NOT_FOUND();
      }
      const current = cur[0];

      // 层次影响：旧版本的后代类型（直接或间接以该版本为父）也随迁移受影响
      const { rows: descendants } = await client.query<{ id: string; type_key: string; version: string }>(
        `WITH RECURSIVE desc_types AS (
           SELECT team_id, id, type_key, version FROM asset_type_versions WHERE team_id = $1 AND parent_type_version_id = $2
           UNION
           SELECT t.team_id, t.id, t.type_key, t.version
             FROM asset_type_versions t JOIN desc_types d ON t.team_id = d.team_id AND t.parent_type_version_id = d.id
         ) SELECT id, type_key, version FROM desc_types`,
        [body.teamId, current.id]
      );
      const descendantIds = descendants.map((d) => d.id);

      // 新定义必须仍是父定义的收窄（父换不掉属性类型）
      let inheritanceIssue: string | null = null;
      if (current.parent_type_version_id) {
        const ancestors = await loadTypeChain(client, body.teamId, current.parent_type_version_id);
        const violation = inheritanceViolations(ancestors[0]!.json_schema, body.jsonSchema);
        if (violation.length > 0) inheritanceIssue = violation.join("；");
      }

      // 受影响资产 = 当前版本 + 全部后代版本下的资产；取各自头修订做真实校验
      const { rows: heads } = await client.query<{
        asset_id: string;
        asset_name: string;
        revision_id: string;
        properties: Record<string, unknown>;
        current_type_key: string;
      }>(
        `SELECT a.id AS asset_id, a.name AS asset_name, r.id AS revision_id, r.properties,
                ctv.type_key AS current_type_key
           FROM assets a
           JOIN asset_type_versions ctv ON ctv.team_id = a.team_id AND ctv.id = a.current_type_version_id
           JOIN LATERAL (
             SELECT id, properties FROM asset_revisions
              WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1
           ) r ON true
          WHERE a.team_id = $1
            AND (a.current_type_version_id = $2
                 OR a.current_type_version_id = ANY($3::uuid[]))`,
        [body.teamId, current.id, descendantIds]
      );

      const newDef = { jsonSchema: body.jsonSchema, unitVocabularies: body.unitVocabularies };
      const sampleFailures: { assetId: string; assetName: string; revisionId: string; errors: string[] }[] = [];
      let failingCount = 0;
      for (const head of heads) {
        const check = validateProperties(newDef, head.properties);
        if (!check.valid) {
          failingCount += 1;
          if (sampleFailures.length < body.sampleLimit) {
            sampleFailures.push({
              assetId: head.asset_id,
              assetName: head.asset_name,
              revisionId: head.revision_id,
              errors: check.errors,
            });
          }
        }
      }

      const structuralChanges = diffJsonSchemas(current.json_schema, body.jsonSchema);
      // 被移除属性的存量使用面
      const removedPaths = new Set(
        structuralChanges.filter((c) => c.kind === "property-removed").map((c) => c.path.slice(1))
      );
      const usage = countPropertyUsage(heads);
      const removedUsage = Object.fromEntries(
        Object.entries(usage).filter(([k]) => removedPaths.has(k))
      );

      return {
        typeKey: body.typeKey,
        currentVersionId: current.id,
        currentVersion: current.version,
        affectedAssets: heads.length,
        failingAssets: failingCount,
        safe: failingCount === 0 && inheritanceIssue === null,
        inheritanceIssue,
        descendantTypes: descendants,
        sampleFailures,
        structuralChanges,
        removedPropertyUsage: removedUsage,
      };
    });
  });

  const entityKindSchema = z.enum(ENTITY_KINDS);
  const typeKeyListSchema = z.array(z.string().regex(/^[a-z][a-z0-9.\-]{1,63}$/)).max(32);

  app.post("/relation-types", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/),
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        title: z.string().min(1).max(64),
        sourceKinds: z.array(entityKindSchema).min(1).default(["asset"]),
        targetKinds: z.array(entityKindSchema).min(1).default(["asset"]),
        // 类级 domain/range（semantica ObjectProperty 的 domain/range 语义）：
        // 引用资产类型 type_key；空数组 = 不限。悬挂键在质量门被拒绝。
        sourceTypeKeys: typeKeyListSchema.default([]),
        targetTypeKeys: typeKeyListSchema.default([]),
        cyclic: z.boolean().default(true),
        isSymmetric: z.boolean().default(false),
        requiresRevision: z.boolean().default(true),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const dup = await client.query(
        `SELECT 1 FROM relation_type_versions WHERE team_id = $1 AND type_key = $2 AND version = $3`,
        [body.teamId, body.typeKey, body.version]
      );
      if (dup.rowCount) throw ERR.CONFLICT("RELATION_TYPE_VERSION_EXISTS", "该关系类型版本已存在");
      // 质量门：类级 domain/range 引用的 type_key 必须已在本团队注册
      const claimed = [...new Set([...body.sourceTypeKeys, ...body.targetTypeKeys])];
      if (claimed.length > 0) {
        const { rows: known } = await client.query<{ type_key: string }>(
          `SELECT DISTINCT type_key FROM asset_type_versions WHERE team_id = $1 AND type_key = ANY($2::text[])`,
          [body.teamId, claimed]
        );
        const knownSet = new Set(known.map((k) => k.type_key));
        const missing = claimed.filter((k) => !knownSet.has(k));
        if (missing.length > 0) {
          throw ERR.INVALID(`类级 domain/range 悬挂引用：类型 ${missing.join("、")} 尚未注册`);
        }
      }
      await client.query(
        `INSERT INTO relation_type_versions (team_id, id, type_key, version, title, source_kinds, target_kinds,
            source_type_keys, target_type_keys, cyclic, is_symmetric, requires_revision, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [body.teamId, id, body.typeKey, body.version, body.title, body.sourceKinds, body.targetKinds,
         body.sourceTypeKeys, body.targetTypeKeys, body.cyclic, body.isSymmetric, body.requiresRevision, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, relationTypeVersionId: id });
  });

  app.get("/relation-types", async (req) => {
    const auth = requireAuth(req);
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    await seedDefaultTypes(teamId, auth.userId);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query(
        `SELECT rt.id, rt.type_key, rt.version, rt.title, rt.source_kinds, rt.target_kinds, rt.source_type_keys, rt.target_type_keys,
                rt.cyclic, rt.is_symmetric, rt.requires_revision, rt.created_at,
                COALESCE(cnt.n, 0)::int AS assertion_count
           FROM relation_type_versions rt
           LEFT JOIN LATERAL (
             SELECT count(*) AS n FROM relation_assertions ra
              WHERE ra.team_id = rt.team_id AND ra.relation_type_version_id = rt.id AND ra.status <> 'withdrawn'
           ) cnt ON true
          WHERE rt.team_id = $1 ORDER BY rt.type_key, rt.version`,
        [teamId]
      )
    );
    return rows;
  });

  // ---------- 关系类型迁移影响预览（管理员） ----------
  // kinds/type_keys 收窄时哪些存量断言会违反新 domain/range；cyclic true→false 时存量成环数。
  app.post("/relation-types/migration-preview", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeKey: z.string().regex(/^[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/),
        sourceKinds: z.array(entityKindSchema).min(1).optional(),
        targetKinds: z.array(entityKindSchema).min(1).optional(),
        sourceTypeKeys: typeKeyListSchema.optional(),
        targetTypeKeys: typeKeyListSchema.optional(),
        cyclic: z.boolean().optional(),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    return withTeam(body.teamId, async (client) => {
      const { rows: cur } = await client.query<{
        id: string;
        version: string;
        source_kinds: string[];
        target_kinds: string[];
        source_type_keys: string[];
        target_type_keys: string[];
        cyclic: boolean;
      }>(
        `SELECT id, version, source_kinds, target_kinds, source_type_keys, target_type_keys, cyclic
           FROM relation_type_versions
          WHERE team_id = $1 AND type_key = $2
          ORDER BY created_at DESC LIMIT 1`,
        [body.teamId, body.typeKey]
      );
      if (!cur[0]) throw ERR.NOT_FOUND();
      const current = cur[0];
      const newSourceKinds = body.sourceKinds ?? current.source_kinds;
      const newTargetKinds = body.targetKinds ?? current.target_kinds;
      const newSourceTypeKeys = body.sourceTypeKeys ?? current.source_type_keys;
      const newTargetTypeKeys = body.targetTypeKeys ?? current.target_type_keys;
      const newCyclic = body.cyclic ?? current.cyclic;

      const { rows: affected } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM relation_assertions
          WHERE team_id = $1 AND relation_type_version_id = $2 AND status <> 'withdrawn'`,
        [body.teamId, current.id]
      );

      // domain/range 收窄后的存量违反：端点资产当前类型不在新集合内
      const { rows: violations } = await client.query<{ id: string; side: string; asset_name: string; type_key: string }>(
        `SELECT ra.id, 'source' AS side, sa.name AS asset_name, stv.type_key
           FROM relation_assertions ra
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
           JOIN asset_type_versions stv ON stv.team_id = sa.team_id AND stv.id = sa.current_type_version_id
          WHERE ra.team_id = $1 AND ra.relation_type_version_id = $2 AND ra.status <> 'withdrawn'
            AND (NOT ('asset' = ANY($3::text[])) OR ($5::text[] <> '{}' AND NOT (stv.type_key = ANY($5::text[]))))
          UNION ALL
         SELECT ra.id, 'target' AS side, ta.name AS asset_name, ttv.type_key
           FROM relation_assertions ra
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
           JOIN asset_type_versions ttv ON ttv.team_id = ta.team_id AND ttv.id = ta.current_type_version_id
          WHERE ra.team_id = $1 AND ra.relation_type_version_id = $2 AND ra.status <> 'withdrawn'
            AND (NOT ('asset' = ANY($4::text[])) OR ($6::text[] <> '{}' AND NOT (ttv.type_key = ANY($6::text[]))))
          LIMIT 20`,
        [body.teamId, current.id, newSourceKinds, newTargetKinds, newSourceTypeKeys, newTargetTypeKeys]
      );

      // cyclic true→false：统计存量成环（沿同类型断言从 target 走回 source）
      let existingCycles = 0;
      if (current.cyclic && !newCyclic) {
        const { rows: edges } = await client.query<{ source_asset_id: string; target_asset_id: string }>(
          `SELECT source_asset_id, target_asset_id FROM relation_assertions
            WHERE team_id = $1 AND relation_type_version_id = $2 AND status <> 'withdrawn'`,
          [body.teamId, current.id]
        );
        const adjacency = new Map<string, string[]>();
        for (const e of edges) {
          adjacency.set(e.source_asset_id, [...(adjacency.get(e.source_asset_id) ?? []), e.target_asset_id]);
        }
        const seenEdges = new Set<string>();
        for (const e of edges) {
          // 从每条边出发做有界 DFS，找回到自身起点的路径
          const stack: { node: string; path: string[] }[] = [{ node: e.target_asset_id, path: [e.source_asset_id] }];
          let guard = 0;
          while (stack.length > 0 && guard < 10000) {
            guard += 1;
            const cur2 = stack.pop()!;
            if (cur2.node === e.source_asset_id) {
              existingCycles += 1;
              break;
            }
            if (cur2.path.length > 16) continue;
            for (const next of adjacency.get(cur2.node) ?? []) {
              stack.push({ node: next, path: [...cur2.path, cur2.node] });
            }
          }
          if (existingCycles > 0) break;
        }
      }

      const structuralChanges: string[] = [];
      const kindsChanged =
        [...newSourceKinds].sort().join(",") !== [...current.source_kinds].sort().join(",") ||
        [...newTargetKinds].sort().join(",") !== [...current.target_kinds].sort().join(",");
      if (kindsChanged) structuralChanges.push(`实体 kind domain/range 变更：[${current.source_kinds}]→[${newSourceKinds}] / [${current.target_kinds}]→[${newTargetKinds}]`);
      if (newSourceTypeKeys !== current.source_type_keys || newTargetTypeKeys !== current.target_type_keys) {
        structuralChanges.push(
          `类级 domain/range 变更：[${current.source_type_keys}]→[${newSourceTypeKeys}] / [${current.target_type_keys}]→[${newTargetTypeKeys}]`
        );
      }
      if (current.cyclic && !newCyclic) structuralChanges.push("关闭成环允许：存量环将无法通过新版本校验");
      if (!current.cyclic && newCyclic) structuralChanges.push("放开成环允许：仅放宽，不影响存量");

      return {
        typeKey: body.typeKey,
        currentVersionId: current.id,
        currentVersion: current.version,
        affectedAssertions: Number(affected[0]?.n ?? "0"),
        domainRangeViolations: violations,
        existingCycles,
        safe: violations.length === 0 && existingCycles === 0,
        structuralChanges,
      };
    });
  });

  app.get("/types", async (req) => {
    const auth = requireAuth(req);
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    await seedDefaultTypes(teamId, auth.userId);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query(
        `SELECT v.id, v.type_key, v.version, v.title, v.status, v.json_schema, v.unit_vocabularies,
                v.parent_type_version_id, p.type_key AS parent_type_key, p.version AS parent_version, v.created_at
           FROM asset_type_versions v
           LEFT JOIN asset_type_versions p ON p.team_id = v.team_id AND p.id = v.parent_type_version_id
          WHERE v.team_id = $1 ORDER BY v.type_key, v.version`,
        [teamId]
      )
    );
    return rows;
  });

  // ---------- 本体导出（治理工件，只读派生；不外发） ----------
  // 吸收 semantica 的版本化 IRI / OWL-Shapes 思想：把类型注册表 + 关系注册表
  // 派生成稳定结构的本体文档（类 = 资产类型含层次；对象属性 = 关系类型含 domain/range），
  // 附整体摘要（stableStringify + sha256），供外部工具与归档消费。
  // format=turtle 时序列化为 RDF 1.1 Turtle（确定性输出，时间戳不入正文，
  // digest 以 owl:versionInfo 关联 JSON 文档）；IRI 约定 <urn:taw:{teamId}:...>。

  interface TurtleDoc {
    teamId: string;
    ontologyDigest: string;
    classes: {
      iri: string; key: string; version: string; title: string; status: string;
      subClassOf: { key: string; version: string } | null;
      required: string[];
      properties: Record<string, { type: string; enum?: string[] }>;
      additionalProperties: boolean;
      vocabularies: unknown;
    }[];
    objectProperties: {
      iri: string; key: string; version: string; title: string;
      domain: { kinds: string[]; typeKeys: string[] };
      range: { kinds: string[]; typeKeys: string[] };
      cyclic: boolean; isSymmetric: boolean; requiresRevision: boolean;
    }[];
  }

  /** JSON 字符串转义与 Turtle STRING_LITERAL 转义兼容（引号/反斜杠/控制字符均合法转出）。 */
  const tl = (s: string): string => JSON.stringify(s);
  const tIri = (iri: string): string => {
    if (!iri.startsWith("taw:")) throw new Error(`非 taw IRI：${iri}`);
    return `<urn:${iri}>`;
  };

  function toTurtle(doc: TurtleDoc): string {
    const team = doc.teamId;
    // 类 key → 全部版本 IRI（domain/range 的 typeKeys 引用的是 key，不含版本）
    const irisByKey = new Map<string, string[]>();
    for (const c of doc.classes) {
      const list = irisByKey.get(c.key) ?? [];
      list.push(c.iri);
      irisByKey.set(c.key, list);
    }
    for (const [k, list] of irisByKey) irisByKey.set(k, [...list].sort());
    // kind 层伪类：domain/range 只限定 kind 未限定 typeKey 时使用
    const kindsUsed = new Set<string>();
    const sideNodes = (side: { kinds: string[]; typeKeys: string[] }): string[] => {
      if (side.typeKeys.length > 0) {
        const iris = side.typeKeys.flatMap((k) => irisByKey.get(k) ?? []).sort();
        if (iris.length > 0) return iris;
      }
      for (const k of side.kinds) kindsUsed.add(k);
      return side.kinds.map((k) => `taw:${team}:kind:${k}`).sort();
    };

    const out: string[] = [];
    out.push(`# 团队资产工作台本体（taw-ontology/1 → RDF 1.1 Turtle，确定性序列化）`);
    out.push(`# ontologyDigest: ${doc.ontologyDigest}（与 JSON 导出一致；时间戳不入正文）`);
    out.push(`@prefix owl: <http://www.w3.org/2002/07/owl#> .`);
    out.push(`@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .`);
    out.push(`@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .`);
    out.push(`@prefix tk: <urn:taw:meta:> .`);
    out.push(``);
    out.push(`${tIri(`taw:${team}`)} a owl:Ontology ;`);
    out.push(`    owl:versionInfo ${tl(doc.ontologyDigest)} .`);
    out.push(``);
    out.push(`# ---- 类（资产类型版本；subClassOf 仅当父类型存在于注册表） ----`);
    for (const c of doc.classes) {
      const lines: string[] = [];
      lines.push(`${tIri(c.iri)} a owl:Class ;`);
      lines.push(`    rdfs:label ${tl(c.title)} ;`);
      lines.push(`    tk:key ${tl(c.key)} ;`);
      lines.push(`    tk:version ${tl(c.version)} ;`);
      lines.push(`    tk:status ${tl(c.status)} ;`);
      if (c.subClassOf) {
        const parent = doc.classes.find((p) => p.key === c.subClassOf!.key && p.version === c.subClassOf!.version);
        if (parent) lines.push(`    rdfs:subClassOf ${tIri(parent.iri)} ;`);
      }
      if (c.required.length > 0) lines.push(`    tk:required ${c.required.map(tl).join(" , ")} ;`);
      lines.push(`    tk:additional-properties ${c.additionalProperties} .`);
      out.push(...lines);
      for (const name of Object.keys(c.properties).sort()) {
        const p = c.properties[name]!;
        const plines: string[] = [];
        plines.push(`${tIri(`${c.iri}#${name}`)} a owl:DatatypeProperty ;`);
        plines.push(`    rdfs:label ${tl(name)} ;`);
        plines.push(`    tk:property-type ${tl(p.type)} ;`);
        if (p.enum && p.enum.length > 0) plines.push(`    tk:enum ${p.enum.map(tl).join(" , ")} ;`);
        plines.push(`    rdfs:domain ${tIri(c.iri)} .`);
        out.push(...plines);
      }
    }
    const kindIrisAt = (): string[] => [...kindsUsed].sort();
    const relLines: string[] = [];
    for (const r of doc.objectProperties) {
      const emitSide = (pred: string, side: { kinds: string[]; typeKeys: string[] }): string[] => {
        const nodes = sideNodes(side);
        if (nodes.length === 0) return [];
        if (nodes.length === 1) return [`    ${pred} ${tIri(nodes[0]!)} ;`];
        return [
          `    ${pred} [`,
          `        a owl:Class ;`,
          `        owl:unionOf ( ${nodes.map(tIri).join(" ")} )`,
          `    ] ;`,
        ];
      };
      relLines.push(`${tIri(r.iri)} a owl:ObjectProperty ;`);
      relLines.push(`    rdfs:label ${tl(r.title)} ;`);
      relLines.push(`    tk:key ${tl(r.key)} ;`);
      relLines.push(`    tk:version ${tl(r.version)} ;`);
      relLines.push(...emitSide("rdfs:domain", r.domain));
      relLines.push(...emitSide("rdfs:range", r.range));
      relLines.push(`    tk:cyclic ${r.cyclic} ;`);
      relLines.push(`    tk:symmetric ${r.isSymmetric} ;`);
      relLines.push(`    tk:requires-revision ${r.requiresRevision} .`);
    }
    // kind 段在对象属性遍历后渲染（kindsUsed 由 domain/range 解析填充）
    const kindIris = kindIrisAt();
    if (kindIris.length > 0) {
      out.push(``);
      out.push(`# ---- kind 层伪类（关系 domain/range 只限定实体 kind、未限定类型时使用） ----`);
      for (const k of kindIris) {
        out.push(`${tIri(`taw:${team}:kind:${k}`)} a owl:Class ;`);
        out.push(`    rdfs:label ${tl(`kind:${k}（kind 层，未限定类型）`)} .`);
      }
    }
    out.push(``);
    out.push(`# ---- 对象属性（关系类型；domain/range 多值用 owl:unionOf） ----`);
    out.push(...relLines);
    return out.join("\n") + "\n";
  }

  app.get("/ontology/export", async (req, reply) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; format?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: typeRows } = await client.query<TypeDefRow>(
        `SELECT id, type_key, version, title, json_schema, unit_vocabularies, parent_type_version_id, status
           FROM asset_type_versions WHERE team_id = $1 ORDER BY type_key, version`,
        [teamId]
      );
      const byId = new Map(typeRows.map((t) => [t.id, t]));
      const { rows: relRows } = await client.query<{
        type_key: string;
        version: string;
        title: string;
        source_kinds: string[];
        target_kinds: string[];
        source_type_keys: string[];
        target_type_keys: string[];
        cyclic: boolean;
        is_symmetric: boolean;
        requires_revision: boolean;
      }>(
        `SELECT type_key, version, title, source_kinds, target_kinds, source_type_keys, target_type_keys,
                cyclic, is_symmetric, requires_revision
           FROM relation_type_versions WHERE team_id = $1 ORDER BY type_key, version`,
        [teamId]
      );

      const classes = typeRows.map((t) => {
        const schema = t.json_schema as {
          required?: string[];
          properties?: Record<string, unknown>;
          additionalProperties?: boolean;
        };
        const parent = t.parent_type_version_id ? byId.get(t.parent_type_version_id) : undefined;
        return {
          iri: `taw:${teamId}:class:${t.type_key}:${t.version}`,
          key: t.type_key,
          version: t.version,
          title: t.title,
          status: t.status,
          subClassOf: parent ? { key: parent.type_key, version: parent.version } : null,
          required: schema.required ?? [],
          properties: Object.fromEntries(
            Object.entries(schema.properties ?? {}).map(([k, v]) => [
              k,
              {
                type: (v as { type?: string }).type ?? "unknown",
                enum: (v as { enum?: string[] }).enum,
              },
            ])
          ),
          additionalProperties: schema.additionalProperties !== false,
          vocabularies: t.unit_vocabularies,
        };
      });

      const objectProperties = relRows.map((r) => ({
        iri: `taw:${teamId}:relation:${r.type_key}:${r.version}`,
        key: r.type_key,
        version: r.version,
        title: r.title,
        domain: { kinds: r.source_kinds, typeKeys: r.source_type_keys },
        range: { kinds: r.target_kinds, typeKeys: r.target_type_keys },
        cyclic: r.cyclic,
        isSymmetric: r.is_symmetric,
        requiresRevision: r.requires_revision,
      }));

      const digest = createHash("sha256").update(stableStringify({ classes, objectProperties })).digest("hex");
      if (query.format === "turtle") {
        const body = toTurtle({
          teamId,
          ontologyDigest: digest,
          classes: classes as unknown as TurtleDoc["classes"],
          objectProperties: objectProperties as unknown as TurtleDoc["objectProperties"],
        });
        return reply.code(200).header("content-type", "text/turtle; charset=utf-8").send(body);
      }
      return {
        format: "taw-ontology/1",
        teamId,
        exportedAt: new Date().toISOString(),
        classCount: classes.length,
        objectPropertyCount: objectProperties.length,
        classes,
        objectProperties,
        ontologyDigest: digest,
      };
    });
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
      // 锁定类型定义并校验属性（A03）。层次：子类型资产必须同时满足链上全部祖先定义。
      const chain = await loadTypeChain(client, body.teamId, body.typeVersionId);
      const { rows: statusRow } = await client.query<{ status: string }>(
        `SELECT status FROM asset_type_versions WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.typeVersionId]
      );
      if (statusRow[0]?.status !== "active") throw ERR.INVALID("typeVersionId 不存在或已停用");
      const allErrors: string[] = [];
      for (const def of chain) {
        const check = validateProperties(
          { jsonSchema: def.json_schema, unitVocabularies: def.unit_vocabularies },
          body.properties
        );
        if (!check.valid) {
          allErrors.push(
            ...check.errors.map((e) => (chain.length > 1 ? `[${def.type_key} v${def.version}] ${e}` : e))
          );
        }
      }
      if (allErrors.length > 0) throw ERR.INVALID("属性不满足类型约束", allErrors);

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
  // lifecycle 过滤：active（默认，排除归档）/ archived（仅归档）/ all
  app.get("/assets/search", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as {
      teamId?: string; q?: string; type?: string; label?: string; limit?: string; lifecycle?: string;
    };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const lifecycle = query.lifecycle === "archived" || query.lifecycle === "all" ? query.lifecycle : "active";
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
            AND ($5 = 'all' OR a.lifecycle = CASE WHEN $5 = 'archived' THEN 'archived' ELSE 'active' END)
          ORDER BY a.created_at DESC LIMIT $4`,
        [teamId, query.q ?? "", query.type ?? "", limit, lifecycle]
      )
    );
    return rows;
  });

  app.get("/assets/:assetId", async (req) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const query = (req.query ?? {}) as { teamId?: string; revLimit?: string; revOffset?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    // 修订历史分页：长历史资产不再一次性返回全部修订（revisionsTotal 供界面提示）
    const revLimit = Math.min(Math.max(Number(query.revLimit ?? 50), 1), 200);
    const revOffset = Math.max(Number(query.revOffset ?? 0), 0);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.name, a.lifecycle, a.created_at, tv.type_key, tv.version AS type_version, tv.id AS type_version_id
           FROM assets a JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, assetId]
      );
      const asset = rows[0];
      if (!asset) throw ERR.NOT_FOUND();
      const { rows: total } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM asset_revisions WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      const { rows: revisions } = await client.query(
        `SELECT id, seq, content_digest, properties, created_at, created_by FROM asset_revisions
          WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT $3 OFFSET $4`,
        [teamId, assetId, revLimit, revOffset]
      );
      const { rows: labels } = await client.query<{ label: string }>(
        `SELECT label FROM asset_labels WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      const { rows: categories } = await client.query<{ category_path: string; is_primary: boolean }>(
        `SELECT category_path, is_primary FROM asset_categories WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      return { ...asset, revisions, revisionsTotal: total[0]!.n, labels: labels.map((l) => l.label), categories };
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

  // ---------- 生命周期：归档 / 恢复 ----------
  // 归档语义：目录默认视图隐藏 + 禁止新草稿与新 CR；已发布修订与通道历史不受影响（不可变）。
  // 权限：创建者本人或团队管理员；全程写 audit_events。
  async function loadAssetForLifecycle(
    client: PoolClient,
    teamId: string,
    assetId: string
  ): Promise<{ id: string; name: string; lifecycle: string; created_by: string }> {
    const { rows } = await client.query<{ id: string; name: string; lifecycle: string; created_by: string }>(
      `SELECT id, name, lifecycle, created_by FROM assets WHERE team_id = $1 AND id = $2 FOR UPDATE`,
      [teamId, assetId]
    );
    const asset = rows[0];
    if (!asset) throw ERR.NOT_FOUND();
    return asset;
  }

  app.post("/assets/:assetId/archive", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), reason: z.string().min(4).max(500) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const asset = await loadAssetForLifecycle(client, body.teamId, assetId);
      if (asset.lifecycle === "archived") {
        throw ERR.CONFLICT("ALREADY_ARCHIVED", "资产已处于归档状态");
      }
      if (role !== "admin" && asset.created_by !== auth.userId) {
        throw ERR.FORBIDDEN();
      }
      // 存在未完成工作分支草稿时禁止归档：必须先合并或放弃分支
      const { rows: drafts } = await client.query(
        `SELECT 1 FROM branch_entries e
           JOIN branches b ON b.team_id = e.team_id AND b.id = e.branch_id
          WHERE e.team_id = $1 AND e.asset_id = $2 AND b.status = 'open' LIMIT 1`,
        [body.teamId, assetId]
      );
      if (drafts[0]) {
        throw ERR.CONFLICT("OPEN_DRAFTS", "资产存在未完成的工作分支草稿，先合并或放弃对应分支后再归档");
      }
      await client.query(`UPDATE assets SET lifecycle = 'archived' WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        assetId,
      ]);
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, detail)
         VALUES ($1, $2, 'asset.archive', 'asset', $3, $4)`,
        [body.teamId, auth.userId, assetId, JSON.stringify({ reason: body.reason, name: asset.name })]
      );
    });
    return reply.code(200).send({ teamId: body.teamId, assetId, lifecycle: "archived" });
  });

  app.post("/assets/:assetId/restore", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), reason: z.string().min(4).max(500) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const asset = await loadAssetForLifecycle(client, body.teamId, assetId);
      if (asset.lifecycle !== "archived") {
        throw ERR.CONFLICT("NOT_ARCHIVED", "仅归档状态的资产可恢复");
      }
      if (role !== "admin" && asset.created_by !== auth.userId) {
        throw ERR.FORBIDDEN();
      }
      await client.query(`UPDATE assets SET lifecycle = 'active' WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        assetId,
      ]);
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, detail)
         VALUES ($1, $2, 'asset.restore', 'asset', $3, $4)`,
        [body.teamId, auth.userId, assetId, JSON.stringify({ reason: body.reason, name: asset.name })]
      );
    });
    return reply.code(200).send({ teamId: body.teamId, assetId, lifecycle: "active" });
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
      // 关系类型的 domain/range：kind 级 + 类级（type_key 集合，空数组 = 不限）
      const { rows: rt } = await client.query<{
        type_key: string;
        source_kinds: string[];
        target_kinds: string[];
        source_type_keys: string[];
        target_type_keys: string[];
        cyclic: boolean;
      }>(
        `SELECT type_key, source_kinds, target_kinds, source_type_keys, target_type_keys, cyclic
           FROM relation_type_versions WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.relationTypeVersionId]
      );
      const relType = rt[0];
      if (!relType) throw ERR.INVALID("relationTypeVersionId 不存在");
      const endpointType = async (assetId: string): Promise<{ kind: string; type_key: string } | null> => {
        const { rows } = await client.query<{ kind: string; type_key: string }>(
          `SELECT e.kind, tv.type_key FROM assets a
             JOIN entities e ON e.team_id = a.team_id AND e.id = a.id
             JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
            WHERE a.team_id = $1 AND a.id = $2`,
          [body.teamId, assetId]
        );
        return rows[0] ?? null;
      };
      const srcInfo = await endpointType(body.sourceAssetId);
      const tgtInfo = await endpointType(body.targetAssetId);
      if (!srcInfo || !tgtInfo) throw ERR.INVALID("源或目标资产不存在于本团队");
      const domainRangeErrors: string[] = [];
      if (!relType.source_kinds.includes(srcInfo.kind)) {
        domainRangeErrors.push(`源端点 kind=${srcInfo.kind} 不在关系类型的 source_kinds [${relType.source_kinds.join(", ")}] 内`);
      }
      if (!relType.target_kinds.includes(tgtInfo.kind)) {
        domainRangeErrors.push(`目标端点 kind=${tgtInfo.kind} 不在关系类型的 target_kinds [${relType.target_kinds.join(", ")}] 内`);
      }
      if (relType.source_type_keys.length > 0 && !relType.source_type_keys.includes(srcInfo.type_key)) {
        domainRangeErrors.push(`源资产类型 ${srcInfo.type_key} 不在 source_type_keys [${relType.source_type_keys.join(", ")}] 内`);
      }
      if (relType.target_type_keys.length > 0 && !relType.target_type_keys.includes(tgtInfo.type_key)) {
        domainRangeErrors.push(`目标资产类型 ${tgtInfo.type_key} 不在 target_type_keys [${relType.target_type_keys.join(", ")}] 内`);
      }
      if (domainRangeErrors.length > 0) {
        throw ERR.CONFLICT("DOMAIN_RANGE_VIOLATION", `断言违反关系类型 ${relType.type_key} 的 domain/range`, domainRangeErrors);
      }
      if (!relType.cyclic) {
        // 成环禁止：新边 S→T 成环 ⟺ 既有图中存在 T→…→S 的路径。
        // 实现：从 S 沿"入边"反向走（前驱），若能到达 T 即成环。
        const { rows: cyc } = await client.query(
          `WITH RECURSIVE walk AS (
             SELECT ra.source_asset_id AS node FROM relation_assertions ra
              WHERE ra.team_id = $1 AND ra.relation_type_version_id = $2 AND ra.status <> 'withdrawn'
                AND ra.target_asset_id = $4
             UNION
             SELECT ra.source_asset_id FROM relation_assertions ra
              JOIN walk w ON ra.target_asset_id = w.node
              WHERE ra.team_id = $1 AND ra.relation_type_version_id = $2 AND ra.status <> 'withdrawn'
           ) SELECT 1 FROM walk WHERE node = $3 LIMIT 1`,
          [body.teamId, body.relationTypeVersionId, body.targetAssetId, body.sourceAssetId]
        );
        if (cyc[0]) {
          throw ERR.CONFLICT("CYCLE_FORBIDDEN", `关系类型 ${relType.type_key} 不允许成环：该断言将与既有断言构成环`);
        }
      }
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
