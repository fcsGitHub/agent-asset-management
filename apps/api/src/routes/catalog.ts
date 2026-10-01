// /api/v1/types + assets + relations — 资产目录与本体（设计 7/8/9 章）。
// 资产创建即产生首个不可变修订；属性经类型 JSON Schema + 单位词表校验（A03）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import type { PoolClient } from "pg";
import { ERR, AppError } from "../errors.js";
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
import { buildSnippets } from "@taw/domain/snippets";
import { inferSchemaFromSamples, fieldsToSchema } from "@taw/domain/schema-builder";
import { DeepSeekProvider } from "@taw/agent-adapter/deepseek";
import { extractJson } from "./nl.js";

/** M61 LLM 草稿白名单：未知字段拒绝（strict）、形状与 SchemaFieldDraft 对齐、数量与长度上限。 */
export const SchemaDraft = z
  .object({
    typeKey: z.string().regex(/^[a-z][a-z0-9.\-]{0,63}$/).optional().or(z.literal("")),
    title: z.string().min(1).max(64).optional().or(z.literal("")),
    fields: z
      .array(
        z.strictObject({
          key: z.string().min(1).max(64),
          type: z.enum(["string", "number", "integer", "boolean", "object", "array"]),
          required: z.boolean(),
          enumValues: z.string().max(500).optional(),
          minimum: z.number().optional(),
          maximum: z.number().optional(),
          items: z.enum(["string", "number", "integer", "boolean"]).optional(),
        })
      )
      .min(1)
      .max(24),
  })
  .strict();
import { markGraphDirty } from "@taw/graph";
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

// 类型链装载与属性校验（M59 抽共享关卡）：登记/分支保存/dry-run 共用同一实现
import { loadTypeChain, validateAgainstChain, type TypeDefRow } from "../ontology.js";
import { schemaToFormSpec } from "@taw/domain/schema-form";
import { computeCompleteness, OWNER_KEYS } from "@taw/domain/completeness";
import { buildCitation } from "@taw/domain/cite";
import { extractLineageRefs, planLabelPropagation } from "@taw/domain/lineage";
import { parsePropFilters, type PropFilter } from "@taw/domain/prop-filter";
import { summarizeCompleteness } from "@taw/domain/completeness-summary";
export type { TypeDefRow };

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

/** 关系断言核心（共享）：HTTP 端点与语义候选确认走同一条路径——
 * kind 级与类级 domain/range、成环禁止、修订绑定校验全部在此强制执行。
 * 传入 existingClient 时在调用方事务内执行（候选确认要求原子性），否则自开事务。 */
