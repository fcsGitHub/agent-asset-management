// 派生血缘字段（M67①，HF model card base_model 思想）+ 标签沿血缘传播规划（M67③，Atlas 思想）。
// 纯函数：提取/规划不含 IO——解析与建边/落库在 API 层，走既有 createRelationAssertion。

/** 约定的血缘字段名（HF 生态 kebab-case + 团队常见 camelCase 变体）。 */
export const LINEAGE_FIELDS = ["base_model", "baseModel", "base_model_ref", "derived_from"] as const;

export interface LineageRef { field: string; refs: string[] }

/** 从属性中提取血缘引用：值为 string 或 string[]（其余类型跳过）；去空去重保序。 */
export function extractLineageRefs(
  properties: Record<string, unknown>,
  fields: readonly string[] = LINEAGE_FIELDS
): LineageRef[] {
  const out: LineageRef[] = [];
  for (const field of fields) {
    const raw = properties[field];
    const values = Array.isArray(raw) ? raw : [raw];
    const refs: string[] = [];
    for (const v of values) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t && !refs.includes(t)) refs.push(t);
    }
    if (refs.length > 0) out.push({ field, refs });
  }
  return out;
}

export interface PropagationTarget { assetId: string; labelsToAdd: string[] }
export interface PropagationPlan {
  /** 下游资产（按 BFS 层序）与各自将新增的标签（源标签 − 已有标签）。 */
  targets: PropagationTarget[];
  /** 如实注记：无下游/已全部具备/源无标签等边界，界面原样展示。 */
  notes: string[];
}

/**
 * 规划「源资产当前标签 → 沿血缘边（from=源 to=派生）向下游传播」：
 * - 保守语义：只传播源自身的标签；中间节点自己加的标签不再级联（Atlas 自动级联
 *   在协作场景易错难撤，我们取显式两步确认 + 单源语义）。
 * - 环安全（visited）；源自身不进 targets；已具备全部目标标签的下游不产生条目。
 */
export function planLabelPropagation(opts: {
  sourceId: string;
  /** 血缘边（调用方已按关系族取好，如 derivedFrom 断言）。 */
  edges: { from: string; to: string }[];
  /** 各资产现有标签（至少含源与全部可达下游；缺省按无标签处理）。 */
  labelsByAsset: Record<string, string[]>;
}): PropagationPlan {
  const { sourceId, edges, labelsByAsset } = opts;
  const sourceLabels = (labelsByAsset[sourceId] ?? []).filter((l) => l.trim() !== "");
  const notes: string[] = [];
  if (sourceLabels.length === 0) {
    return { targets: [], notes: ["源资产当前没有任何标签，无可传播内容"] };
  }
  // BFS 沿边向下，环安全
  const byFrom = new Map<string, string[]>();
  for (const e of edges) {
    const list = byFrom.get(e.from) ?? [];
    list.push(e.to);
    byFrom.set(e.from, list);
  }
  const visited = new Set<string>([sourceId]);
  const order: string[] = [];
  let frontier = [sourceId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const to of byFrom.get(cur) ?? []) {
        if (visited.has(to)) continue;
        visited.add(to);
        order.push(to);
        next.push(to);
      }
    }
    frontier = next;
  }
  if (order.length === 0) {
    return { targets: [], notes: ["沿血缘边（derivedFrom）没有下游资产，无可传播对象"] };
  }
  const targets: PropagationTarget[] = [];
  const fullyCovered: string[] = [];
  for (const assetId of order) {
    const existing = new Set(labelsByAsset[assetId] ?? []);
    const toAdd = sourceLabels.filter((l) => !existing.has(l));
    if (toAdd.length === 0) fullyCovered.push(assetId);
    else targets.push({ assetId, labelsToAdd: toAdd });
  }
  if (fullyCovered.length > 0) {
    notes.push(`${fullyCovered.length} 个下游资产已具备全部源标签，无需变更`);
  }
  return { targets, notes };
}
