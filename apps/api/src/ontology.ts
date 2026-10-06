// 类型定义链装载与属性校验——入库与更新的共同关卡（M59）。
// 调研吸收：OpenMetadata「实体定义即数据契约，后端对一切写入按 schema 校验」：
// 登记与分支草稿保存共用同一实现，规则不可能分叉。
// M71 起：类闭包解析（typeKeyClosure）与本体树装载（loadOntologyTree）——目录搜索、
// /ontology/tree 端点、Agent 本体工具三处同源（Foundry Ontology 单一语义层锚点：
// 同一闭包语义不可能在人类目录与 Agent 工具间分叉）。
import type { PoolClient } from "pg";
import { ERR } from "./errors.js";
import { validateProperties } from "@taw/domain/validate";
import {
  buildOntologyTree,
  relationsForClosure,
  type OntologyRelationRow,
  type OntologyTypeNode,
  type OntologyTypeRow,
} from "@taw/domain/ontology-tree";

export const TYPE_CHAIN_MAX_DEPTH = 16;

export type TypeDefRow = {
  id: string;
  type_key: string;
  version: string;
  title: string;
  json_schema: object;
  unit_vocabularies: Record<string, string[]>;
  parent_type_version_id: string | null;
  status?: string;
  requires_test_evidence?: boolean;
};

/**
 * 载入类型定义链（子 → 父 → … → 根）。注册时父引用必须已存在且边指向已有定义，
 * 因此链不可能成环；深度上限是防御性兜底（M8 本体层次）。
 */