export async function createRelationAssertion(
  teamId: string,
  userId: string,
  body: {
    relationTypeVersionId: string;
    sourceAssetId: string;
    sourceRevisionId?: string;
    targetAssetId: string;
    targetRevisionId?: string;
    conditions?: Record<string, unknown>;
    evidenceNote?: string;
    confirm: boolean;
  },
  existingClient?: PoolClient
): Promise<{ relationId: string; status: string }> {
  const id = newId();
  const status = body.confirm ? "confirmed" : "proposed";
  const run = async (client: PoolClient): Promise<void> => {
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
      [teamId, body.relationTypeVersionId]
    );
    const relType = rt[0];
    if (!relType) throw ERR.INVALID("relationTypeVersionId 不存在");
    const endpointType = async (assetId: string): Promise<{ kind: string; type_key: string } | null> => {
      const { rows } = await client.query<{ kind: string; type_key: string }>(
        `SELECT e.kind, tv.type_key FROM assets a
           JOIN entities e ON e.team_id = a.team_id AND e.id = a.id
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, assetId]
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
        [teamId, body.relationTypeVersionId, body.targetAssetId, body.sourceAssetId]
      );
      if (cyc[0]) {
        throw ERR.CONFLICT("CYCLE_FORBIDDEN", `关系类型 ${relType.type_key} 不允许成环：该断言将与既有断言构成环`);
      }
    }
    if (body.sourceRevisionId) {
      const { rows: sr } = await client.query(
        `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND id = $2 AND asset_id = $3`,
        [teamId, body.sourceRevisionId, body.sourceAssetId]
      );
      if (!sr[0]) throw ERR.INVALID("源修订与资产不匹配");
    }
    if (body.targetRevisionId) {
      const { rows: tr } = await client.query(
        `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND id = $2 AND asset_id = $3`,
        [teamId, body.targetRevisionId, body.targetAssetId]
      );
      if (!tr[0]) throw ERR.INVALID("目标修订与资产不匹配");
    }
    // 重复断言防护（实测走查发现）：同（团队 + 关系类型 + 源 + 目标）且不带修订限定的
    // 存活断言只允许一条——事实型断言重复只会产生平行重边与虚高计数。带修订限定的
    // 断言表达"对特定修订的事实"，语义上可多条，不在此约束。并发兜底见下方 23505 捕获。
    if (!body.sourceRevisionId && !body.targetRevisionId) {
      const { rows: dup } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM relation_assertions
          WHERE team_id = $1 AND relation_type_version_id = $2
            AND source_asset_id = $3 AND target_asset_id = $4
            AND source_revision_id IS NULL AND target_revision_id IS NULL
            AND status <> 'withdrawn' LIMIT 1`,
        [teamId, body.relationTypeVersionId, body.sourceAssetId, body.targetAssetId]
      );
      if (dup[0]) {
        throw ERR.CONFLICT(
          "DUPLICATE_ASSERTION",
          `同一（关系类型 + 源 + 目标）的断言已存在（status=${dup[0].status}）；如需重建请先撤回既有断言`
        );
      }
    }
    try {
      await client.query(
        `INSERT INTO relation_assertions (team_id, id, relation_type_version_id, source_asset_id, source_revision_id,
          target_asset_id, target_revision_id, conditions, evidence_note, status, proposed_by, confirmed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          teamId, id, body.relationTypeVersionId,
          body.sourceAssetId, body.sourceRevisionId ?? null,
          body.targetAssetId, body.targetRevisionId ?? null,
          JSON.stringify(body.conditions ?? {}), body.evidenceNote ?? null,
          status, userId, body.confirm ? userId : null,
        ]
      );
    } catch (err) {
      // 并发竞态：检查通过后另一事务先插入，部分唯一索引以 23505 拒绝——转成同一业务错误
      if ((err as { code?: string }).code === "23505") {
        throw ERR.CONFLICT("DUPLICATE_ASSERTION", "同一（关系类型 + 源 + 目标）的断言已存在（并发插入被唯一索引拒绝）");
      }
      throw err;
    }
    // 图投影脏标记（M49）：与断言写入同事务提交，worker 周期重建图库
    await markGraphDirty(client, teamId);
  };
  if (existingClient) await run(existingClient);
  else await withTeam(teamId, run);
  return { relationId: id, status };
}

/** 目录行查询（M67 抽共享）：search 与 completeness-summary 共用同一条 SQL 与过滤语义。
 *  propFilters 逐项 `r.properties->>$k = $v`（->> 右参可参数化，无注入面；文本等值）。 */
async function queryAssetRows(
  teamId: string,
  opts: {
    q?: string; type?: string; label?: string; typePrefix?: string;
    lifecycle: "active" | "archived" | "all";
    propFilters: PropFilter[];
    sort: "newest" | "refs" | "usage" | "completeness";
    limit: number;
  }
): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [
    teamId, opts.q ?? "", opts.type ?? "", opts.lifecycle, opts.label ?? "", opts.typePrefix ?? "", opts.sort, opts.limit,
  ];
  let propClause = "";
  for (const f of opts.propFilters) {
    // M68②：点号嵌套路径走 #>>（数组参数），一级属性走 ->>；范围比较先验数值正则
    // （非数值行排除而不是 22P02 抛错），路径与值全部参数化
    const dotted = f.key.includes(".");
    const p = params.push(dotted ? f.key.split(".") : f.key);
    const v = params.push(f.value);
    const textExpr = dotted ? `r.properties #>> $${p}::text[]` : `r.properties->>$${p}`;
    if (f.op === "=") {
      propClause += ` AND ${textExpr} = $${v}\n`;
    } else {
      const cmp = f.op === ">=" ? ">=" : "<=";
      propClause += ` AND CASE WHEN ${textExpr} ~ '^-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN (${textExpr})::numeric ELSE NULL END ${cmp} $${v}::numeric\n`;
    }
  }
  return withTeam(teamId, async (client) => {
    const result = await client.query(
      `SELECT a.id, a.name, a.lifecycle, tv.type_key, tv.version AS type_version, tv.id AS type_version_id,
              r.id AS head_revision_id, r.content_digest, r.created_at, r.properties,
              (SELECT al.alias FROM asset_aliases al
                WHERE al.team_id = a.team_id AND al.asset_id = a.id AND al.alias ILIKE '%' || $2 || '%'
                ORDER BY al.alias LIMIT 1) AS matched_alias,
              EXISTS (
                SELECT 1 FROM revision_artifacts ra
                 WHERE ra.team_id = a.team_id AND ra.revision_id = r.id
              ) AS has_artifacts,
              arc.n AS artifact_count,
              rc.n AS relation_count,
              uc.n AS usage_count,
              alc.n AS alias_count,
              lc.n AS label_count,
              cc.n AS category_count
         FROM assets a
         JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
         JOIN LATERAL (
           SELECT id, content_digest, created_at, properties FROM asset_revisions
            WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1
         ) r ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM revision_artifacts ra
            WHERE ra.team_id = a.team_id AND ra.revision_id = r.id
         ) arc ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM relation_assertions ra
            WHERE ra.team_id = a.team_id AND ra.status <> 'withdrawn'
              AND (ra.source_asset_id = a.id OR ra.target_asset_id = a.id)
         ) rc ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM usage_events ue
            WHERE ue.team_id = a.team_id AND ue.asset_id = a.id
              AND ue.created_at > now() - interval '90 days'
         ) uc ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM asset_aliases al
            WHERE al.team_id = a.team_id AND al.asset_id = a.id
         ) alc ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM asset_labels l
            WHERE l.team_id = a.team_id AND l.asset_id = a.id
         ) lc ON true
         JOIN LATERAL (
           SELECT count(*)::int AS n FROM asset_categories c
            WHERE c.team_id = a.team_id AND c.asset_id = a.id
         ) cc ON true
        WHERE a.team_id = $1
          AND ($2 = '' OR a.name ILIKE '%' || $2 || '%' OR EXISTS (
                SELECT 1 FROM asset_aliases al
                 WHERE al.team_id = a.team_id AND al.asset_id = a.id AND al.alias ILIKE '%' || $2 || '%'
              ))
          AND ($3 = '' OR tv.type_key = $3)
          AND ($4 = 'all' OR a.lifecycle = CASE WHEN $4 = 'archived' THEN 'archived' ELSE 'active' END)
          AND ($5 = '' OR EXISTS (
                SELECT 1 FROM asset_labels l
                 WHERE l.team_id = a.team_id AND l.asset_id = a.id AND l.label = $5
              ))
          AND ($6 = '' OR tv.type_key LIKE $6 || '%')
${propClause}        ORDER BY (CASE WHEN $7 = 'refs' THEN rc.n WHEN $7 = 'usage' THEN uc.n END) DESC NULLS LAST, a.created_at DESC LIMIT $8`,
      params
    );
    return result.rows as Record<string, unknown>[];
  });
}

/** 行级打分管线（M66③/M67⑦ 共用）：required 按类型链缓存；计算后剥离 properties。
 *  行上附 completenessScore + completenessChecks（search 返回前剥离 checks，summary 用）。 */
async function scoreAssetRows(teamId: string, rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const requiredCache = new Map<string, string[]>();
  return withTeam(teamId, async (client) => {
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const tvId = String(row.type_version_id ?? "");
      let requiredFields = requiredCache.get(tvId);
      if (requiredFields === undefined) {
        const chain = await loadTypeChain(client, teamId, tvId);
        requiredFields = schemaToFormSpec(
          chain.map((d) => ({ typeKey: d.type_key, version: d.version, jsonSchema: d.json_schema, unitVocabularies: d.unit_vocabularies }))
        ).fields.filter((f) => f.required).map((f) => f.key);
        requiredCache.set(tvId, requiredFields);
      }
      const report = computeCompleteness({
        requiredFields,
        properties: (row.properties ?? {}) as Record<string, unknown>,
        artifactsCount: Number(row.artifact_count ?? 0),
        relationsCount: Number(row.relation_count ?? 0),
        aliasesCount: Number(row.alias_count ?? 0),
        labelsCount: Number(row.label_count ?? 0),
        categoriesCount: Number(row.category_count ?? 0),
      });
      delete row.properties;
      delete row.type_version_id;
      out.push({
        ...row,
        completenessScore: report.score,
        completenessChecks: report.checks.map((c) => ({ title: c.title, passed: c.passed })),
      });
    }
    return out;
  });
}

