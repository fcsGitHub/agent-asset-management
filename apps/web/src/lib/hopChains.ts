// 多跳关联链条构建（M52）：在 graph.neighbors 返回的子图边上做 BFS，
// 为每个可达资产生成从种子资产出发的最短关联链（每步带关系键与方向）。
// 纯函数，不依赖 React 与网络；种子自身不产出链条。

export interface HopEdge { source: string; target: string; relKey: string }

/** 一步：走到 assetId；forward = 该步沿边的真实方向前进（否则为逆向走边）。 */
export interface HopStep {
  assetId: string;
  relKey: string;
  forward: boolean;
}

export interface HopChain {
  assetId: string;
  hops: number;
  steps: HopStep[];
}

export function buildHopChains(
  seedId: string,
  edges: HopEdge[]
): Map<string, HopChain> {
  const adjacency = new Map<string, { to: string; relKey: string; forward: boolean }[]>();
  for (const e of edges) {
    if (!adjacency.has(e.source)) adjacency.set(e.source, []);
    adjacency.get(e.source)!.push({ to: e.target, relKey: e.relKey, forward: true });
    if (!adjacency.has(e.target)) adjacency.set(e.target, []);
    adjacency.get(e.target)!.push({ to: e.source, relKey: e.relKey, forward: false });
  }

  const chains = new Map<string, HopChain>();
  const visited = new Set<string>([seedId]);
  let frontier: { id: string; steps: HopStep[] }[] = [{ id: seedId, steps: [] }];
  let hops = 0;
  while (frontier.length > 0) {
    hops += 1;
    const next: { id: string; steps: HopStep[] }[] = [];
    for (const cur of frontier) {
      for (const step of adjacency.get(cur.id) ?? []) {
        if (visited.has(step.to)) continue;
        visited.add(step.to);
        const steps = [...cur.steps, { assetId: step.to, relKey: step.relKey, forward: step.forward }];
        chains.set(step.to, { assetId: step.to, hops, steps });
        next.push({ id: step.to, steps });
      }
    }
    frontier = next;
  }
  return chains;
}

/** 链条的一行紧凑描述所需的数据：途经节点 id 序列（含种子与终点）与每步关系键/方向。 */
export function chainNodes(seedId: string, chain: HopChain): string[] {
  return [seedId, ...chain.steps.map((s) => s.assetId)];
}