export async function loadTypeChain(client: PoolClient, teamId: string, typeVersionId: string): Promise<TypeDefRow[]> {
  const chain: TypeDefRow[] = [];
  let cursor: string | null = typeVersionId;
  const seen = new Set<string>();
  while (cursor) {
    if (chain.length > TYPE_CHAIN_MAX_DEPTH || seen.has(cursor)) {
      throw ERR.CONFLICT("TYPE_HIERARCHY_CORRUPT", "类型层次异常：链过深或成环，联系管理员检查数据");
    }
    seen.add(cursor);
    const result: { rows: TypeDefRow[] } = await client.query<TypeDefRow>(
      `SELECT id, type_key, version, title, json_schema, unit_vocabularies, parent_type_version_id, requires_test_evidence
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

/**
 * 属性对类型链全量校验：子类型资产必须同时满足链上全部祖先定义。
 * 错误逐条带 [typeKey vN] 前缀（链长 >1 时），与登记报错同源同格式。
 */
export function validateAgainstChain(chain: TypeDefRow[], properties: Record<string, unknown>): void {
  const allErrors: string[] = [];
  for (const def of chain) {
    const check = validateProperties(
      { jsonSchema: def.json_schema, unitVocabularies: def.unit_vocabularies },
      properties
    );
    if (!check.valid) {
      allErrors.push(
        ...check.errors.map((e) => (chain.length > 1 ? `[${def.type_key} v${def.version}] ${e}` : e))
      );
    }
  }
  if (allErrors.length > 0) throw ERR.INVALID("属性不满足类型约束", allErrors);
}

/**
 * type_key 级类闭包（M71，Wikidata P279* / Foundry Interfaces 锚点）：自身 + 全部后代
 * 子类的键集。版本感知——起点与子版本均须 status='active'（停用版本不再出现在当前
 * 本体视图里）。与 @taw/graph 的 SQL 回落闭包同一语义（fallback.sqlTypeClosure）。
 * 未知 typeKey 返回空数组（调用方据此如实返回空结果，不静默放宽为不过滤）。
 */
export async function typeKeyClosure(client: PoolClient, teamId: string, typeKey: string): Promise<string[]> {
  const { rows } = await client.query<{ type_key: string }>(
    `WITH RECURSIVE tree AS (
       SELECT v.id, v.type_key FROM asset_type_versions v
        WHERE v.team_id = $1 AND v.type_key = $2 AND v.status = 'active'
       UNION
       SELECT c.id, c.type_key FROM asset_type_versions c
        JOIN tree t ON c.team_id = $1 AND c.parent_type_version_id = t.id
       WHERE c.team_id = $1 AND c.status = 'active'
     ) SELECT DISTINCT type_key FROM tree ORDER BY type_key`,
    [teamId, typeKey]
  );
  return rows.map((r) => r.type_key);
}

export interface LoadedOntology {
  tree: OntologyTypeNode[];
  relations: OntologyRelationRow[];
}

/**
 * 本体树数据装载（M71）：每个 type_key 取最新 active 版本（父引用按版本边还原为父键）、
  * 非归档资产计数、模式声明属性键/必填键；关系注册表取每键最新版本的 domain/range 与
 * 非撤回断言数。树构建走 @taw/domain 纯函数。/ontology/tree 端点与 Agent 本体工具共用。
 */
export async function loadOntology(client: PoolClient, teamId: string): Promise<LoadedOntology> {
  const { rows: typeRows } = await client.query<{
    type_key: string;
    version: string;
    title: string;
    json_schema: { required?: string[]; properties?: Record<string, unknown> } | null;
    parent_key: string | null;
    requires_test_evidence: boolean;
    n: number;
  }>(
    `SELECT DISTINCT ON (v.type_key)
            v.type_key, v.version, v.title, v.json_schema, v.requires_test_evidence,
            p.type_key AS parent_key, COALESCE(cnt.n, 0)::int AS n
       FROM asset_type_versions v
       LEFT JOIN asset_type_versions p ON p.team_id = v.team_id AND p.id = v.parent_type_version_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM assets a
          WHERE a.team_id = v.team_id AND a.current_type_version_id IN (
            SELECT id FROM asset_type_versions x
             WHERE x.team_id = v.team_id AND x.type_key = v.type_key
          ) AND a.lifecycle <> 'archived'
       ) cnt ON true
      WHERE v.team_id = $1 AND v.status = 'active'
      ORDER BY v.type_key, v.created_at DESC`,
    [teamId]
  );
  const rows: OntologyTypeRow[] = typeRows.map((r) => ({
    key: r.type_key,
    title: r.title,
    version: r.version,
    parentKey: r.parent_key,
    assetCount: Number(r.n ?? 0),
    propertyKeys: Object.keys(r.json_schema?.properties ?? {}).sort(),
    requiredKeys: (r.json_schema?.required ?? []).slice().sort(),
    requiresTestEvidence: Boolean(r.requires_test_evidence),
  }));
  const { rows: relRows } = await client.query<{
    type_key: string;
    title: string;
    source_type_keys: string[] | null;
    target_type_keys: string[] | null;
    n: number;
  }>(
    `SELECT DISTINCT ON (rt.type_key)
            rt.type_key, rt.title, rt.source_type_keys, rt.target_type_keys, COALESCE(cnt.n, 0)::int AS n
       FROM relation_type_versions rt
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM relation_assertions ra
          WHERE ra.team_id = rt.team_id
            AND ra.relation_type_version_id IN (
              SELECT id FROM relation_type_versions x WHERE x.team_id = rt.team_id AND x.type_key = rt.type_key
            ) AND ra.status <> 'withdrawn'
       ) cnt ON true
      WHERE rt.team_id = $1
      ORDER BY rt.type_key, rt.created_at DESC`,
    [teamId]
  );
  const relations: OntologyRelationRow[] = relRows.map((r) => ({
    key: r.type_key,
    title: r.title,
    sourceTypeKeys: r.source_type_keys ?? [],
    targetTypeKeys: r.target_type_keys ?? [],
    assertionCount: Number(r.n ?? 0),
  }));
  return { tree: buildOntologyTree(rows), relations };
}

/** 某类型的适用关系（闭包口径）——ontology.typeInfo 工具与端点共用小助手。 */
export function applicableRelationsFor(closureKeys: string[], relations: OntologyRelationRow[]) {
  return relationsForClosure(closureKeys, relations);
}