/** 标签沿血缘传播规划（M67③）：derivedFrom 断言方向=源(派生物)→目标(基座)，
 *  标签传播方向相反（基座→派生物，Atlas 下游传播）——递归取「以起点为基座」的
 *  全部派生链，边统一转为 from=上游 base、to=下游派生物。 */
async function buildPropagationPlan(
  client: PoolClient,
  teamId: string,
  assetId: string
): Promise<{ plan: ReturnType<typeof planLabelPropagation>; names: Map<string, string>; sourceLabels: string[] }> {
  const { rows: edgeRows } = await client.query<{ base: string; node: string }>(
    `WITH RECURSIVE down AS (
       SELECT ra.target_asset_id AS base, ra.source_asset_id AS node
         FROM relation_assertions ra
         JOIN relation_type_versions tv ON tv.team_id = ra.team_id AND tv.id = ra.relation_type_version_id
        WHERE ra.team_id = $1 AND tv.type_key = 'derivedFrom' AND ra.status <> 'withdrawn' AND ra.target_asset_id = $2
       UNION
       SELECT ra.target_asset_id, ra.source_asset_id
         FROM relation_assertions ra
         JOIN relation_type_versions tv ON tv.team_id = ra.team_id AND tv.id = ra.relation_type_version_id
         JOIN down d ON ra.target_asset_id = d.node
        WHERE ra.team_id = $1 AND tv.type_key = 'derivedFrom' AND ra.status <> 'withdrawn'
     ) SELECT base, node FROM down`,
    [teamId, assetId]
  );
  const edges = edgeRows.map((r) => ({ from: r.base, to: r.node }));
  const ids = [...new Set([assetId, ...edges.flatMap((e) => [e.from, e.to])])];
  const { rows: labelRows } = await client.query<{ asset_id: string; label: string }>(
    `SELECT asset_id, label FROM asset_labels WHERE team_id = $1 AND asset_id = ANY($2::uuid[])`,
    [teamId, ids]
  );
  const labelsByAsset: Record<string, string[]> = {};
  for (const r of labelRows) {
    (labelsByAsset[r.asset_id] ??= []).push(r.label);
  }
  const { rows: nameRows } = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM assets WHERE team_id = $1 AND id = ANY($2::uuid[])`,
    [teamId, ids]
  );
  return {
    plan: planLabelPropagation({ sourceId: assetId, edges, labelsByAsset }),
    names: new Map(nameRows.map((r) => [r.id, r.name])),
    sourceLabels: labelsByAsset[assetId] ?? [],
  };
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
        // M58 发布测试门禁（GitHub required checks 思想）：门禁策略声明在类型层——
        // 该类型资产进入正式发布必须携带最新一次通过的测试运行证据；不可变，改门禁=注册新版本
        requiresTestEvidence: z.boolean().default(false),
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
        `INSERT INTO asset_type_versions (team_id, id, type_key, version, title, json_schema, unit_vocabularies, parent_type_version_id, requires_test_evidence, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [body.teamId, id, body.typeKey, body.version, body.title, JSON.stringify(body.jsonSchema), JSON.stringify(body.unitVocabularies), body.parentTypeVersionId ?? null, body.requiresTestEvidence, auth.userId]
      );
      // 图投影脏标记（M49）：类层次 SUBCLASS_OF 边可能变化
      await markGraphDirty(client, body.teamId);
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

  // 从样例推断 JSON Schema（M60 便捷生成）：零副作用，成员可用（推断不产生任何
  // 写入；登记仍走 POST /types 的全部质量门）。与 @taw/domain/schema-builder 同源。
  app.post("/types/infer-schema", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        samples: z.array(z.unknown()).min(1).max(50),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const inferred = inferSchemaFromSamples(body.samples);
    if (!compileTypeSchema(inferred.jsonSchema)) {
      // 纯函数产物应当可编译；防御性兜底而非静默
      throw ERR.INVALID("推断产物不可编译，请检查样例结构");
    }
    return { jsonSchema: inferred.jsonSchema, notes: inferred.notes };
  });

  // 自然语言生成 schema 草稿（M61）：真实 DeepSeek 结构化输出 → 表单属性行草稿。
  // LLM 只产草稿不落库：zod 白名单校验（未知字段拒绝、枚举仅 string、数量上限），
  // fieldsToSchema 键约束复核，最终登记仍走 POST /types 全部质量门与 M59 关卡。
  // key 未配置/LLM 不可用 → 如实 503 降级，不伪造草稿。
  app.post("/types/describe-schema", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        description: z.string().min(4).max(500),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    let provider: InstanceType<typeof DeepSeekProvider>;
    try {
      provider = new DeepSeekProvider();
    } catch {
      throw ERR.DEPENDENCY("DEEPSEEK_API_KEY 未配置，自然语言生成草稿不可用（可继续使用表单构建或样例推断）");
    }
    const chat = await provider.chat(
      [
        {
          role: "system" as const,
          content:
            "你是资产类型定义助手。把用户的中文描述转成一个 JSON 对象（只输出 JSON，不要解释），形状：" +
            '{"typeKey":"<小写字母开头，仅小写字母/数字/点/连字符，如 sim.report，可为空串>","title":"<中文标题>","fields":[{"key":"<英文 camelCase 属性名>","type":"string|number|integer|boolean|object|array","required":true,"enumValues":"<仅 type=string 时：逗号分隔枚举值，可省略>","minimum":0,"maximum":10,"items":"<仅 type=array 时元素类型 string|number|integer|boolean，可省略>"}]}' +
            "。规则：属性名必须是英文 camelCase；数值范围仅在描述提及区间时填写；枚举仅在描述明确列出可选值时填写；fields 最多 24 行。",
        },
        { role: "user" as const, content: body.description },
      ] as never,
      [],
      AbortSignal.timeout(30000)
    );
    const raw = extractJson(chat.message.content ?? "");
    const parsed = SchemaDraft.safeParse(raw);
    if (!parsed.success) {
      throw ERR.CONFLICT(
        "LLM_DRAFT_INVALID",
        "模型输出未通过结构校验，未生成草稿（可换更明确的描述重试，或使用表单构建/样例推断）",
        parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".")}: ${i.message}`)
      );
    }
    const draft = parsed.data;
    const built = fieldsToSchema(
      draft.fields.map((f) => ({
        key: f.key,
        type: f.type,
        required: f.required,
        ...(f.enumValues !== undefined ? { enumValues: f.enumValues } : {}),
        ...(f.minimum !== undefined ? { minimum: f.minimum } : {}),
        ...(f.maximum !== undefined ? { maximum: f.maximum } : {}),
        ...(f.items !== undefined ? { items: f.items } : {}),
      }))
    );
    return {
      typeKey: draft.typeKey || undefined,
      title: draft.title || undefined,
      fields: draft.fields,
      jsonSchema: built.jsonSchema,
      problems: built.problems,
      model: provider.modelName,
      tokens: chat.totalTokens,
    };
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
                v.parent_type_version_id, p.type_key AS parent_type_key, p.version AS parent_version,
                v.requires_test_evidence, v.created_at
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
      // 锁定类型定义并校验属性（A03；M59 起与分支保存/dry-run 共用同一关卡）。
      // 层次：子类型资产必须同时满足链上全部祖先定义。
      const chain = await loadTypeChain(client, body.teamId, body.typeVersionId);
      const { rows: statusRow } = await client.query<{ status: string }>(
        `SELECT status FROM asset_type_versions WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.typeVersionId]
      );
      if (statusRow[0]?.status !== "active") throw ERR.INVALID("typeVersionId 不存在或已停用");
      validateAgainstChain(chain, body.properties);

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
      // 图投影脏标记（M49）：新增资产节点
      await markGraphDirty(client, body.teamId);
    });
    return reply.code(201).send({ teamId: body.teamId, assetId, revisionId });
  });

  // 属性 dry-run 校验（M59，Backstage catalog validate 端点思想）：与登记/分支保存
  // 同一关卡（loadTypeChain + validateAgainstChain），零副作用——表单提交前、Agent
  // 登记提案前、外部集成都可先拿判定，规则不可能与真实写入分叉。
  app.post("/assets/validate", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        typeVersionId: z.string().uuid(),
        properties: z.object({}).passthrough(),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    return withTeam(body.teamId, async (client) => {
      const chain = await loadTypeChain(client, body.teamId, body.typeVersionId);
      const { rows: statusRow } = await client.query<{ status: string }>(
        `SELECT status FROM asset_type_versions WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.typeVersionId]
      );
      if (statusRow[0]?.status !== "active") throw ERR.INVALID("typeVersionId 不存在或已停用");
      try {
        validateAgainstChain(chain, body.properties);
        return { valid: true, errors: [] as string[] };
      } catch (err) {
        if (err instanceof AppError && err.statusCode === 422) {
          return { valid: false, errors: (err.details as string[]) ?? [err.message] };
        }
        throw err;
      }
    });
  });

  // ---------- 查询 ----------
  // lifecycle 过滤：active（默认，排除归档）/ archived（仅归档）/ all
  // M53 分面：label（精确）与 typePrefix（前缀，支撑 文档/代码/测试/数据 家族快筛）
  // M54（Amundsen 排序信号）：relation_count 被引数；sort=refs 按关联数降序（默认最新登记）
  // M67②：prop=key=value（可重复）按 head 修订属性等值过滤（OpenMetadata 任意属性筛选）
  // M67④：行附 matched_alias（命中 q 的第一个别名）——⌘K/引用候选解释「为何命中」
  app.get("/assets/search", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as {
      teamId?: string; q?: string; type?: string; label?: string; limit?: string; lifecycle?: string; typePrefix?: string; sort?: string;
      prop?: string | string[];
    };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const { filters: propFilters, problems } = parsePropFilters(query.prop);
    if (problems.length > 0) {
      throw ERR.INVALID(`属性筛选格式不正确：${problems.join("；")}`, problems);
    }
    const limit = Math.min(Number(query.limit ?? 50), 200);
    const lifecycle = query.lifecycle === "archived" || query.lifecycle === "all" ? query.lifecycle : "active";
    const sort =
      query.sort === "refs" || query.sort === "usage" || query.sort === "completeness" ? query.sort : "newest";
    // sort=completeness 时先取满候选集（≤200），分数算完在 JS 内升序再截断
    const rows = await queryAssetRows(teamId, {
      q: query.q ?? "", type: query.type ?? "", label: query.label ?? "", typePrefix: query.typePrefix ?? "",
      lifecycle, propFilters, sort, limit: sort === "completeness" ? 200 : limit,
    });
    const scored = await scoreAssetRows(teamId, rows);
    const strip = (row: Record<string, unknown>) => {
      delete row.completenessChecks;
      return row;
    };
    if (sort === "completeness") {
      scored.sort((a, b) => Number(a.completenessScore) - Number(b.completenessScore) || String(a.name).localeCompare(String(b.name)));
      return scored.slice(0, limit).map(strip);
    }
    return scored.map(strip);
  });

  // 团队完整度水位（M67⑦，TechInsights 汇总视图）：count/平均/三档分桶 + 低分清单。
  // 与 search 同一条打分管线；候选集同界 ≤200（团队资产更多时如实注记，不假装全量）。
  app.get("/assets/completeness-summary", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; lifecycle?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const lifecycle = query.lifecycle === "archived" || query.lifecycle === "all" ? query.lifecycle : "active";
    const rows = await queryAssetRows(teamId, { lifecycle, propFilters: [], sort: "newest", limit: 200 });
    const scored = await scoreAssetRows(teamId, rows);
    const entries = scored.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      score: Number(r.completenessScore ?? 0),
      missingTitles: ((r.completenessChecks as { title: string; passed: boolean }[] | undefined) ?? [])
        .filter((c) => !c.passed)
        .map((c) => c.title),
    }));
    const summary = summarizeCompleteness(entries);
    return {
      ...summary,
      sampled: scored.length,
      note: scored.length >= 200 ? "团队资产超过 200，汇总基于最新登记的前 200 条（与目录低分排序同界）" : "",
    };
  });

  // 派生血缘字段物化（M67①，HF base_model）：属性里声明的 base_model 等引用 →
  // derivedFrom 断言。解析口径保守：名称精确（大小写不敏感）或别名精确；模糊不自动建边。
  // 建边走既有 createRelationAssertion（domain/range、禁环、重边防护复用）。
  app.post("/assets/:assetId/lineage/materialize", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    await teamRole(auth.userId, body.teamId);
    // 事务内返回纯对象，COMMIT 后再 send（避免响应先于提交刷出，见集合快照同款口径）
    const out = await withTeam(body.teamId, async (client) => {
      const { rows: arows } = await client.query<{ properties: Record<string, unknown> }>(
        `SELECT r.properties FROM assets a
           JOIN LATERAL (SELECT properties FROM asset_revisions
                          WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1) r ON true
          WHERE a.team_id = $1 AND a.id = $2`,
        [body.teamId, assetId]
      );
      if (!arows[0]) throw ERR.NOT_FOUND();
      const refGroups = extractLineageRefs(arows[0].properties);
      if (refGroups.length === 0) {
        throw ERR.INVALID("head 属性未声明血缘字段（base_model / baseModel / base_model_ref / derived_from），无可物化内容");
      }
      const { rows: rt } = await client.query<{ id: string }>(
        `SELECT id FROM relation_type_versions WHERE team_id = $1 AND type_key = 'derivedFrom' ORDER BY created_at DESC LIMIT 1`,
        [body.teamId]
      );
      if (!rt[0]) throw ERR.CONFLICT("RELATION_TYPE_MISSING", "团队没有 derivedFrom 关系类型（默认类型未播种）");
      const results: {
        field: string; ref: string; status: "linked" | "already" | "unresolved" | "self";
        targetId?: string; targetName?: string; message: string;
      }[] = [];
      let created = 0;
      for (const group of refGroups) {
        for (const ref of group.refs) {
          const { rows: byName } = await client.query<{ id: string; name: string }>(
            `SELECT id, name FROM assets WHERE team_id = $1 AND lower(name) = lower($2)`,
            [body.teamId, ref]
          );
          let hit = byName[0];
          let via = "名称";
          if (!hit) {
            const { rows: byAlias } = await client.query<{ id: string; name: string }>(
              `SELECT a.id, a.name FROM asset_aliases al
                 JOIN assets a ON a.team_id = al.team_id AND a.id = al.asset_id
                WHERE al.team_id = $1 AND al.alias = lower($2)`,
              [body.teamId, ref]
            );
            hit = byAlias[0];
            via = "别名";
          }
          if (!hit) {
            results.push({ field: group.field, ref, status: "unresolved", message: "按名称或别名未找到该资产——血缘引用保持文本，登记或改名后可再物化" });
            continue;
          }
          if (hit.id === assetId) {
            results.push({ field: group.field, ref, status: "self", targetId: hit.id, targetName: hit.name, message: "引用指向资产自身，跳过" });
            continue;
          }
          try {
            await createRelationAssertion(
              body.teamId,
              auth.userId,
              {
                relationTypeVersionId: rt[0].id,
                sourceAssetId: assetId,
                targetAssetId: hit.id,
                evidenceNote: `${group.field} 字段物化（${via}命中「${ref}」，M67①）`,
                confirm: true,
              },
              client
            );
            created += 1;
            results.push({ field: group.field, ref, status: "linked", targetId: hit.id, targetName: hit.name, message: `已创建 derivedFrom 断言（${via}命中）` });
          } catch (err) {
            if (err instanceof AppError && err.statusCode === 409 && err.code === "DUPLICATE_ASSERTION") {
              results.push({ field: group.field, ref, status: "already", targetId: hit.id, targetName: hit.name, message: "derivedFrom 断言已存在" });
              continue;
            }
            throw err;
          }
        }
      }
      // 治理动作进团队动态（M68③）：物化了哪些引用、各自结果
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, request_id, detail)
         VALUES ($1,$2,'asset.lineage_materialize','asset',$3,$4,$5)`,
        [body.teamId, auth.userId, assetId, req.id, JSON.stringify({ created, results: results.map((r) => ({ ref: r.ref, status: r.status })) })]
      );
      return { assetId, created, results };
    });
    return reply.code(200).send(out);
  });

  // 标签沿血缘传播（M67③，Atlas 分类传播 + 治理确认流）：GET 预览 + POST 确认执行。
  // 两步之间拓扑可能变化——planDigest 不符 409（同 C08 share-check 的 TOCTOU 口径）。
  app.get("/assets/:assetId/propagate-labels", async (req) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: src } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [teamId, assetId]);
      if (!src[0]) throw ERR.NOT_FOUND();
      const { plan, names, sourceLabels } = await buildPropagationPlan(client, teamId, assetId);
      const planDigest = createHash("sha256").update(stableStringify({ assetId, plan })).digest("hex").slice(0, 16);
      return {
        assetId,
        planDigest,
        sourceLabels,
        relationFamily: "derivedFrom",
        targets: plan.targets.map((t) => ({ assetId: t.assetId, name: names.get(t.assetId) ?? t.assetId, labelsToAdd: t.labelsToAdd })),
        notes: plan.notes,
      };
    });
  });

  app.post("/assets/:assetId/propagate-labels", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), confirmPlanDigest: z.string().min(4).max(32) }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const out = await withTeam(body.teamId, async (client) => {
      const { rows: src } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [body.teamId, assetId]);
      if (!src[0]) throw ERR.NOT_FOUND();
      const { plan } = await buildPropagationPlan(client, body.teamId, assetId);
      const planDigest = createHash("sha256").update(stableStringify({ assetId, plan })).digest("hex").slice(0, 16);
      if (planDigest !== body.confirmPlanDigest) {
        throw ERR.CONFLICT("PROPAGATION_PLAN_CHANGED", "传播计划已过期（预览后血缘或标签发生了变化），请重新预览确认");
      }
      if (plan.targets.length === 0) {
        return { appliedAssets: 0, appliedLabels: 0, notes: plan.notes };
      }
      let appliedLabels = 0;
      for (const t of plan.targets) {
        for (const label of t.labelsToAdd) {
          await client.query(
            `INSERT INTO asset_labels (team_id, asset_id, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [body.teamId, t.assetId, label]
          );
          appliedLabels += 1;
        }
      }
      // 传播改了标签——递增 meta_version，让元数据 ETag 乐观并发能感知（不静默绕过）
      await client.query(`UPDATE assets SET meta_version = meta_version + 1 WHERE team_id = $1 AND id = $2`, [
        body.teamId, assetId,
      ]);
      // 治理动作进团队动态（M68③）
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, request_id, detail)
         VALUES ($1,$2,'asset.labels_propagate','asset',$3,$4,$5)`,
        [body.teamId, auth.userId, assetId, req.id, JSON.stringify({ appliedAssets: plan.targets.length, appliedLabels })]
      );
      return {
        appliedAssets: plan.targets.length,
        appliedLabels,
        notes: [`已把源标签 ${plan.targets.flatMap((t) => t.labelsToAdd).length} 项沿 derivedFrom 下游传播`],
      };
    });
    return reply.code(200).send(out);
  });

  // 分面清单（M53，吸收 CKAN facet 思路）：目录筛选下拉的数据源——
  // 在用 type_key、标签（按使用次数排序）、分类路径。全部真实聚合，无本地猜测。
  app.get("/assets/facets", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: types } = await client.query<{ type_key: string }>(
        `SELECT DISTINCT tv.type_key
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND a.lifecycle <> 'archived'
          ORDER BY 1`,
        [teamId]
      );
      const { rows: labels } = await client.query<{ label: string; count: number }>(
        `SELECT label, COUNT(*)::int AS count FROM asset_labels WHERE team_id = $1 GROUP BY label ORDER BY count DESC, label LIMIT 50`,
        [teamId]
      );
      const { rows: cats } = await client.query<{ category_path: string }>(
        `SELECT DISTINCT category_path FROM asset_categories WHERE team_id = $1 ORDER BY 1 LIMIT 200`,
        [teamId]
      );
      return {
        typeKeys: types.map((r) => r.type_key),
        labels: labels.map((r) => ({ label: r.label, count: r.count })),
        categories: cats.map((r) => r.category_path),
      };
    });
  });

  // ---------- 使用度事件与别名（M55，npm/HF 使用度信号 + MLflow alias 思想） ----------
  // 引用复制事件：界面「复制引用」按钮上报（下载与 Agent 读取由服务端埋点，不经此端点）
  app.post("/assets/:assetId/usage", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const body = parseBody(z.object({ teamId: z.string().uuid(), kind: z.literal("copy_ref") }), req.body);
    await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [body.teamId, assetId]);
      if (!rows[0]) throw ERR.NOT_FOUND();
      await client.query(
        `INSERT INTO usage_events (team_id, asset_id, kind, actor_id) VALUES ($1,$2,'copy_ref',$3)`,
        [body.teamId, assetId, auth.userId]
      );
    });
    return reply.code(201).send({ ok: true });
  });

  const ALIAS_RE = /^[a-z0-9][a-z0-9._@-]{1,63}$/;

  async function requireAssetManagePermission(
    teamId: string,
    assetId: string,
    userId: string,
    role: string
  ): Promise<void> {
    const { rows } = await withTeam(teamId, async (client) =>
      client.query<{ created_by: string }>(
        `SELECT created_by FROM assets WHERE team_id = $1 AND id = $2`,
        [teamId, assetId]
      )
    );
    if (!rows[0]) throw ERR.NOT_FOUND();
    if (rows[0].created_by !== userId && role !== "admin") throw ERR.FORBIDDEN();
  }

  // 引用导出（M66④，Zenodo「Cite」/ GitHub「Cite this repository」锚点）：
  // BibTeX/Markdown 标准格式供 LaTeX 与文献管理器；owner 取惯例键（与完整度
  // 检查同一 OWNER_KEYS 口径）；只读端点，复制计热度由 UI 上报 copy_ref。
  app.get("/assets/:assetId/cite", async (req, reply) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const query = (req.query ?? {}) as { teamId?: string; format?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const format = query.format === "markdown" ? "markdown" : "bibtex";
    await teamRole(auth.userId, teamId);
    const { rows } = await withTeam(teamId, async (client) =>
      client.query<{
        name: string; type_key: string; type_version: string;
        properties: Record<string, unknown>; created_at: Date; aliases: string[] | null;
      }>(
        `SELECT a.name, tv.type_key, tv.version AS type_version, r.properties, a.created_at,
                ARRAY(SELECT al.alias FROM asset_aliases al WHERE al.team_id = a.team_id AND al.asset_id = a.id ORDER BY al.alias) AS aliases
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN LATERAL (
             SELECT properties FROM asset_revisions
              WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1
           ) r ON true
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, assetId]
      )
    );
    const row = rows[0];
    if (!row) throw ERR.NOT_FOUND();
    const owner = OWNER_KEYS.map((k) => row.properties?.[k]).find(
      (v): v is string => typeof v === "string" && v.trim() !== ""
    );
    const cite = buildCitation(
      {
        assetId, name: row.name, typeKey: row.type_key, typeVersion: row.type_version,
        owner, aliases: row.aliases ?? [],
        year: new Date(row.created_at).getFullYear(),
      },
      format
    );
    return reply.header("content-type", cite.contentType).send(cite.text);
  });

  app.post("/assets/:assetId/aliases", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const body = parseBody(z.object({ teamId: z.string().uuid(), alias: z.string().min(2).max(64) }), req.body);
    const role = await teamRole(auth.userId, body.teamId);
    await requireAssetManagePermission(body.teamId, assetId, auth.userId, role);
    const alias = body.alias.trim().toLowerCase();
    if (!ALIAS_RE.test(alias)) {
      throw ERR.INVALID("别名格式：小写字母/数字开头，仅含小写字母、数字、点、下划线、@、连字符，2–64 位");
    }
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [body.teamId, assetId]);
      if (!rows[0]) throw ERR.NOT_FOUND();
      try {
        await client.query(
          `INSERT INTO asset_aliases (team_id, alias, asset_id, created_by) VALUES ($1,$2,$3,$4)`,
          [body.teamId, alias, assetId, auth.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw ERR.CONFLICT("ALIAS_TAKEN", `别名「${alias}」已被本团队其他资产占用`);
        }
        if ((err as { code?: string }).code === "23514") {
          throw ERR.INVALID("别名格式非法");
        }
        throw err;
      }
    });
    return reply.code(201).send({ teamId: body.teamId, assetId, alias });
  });

  app.delete("/assets/:assetId/aliases/:alias", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId, alias } = req.params as { assetId: string; alias: string };
    if (!/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const role = await teamRole(auth.userId, teamId);
    await requireAssetManagePermission(teamId, assetId, auth.userId, role);
    const { rowCount } = await withTeam(teamId, async (client) =>
      client.query(`DELETE FROM asset_aliases WHERE team_id = $1 AND asset_id = $2 AND alias = $3`, [teamId, assetId, alias])
    );
    if (!rowCount) throw ERR.NOT_FOUND();
    return reply.code(200).send({ ok: true });
  });

  // 别名解析（MLflow @alias 思想）：稳定命名引用 → 资产；跨团队 RLS 隔离（他团队别名 404）
  app.get("/assets/by-alias/:alias", async (req) => {
    const auth = requireAuth(req);
    const { alias } = req.params as { alias: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query<{ id: string; name: string; type_key: string; type_version: string }>(
        `SELECT a.id, a.name, tv.type_key, tv.version AS type_version
           FROM asset_aliases al
           JOIN assets a ON a.team_id = al.team_id AND a.id = al.asset_id
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE al.team_id = $1 AND al.alias = $2`,
        [teamId, alias.toLowerCase()]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      return { teamId, alias: alias.toLowerCase(), assetId: rows[0].id, name: rows[0].name, typeKey: rows[0].type_key, typeVersion: rows[0].type_version };
    });
  });

  // 使用片段（M57）：按类型家族生成引用/调用片段（HF/Terraform 思想）。
  // 构建器是 @taw/domain 纯函数——端点与单测同源；数据全部来自真实登记，不编造。
  app.get("/assets/:assetId/snippets", async (req) => {
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const teamId = String(((req.query ?? {}) as { teamId?: string }).teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT a.id, a.name, tv.type_key, tv.version AS type_version
           FROM assets a JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE a.team_id = $1 AND a.id = $2`,
        [teamId, assetId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const { rows: aliases } = await client.query<{ alias: string }>(
        `SELECT alias FROM asset_aliases WHERE team_id = $1 AND asset_id = $2 ORDER BY created_at`,
        [teamId, assetId]
      );
      const { rows: head } = await client.query<{ properties: Record<string, unknown>; content_digest: string }>(
        `SELECT properties, content_digest FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT 1`,
        [teamId, assetId]
      );
      const snippets = buildSnippets({
        id: rows[0].id as string,
        name: rows[0].name as string,
        typeKey: rows[0].type_key as string,
        typeVersion: rows[0].type_version as string,
        aliases: aliases.map((a) => a.alias),
        properties: head[0]?.properties ?? null,
        contentDigest: head[0]?.content_digest ?? null,
      });
      return { assetId, snippets };
    });
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
      // 制品随修订返回（M53 随取随用）：界面详情页直接提供当前修订制品下载
      const { rows: arts } = await client.query<{
        revision_id: string; blob_digest: string; artifact_role: string; original_name: string; media_type: string; size: number;
      }>(
        `SELECT ra.revision_id, ra.blob_digest, ra.artifact_role, ra.original_name, ra.media_type, ra.size::int AS size
           FROM revision_artifacts ra
           JOIN asset_revisions r ON r.team_id = ra.team_id AND r.id = ra.revision_id
          WHERE ra.team_id = $1 AND r.asset_id = $2`,
        [teamId, assetId]
      );
      const artsByRev = new Map<string, typeof arts>();
      for (const a of arts) {
        const list = artsByRev.get(a.revision_id) ?? [];
        list.push(a);
        artsByRev.set(a.revision_id, list);
      }
      const revisionsWithArts = revisions.map((r: Record<string, unknown>) => ({
        ...r,
        artifacts: artsByRev.get(r.id as string) ?? [],
      }));
      const { rows: labels } = await client.query<{ label: string }>(
        `SELECT label FROM asset_labels WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      const { rows: categories } = await client.query<{ category_path: string; is_primary: boolean }>(
        `SELECT category_path, is_primary FROM asset_categories WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetId]
      );
      // 别名与使用热度（M55）：详情页展示与「随取随用」计数的真实聚合
      const { rows: aliasRows } = await client.query<{ alias: string }>(
        `SELECT alias FROM asset_aliases WHERE team_id = $1 AND asset_id = $2 ORDER BY alias`,
        [teamId, assetId]
      );
      const { rows: usageRows } = await client.query<{ kind: string; n: number }>(
        `SELECT kind, count(*)::int AS n FROM usage_events
          WHERE team_id = $1 AND asset_id = $2 AND created_at > now() - interval '90 days'
          GROUP BY kind`,
        [teamId, assetId]
      );
      const usage = { download: 0, copy_ref: 0, agent_read: 0 };
      for (const r of usageRows) if (r.kind in usage) usage[r.kind as keyof typeof usage] = r.n;
      // 完整度 scorecard（M65，Backstage TechInsights 思想）：读侧派生，不新增登记门槛。
      // required 字段与登记表单同一合并语义（schemaToFormSpec 的链并集），不可能分叉。
      const { rows: relCountRows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM relation_assertions
          WHERE team_id = $1 AND status = 'confirmed' AND (source_asset_id = $2 OR target_asset_id = $2)`,
        [teamId, assetId]
      );
      const chain = await loadTypeChain(client, teamId, asset.type_version_id);
      const requiredFields = schemaToFormSpec(
        chain.map((d) => ({ typeKey: d.type_key, version: d.version, jsonSchema: d.json_schema, unitVocabularies: d.unit_vocabularies }))
      ).fields.filter((f) => f.required).map((f) => f.key);
      const head = revisionsWithArts[0] as { properties?: Record<string, unknown>; artifacts?: unknown[] } | undefined;
      const completeness = computeCompleteness({
        requiredFields,
        properties: head?.properties ?? {},
        artifactsCount: head?.artifacts?.length ?? 0,
        relationsCount: relCountRows[0]?.n ?? 0,
        aliasesCount: aliasRows.length,
        labelsCount: labels.length,
        categoriesCount: categories.length,
      });
      return {
        ...asset,
        revisions: revisionsWithArts,
        revisionsTotal: total[0]!.n,
        labels: labels.map((l) => l.label),
        categories,
        aliases: aliasRows.map((r) => r.alias),
        usage,
        completeness,
        // 派生血缘字段提示（M67①，HF base_model）：head 属性里声明的血缘引用——
        // 展示为可物化提示，不自动建边（物化走 POST /assets/:id/lineage/materialize）
        lineageRefs: extractLineageRefs(head?.properties ?? {}),
      };
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
        `SELECT blob_digest, artifact_role, original_name, media_type, size::int AS size FROM revision_artifacts
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
      // 图投影脏标记（M49）：lifecycle 变更
      await markGraphDirty(client, body.teamId);
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
      // 图投影脏标记（M49）：lifecycle 变更
      await markGraphDirty(client, body.teamId);
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
    const result = await createRelationAssertion(body.teamId, auth.userId, body);
    return reply.code(201).send({ teamId: body.teamId, relationId: result.relationId, status: result.status });
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
                sa.name AS source_name, ta.name AS target_name,
                sa.lifecycle AS source_lifecycle, ta.lifecycle AS target_lifecycle
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
                ra.source_asset_id, ra.target_asset_id,
                sa.lifecycle AS source_lifecycle, ta.lifecycle AS target_lifecycle
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

  // 撤回关系断言（实测走查发现：schema 预留 withdrawn 状态但全工程无任何撤回路径，
  // 误建的关系无法移除，防重报错"请先撤回"也无路可走）。角色口径与资产归档一致：
  // 团队管理员或断言提议人；撤回是可见动作，如实盖章审计。
  app.post("/relations/:relationId/withdraw", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { relationId } = req.params as { relationId: string };
    if (!/^[0-9a-f-]{36}$/.test(relationId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), reason: z.string().min(4).max(500) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ id: string; status: string; proposed_by: string; type_key: string; source_name: string; target_name: string }>(
        `SELECT ra.id, ra.status, ra.proposed_by, rt.type_key,
                sa.name AS source_name, ta.name AS target_name
           FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
          WHERE ra.team_id = $1 AND ra.id = $2`,
        [body.teamId, relationId]
      );
      const rel = rows[0];
      if (!rel) throw ERR.NOT_FOUND();
      if (rel.status === "withdrawn") {
        throw ERR.CONFLICT("ALREADY_WITHDRAWN", "关系断言已处于撤回状态");
      }
      if (role !== "admin" && rel.proposed_by !== auth.userId) {
        throw ERR.FORBIDDEN();
      }
      await client.query(
        `UPDATE relation_assertions SET status = 'withdrawn', withdrawn_reason = $3
          WHERE team_id = $1 AND id = $2`,
        [body.teamId, relationId, body.reason]
      );
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, detail)
         VALUES ($1, $2, 'relation.withdraw', 'relation', $3, $4)`,
        [body.teamId, auth.userId, relationId,
         JSON.stringify({ reason: body.reason, relationType: rel.type_key,
           source: rel.source_name, target: rel.target_name })]
      );
      // 图投影脏标记（M49）：存活边移除
      await markGraphDirty(client, body.teamId);
    });
    return reply.code(200).send({ teamId: body.teamId, relationId, status: "withdrawn" });
  });
}
