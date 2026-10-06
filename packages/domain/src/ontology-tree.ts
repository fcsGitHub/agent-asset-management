// 本体树构建（M71，Palantir Foundry Ontology Manager / Atlas 类型系统 / Wikidata 类层次锚点）：
// 把「每个 type_key 的最新 active 版本」平铺行集组织成层次树，并计算每个节点的子类闭包与
// 闭包资产计数（闭包计数 = 选该类型做目录过滤时真实会命中的资产数——与 queryAssetRows
// 的类闭包展开同一语义）。纯函数无 IO，供 API 端点与 Agent 工具同源调用。
//
// 诚实边界：parentKey 指向的键不在行集里（父版本已停用/链断裂）时，该节点升为根并带
// danglingParentKey 如实标注，不静默丢弃；环防御同 loadTypeChain 口径（注册侧已保证
// 不成环，此处兜底——环上节点按根处理并标 cyclic）。

export interface OntologyTypeRow {
  key: string;
  title: string;
  version: string;
  parentKey: string | null;
  assetCount: number;
  propertyKeys: string[];
  requiredKeys: string[];
  requiresTestEvidence: boolean;
}

export interface OntologyTypeNode extends OntologyTypeRow {
  /** 直接与全部后代子类键（排序稳定，供闭包检索展示） */
  subclassKeys: string[];
  /** 自身 + 全部后代子类的资产计数合计（目录闭包过滤的真实命中数） */
  closureAssetCount: number;
  danglingParentKey?: string;
  cyclic?: boolean;
  children: OntologyTypeNode[];
}

export interface OntologyRelationRow {
  key: string;
  title: string;
  sourceTypeKeys: string[];
  targetTypeKeys: string[];
  assertionCount: number;
}

export interface ApplicableRelation {
  key: string;
  title: string;
  asSource: boolean;
  asTarget: boolean;
  assertionCount: number;
}

/** 层次树构建：入参为平铺类型行（每键一行，父引用按 key）；返回根节点数组。 */
export function buildOntologyTree(rows: OntologyTypeRow[]): OntologyTypeNode[] {
  const nodes = new Map<string, OntologyTypeNode>();
  for (const r of rows) {
    nodes.set(r.key, { ...r, subclassKeys: [], closureAssetCount: r.assetCount, children: [] });
  }
  const roots: OntologyTypeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentKey ? nodes.get(node.parentKey) : undefined;
    if (parent && parent !== node && !wouldCycle(nodes, parent, node.key)) {
      parent.children.push(node);
    } else {
      if (node.parentKey && !parent) node.danglingParentKey = node.parentKey;
      if (parent === node) node.cyclic = true;
      roots.push(node);
    }
  }
  for (const list of [roots, ...roots.map((r) => descendants(r))]) {
    for (const n of list) {
      n.children.sort((a, b) => a.key.localeCompare(b.key));
    }
  }
  for (const root of roots) fillClosure(root);
  roots.sort((a, b) => a.key.localeCompare(b.key));
  return roots;
}

/** 深度优先展平（Agent 工具与 UI 下拉共用形状：depth + parentKey 便于还原层次）。 */
export interface FlatOntologyNode extends OntologyTypeNode {
  depth: number;
}

export function flattenOntologyTree(roots: OntologyTypeNode[]): FlatOntologyNode[] {
  const out: FlatOntologyNode[] = [];
  const walk = (node: OntologyTypeNode, depth: number) => {
    out.push({ ...node, depth, children: [] });
    for (const c of node.children) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** 类型闭包可挂的关系（Atlas domain/range 口径）：typeKeys 为空 = 对该侧任意类型开放
 *  （kind 层约束）；非空 = 与闭包有交集才适用。asSource/asTarget 分别标注适用侧。 */
export function relationsForClosure(
  closureKeys: string[],
  relations: OntologyRelationRow[]
): ApplicableRelation[] {
  const set = new Set(closureKeys);
  const out: ApplicableRelation[] = [];
  for (const r of relations) {
    const asSource = r.sourceTypeKeys.length === 0 || r.sourceTypeKeys.some((k) => set.has(k));
    const asTarget = r.targetTypeKeys.length === 0 || r.targetTypeKeys.some((k) => set.has(k));
    if (asSource || asTarget) {
      out.push({ key: r.key, title: r.title, asSource, asTarget, assertionCount: r.assertionCount });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

function descendants(node: OntologyTypeNode): OntologyTypeNode[] {
  const out: OntologyTypeNode[] = [];
  for (const c of node.children) {
    out.push(c, ...descendants(c));
  }
  return out;
}

function fillClosure(node: OntologyTypeNode): { keys: string[]; count: number } {
  const keys = [node.key];
  let count = node.assetCount;
  for (const c of node.children) {
    const sub = fillClosure(c);
    keys.push(...sub.keys);
    count += sub.count;
  }
  node.subclassKeys = keys.slice(1).sort((a, b) => a.localeCompare(b));
  node.closureAssetCount = count;
  return { keys, count };
}

/** parent 的祖先链里若已含 childKey 则挂上去会成环——防御性兜底（注册侧已保证）。 */
function wouldCycle(nodes: Map<string, OntologyTypeNode>, parent: OntologyTypeNode, childKey: string): boolean {
  let cursor: OntologyTypeNode | undefined = parent;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor.key === childKey) return true;
    if (seen.has(cursor.key)) return true;
    seen.add(cursor.key);
    cursor = cursor.parentKey ? nodes.get(cursor.parentKey) : undefined;
  }
  return false;
}
