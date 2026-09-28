// 工具调用中的资产引用提取（M41）：从工具参数与结果中解析可跳转的资产 id，
// 供工具卡渲染「相关资产」chips。纯函数，不依赖 React；解析不出就如实为空。

export interface ToolAssetRef { id: string; name?: string }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REFS = 6;

function pushRef(refs: ToolAssetRef[], seen: Set<string>, id: unknown, name?: unknown): void {
  if (typeof id !== "string" || !UUID_RE.test(id) || seen.has(id)) return;
  if (refs.length >= MAX_REFS) return;
  seen.add(id);
  refs.push({ id, name: typeof name === "string" && name ? name : undefined });
}

/** 从工具参数提取：assetId / asset_id 字段（asset.getRevision、relation.query 等）。 */
function fromArgs(args: unknown, refs: ToolAssetRef[], seen: Set<string>): void {
  if (typeof args !== "object" || args === null) return;
  const a = args as Record<string, unknown>;
  pushRef(refs, seen, a.assetId ?? a.asset_id, a.assetName ?? a.asset_name);
}

/** 资产条目数组扫描（M50 泛化）：命中项须带 name 且带 type_key/head_revision_id 形态——
 *  id 是资产 id 才可作为跳转目标（修订 id 等一律不取）。 */
function scanAssetItems(list: unknown[], refs: ToolAssetRef[], seen: Set<string>): void {
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name === "string" && ("type_key" in o || "head_revision_id" in o)) {
      pushRef(refs, seen, o.id, o.name);
    }
  }
}

/** 从工具结果提取：数组取每项 {id,name}（asset.search 命中列表）；
 *  对象取自身 {id,name}（单资产/修订读取结果不映射——修订 id 不是资产 id，
 *  仅当对象带 asset_id/assetId 字段时才取）；对象带 assets 数组时扫描之
 *  （graph.assetsByType 检索结果的「相关资产」chips，M50）。 */
function fromResult(result: unknown, refs: ToolAssetRef[], seen: Set<string>): void {
  if (Array.isArray(result)) {
    scanAssetItems(result, refs, seen);
    return;
  }
  if (typeof result === "object" && result !== null) {
    const o = result as Record<string, unknown>;
    pushRef(refs, seen, o.assetId ?? o.asset_id, o.assetName ?? o.asset_name);
    if (Array.isArray(o.assets)) scanAssetItems(o.assets, refs, seen);
  }
}

/** 一个工具调用的全部可跳转资产引用（去重、上限 6）。 */
export function toolAssetRefs(tool: { name: string; args: unknown; result?: unknown }): ToolAssetRef[] {
  const refs: ToolAssetRef[] = [];
  const seen = new Set<string>();
  fromArgs(tool.args, refs, seen);
  fromResult(tool.result, refs, seen);
  return refs;
}
