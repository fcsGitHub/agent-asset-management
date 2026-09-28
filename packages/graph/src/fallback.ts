// 类闭包解析的共享回落逻辑（M49 API 路由与 M50 Agent 工具同源）：
// 图引擎优先；图中无该类节点（投影未含）或图库不可达时回落 SQL 递归 CTE，
// engine 字段如实标注，不虚构"图中无子类"。
import { GraphUnavailableError, typeClosureKeys } from "./queries.js";
import type { PgExec } from "./projection.js";

/** SQL 闭包：版本级递归 + type_key 去重（RLS 上下文由 exec 决定）。 */
export async function sqlTypeClosure(exec: PgExec, teamId: string, typeKey: string): Promise<string[]> {
  const { rows } = await exec(
    `WITH RECURSIVE tree AS (
       SELECT id, type_key FROM asset_type_versions
        WHERE team_id = $1 AND type_key = $2 AND status = 'active'
       UNION
       SELECT c.id, c.type_key FROM asset_type_versions c
        JOIN tree t ON c.team_id = $1 AND c.parent_type_version_id = t.id
     ) SELECT DISTINCT type_key FROM tree`,
    [teamId, typeKey]
  );
  return rows.map((r) => r.type_key as string);
}

export interface ClosureResolution {
  engine: "graph" | "sql-fallback";
  keys: string[];
}

/** 图引擎优先的类闭包解析：图不可达/类不在投影中时回落 SQL，engine 如实标注。 */
export async function resolveTypeClosure(exec: PgExec, teamId: string, typeKey: string): Promise<ClosureResolution> {
  try {
    const keys = await typeClosureKeys(teamId, typeKey);
    if (keys) return { engine: "graph", keys };
  } catch (err) {
    if (!(err instanceof GraphUnavailableError)) throw err;
  }
  return { engine: "sql-fallback", keys: await sqlTypeClosure(exec, teamId, typeKey) };
}
