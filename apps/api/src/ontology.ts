// 类型定义链装载与属性校验——入库与更新的共同关卡（M59）。
// 调研吸收：OpenMetadata「实体定义即数据契约，后端对一切写入按 schema 校验」：
// 登记与分支草稿保存共用同一实现，规则不可能分叉。
import type { PoolClient } from "pg";
import { ERR } from "./errors.js";
import { validateProperties } from "@taw/domain/validate";

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
