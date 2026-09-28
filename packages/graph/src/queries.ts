// 图库检索查询：类闭包、多跳邻域、最短路径、计数对账。
// 方言注记（Memgraph 2.19 实测）：
// - 变长路径可用，但不做关系唯一性剪枝——无界深度在环图上组合爆炸（实测 7GiB 分配）。
//   因此邻域硬限深 ≤3 并对结果 LIMIT；最短路径不走图库变长路径，
//   而是线性拉取团队边集后在应用层 BFS（小团队图规模，确定性且无爆炸风险）。
// - count() 返回驱动 Integer，统一 toNumber。
import { withGraphSession, GraphUnavailableError } from "./driver.js";

export interface GraphNode {
  assetId: string;
  name: string;
  typeKey: string;
  typeTitle: string;
  lifecycle: string;
  kind: string;
}

export interface GraphEdge {
  relId: string;
  relKey: string;
  source: string;
  target: string;
}

const num = (v: unknown): number => (typeof v === "object" && v !== null && "toNumber" in (v as object) ? (v as { toNumber(): number }).toNumber() : Number(v));

/** 类闭包（本体检索核心）：typeKey 及其全部后代类键。类层次由应用层保证无环。
 * 图中不存在该类节点（投影未建/未含）时返回 null——调用方据此回落 SQL，不虚构结果。 */
export async function typeClosureKeys(teamId: string, typeKey: string): Promise<string[] | null> {
  return withGraphSession("READ", async (session) => {
    const res = await session.run(
      `MATCH (t:AssetType {teamId: $teamId, typeKey: $typeKey})
       OPTIONAL MATCH (d:AssetType)-[:SUBCLASS_OF*1..]->(t)
       WHERE d.teamId = $teamId
       RETURN collect(DISTINCT d.typeKey) AS keys`,
      { teamId, typeKey }
    );
    const rec = res.records[0];
    if (!rec) return null;
    const keys = (rec.get("keys") as string[]).filter((k) => typeof k === "string");
    return [typeKey, ...keys];
  });
}

/** 多跳邻域（图库原生展开，硬限深 1..3）：返回种子节点 + 邻域内资产与 RELATES 边。 */
export async function neighborhood(
  teamId: string,
  assetId: string,
  depth: number
): Promise<{ seed: GraphNode | null; nodes: GraphNode[]; edges: GraphEdge[] }> {
  const d = Math.min(Math.max(Math.trunc(depth), 1), 3);
  return withGraphSession("READ", async (session) => {
    const seedRes = await session.run(
      `MATCH (a:Asset {teamId: $teamId, assetId: $assetId}) RETURN a AS node LIMIT 1`,
      { teamId, assetId }
    );
    const seedRaw = seedRes.records[0]?.get("node");
    if (!seedRaw) return { seed: null, nodes: [], edges: [] };
    const seed = propsOf(seedRaw);

    // 每跳一次查询（Memgraph 变长上限需字面量；深度 ≤3，k^d 有界）
    const edgeMap = new Map<string, GraphEdge>();
    const nodeMap = new Map<string, GraphNode>([[seed.assetId, seed]]);
    for (let hop = 1; hop <= d; hop += 1) {
      const res = await session.run(
        `MATCH p = (a:Asset {teamId: $teamId, assetId: $assetId})-[:RELATES*${hop}]-(b:Asset)
         WHERE all(n IN nodes(p) WHERE n.teamId = $teamId)
         UNWIND relationships(p) AS r
         RETURN DISTINCT startNode(r) AS s, endNode(r) AS t, r.relId AS relId, r.relKey AS relKey
         LIMIT 2000`,
        { teamId, assetId }
      );
      for (const rec of res.records) {
        const relId = String(rec.get("relId"));
        if (!edgeMap.has(relId)) {
          const s = propsOf(rec.get("s"));
          const t = propsOf(rec.get("t"));
          nodeMap.set(s.assetId, s);
          nodeMap.set(t.assetId, t);
          edgeMap.set(relId, {
            relId,
            relKey: String(rec.get("relKey")),
            source: s.assetId,
            target: t.assetId,
          });
        }
      }
    }
    return { seed, nodes: [...nodeMap.values()], edges: [...edgeMap.values()] };
  });
}

function propsOf(raw: unknown): GraphNode {
  const p = (raw as { properties: Record<string, unknown> }).properties;
  return {
    assetId: String(p.assetId),
    name: String(p.name),
    typeKey: String(p.typeKey),
    typeTitle: String(p.typeTitle ?? ""),
    lifecycle: String(p.lifecycle),
    kind: String(p.kind),
  };
}

/** 团队关系边集（路径 BFS 数据源；线性于边数，上限保护）。
 * 注记：Memgraph 的 LIMIT 不接受参数（"must be an integer"），上限内联为字面量。 */
async function teamEdges(teamId: string, limit: number): Promise<GraphEdge[]> {
  const capped = Math.min(Math.max(Math.trunc(limit), 1), 20000);
  return withGraphSession("READ", async (session) => {
    const res = await session.run(
      `MATCH (a:Asset {teamId: $teamId})-[r:RELATES]->(b:Asset)
       WHERE b.teamId = $teamId
       RETURN a.assetId AS s, b.assetId AS t, r.relId AS relId, r.relKey AS relKey
       LIMIT ${capped}`,
      { teamId }
    );
    return res.records.map((rec) => ({
      source: String(rec.get("s")),
      target: String(rec.get("t")),
      relId: String(rec.get("relId")),
      relKey: String(rec.get("relKey")),
    }));
  });
}

async function nodesByIds(teamId: string, ids: string[]): Promise<Map<string, GraphNode>> {
  if (ids.length === 0) return new Map();
  return withGraphSession("READ", async (session) => {
    const res = await session.run(
      `UNWIND $ids AS id
       MATCH (a:Asset {teamId: $teamId, assetId: id})
       RETURN a AS node`,
      { teamId, ids }
    );
    const map = new Map<string, GraphNode>();
    for (const rec of res.records) {
      const n = propsOf(rec.get("node"));
      map.set(n.assetId, n);
    }
    return map;
  });
}

/** 两资产间最短关联路径（无向 BFS；返回路径链上的节点与有向边）。找不到返回 null。 */
export async function findShortestPath(
  teamId: string,
  fromAssetId: string,
  toAssetId: string
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] } | null> {
  if (fromAssetId === toAssetId) return null;
  const edges = await teamEdges(teamId, 5000);
  const adj = new Map<string, { to: string; edge: GraphEdge }[]>();
  for (const e of edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push({ to: e.target, edge: e });
    if (!adj.has(e.target)) adj.set(e.target, []);
    adj.get(e.target)!.push({ to: e.source, edge: e });
  }
  const prev = new Map<string, { node: string; edge: GraphEdge }>([[fromAssetId, { node: "", edge: null as never }]]);
  const queue = [fromAssetId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === toAssetId) break;
    for (const { to, edge } of adj.get(cur) ?? []) {
      if (!prev.has(to)) {
        prev.set(to, { node: cur, edge });
        queue.push(to);
      }
    }
  }
  if (!prev.has(toAssetId)) return null;
  const chainIds: string[] = [];
  const pathEdges: GraphEdge[] = [];
  let cursor = toAssetId;
  while (cursor !== fromAssetId) {
    const step = prev.get(cursor)!;
    chainIds.unshift(cursor);
    pathEdges.unshift(step.edge);
    cursor = step.node;
  }
  chainIds.unshift(fromAssetId);
  const nodeMap = await nodesByIds(teamId, chainIds);
  return {
    nodes: chainIds.map((id) => nodeMap.get(id)).filter((n): n is GraphNode => Boolean(n)),
    edges: pathEdges,
  };
}

/** 图库侧团队子图计数（漂移对账）。 */
export async function graphCounts(teamId: string): Promise<{ nodes: number; edges: number }> {
  return withGraphSession("READ", async (session) => {
    const nodes = await session.run(
      "MATCH (n) WHERE (n:Asset OR n:AssetType) AND n.teamId = $teamId RETURN count(n) AS c",
      { teamId }
    );
    const edges = await session.run(
      `MATCH (a)-[r]->(b) WHERE a.teamId = $teamId AND b.teamId = $teamId
         AND (a:Asset OR a:AssetType) AND (b:Asset OR b:AssetType)
       RETURN count(r) AS c`,
      { teamId }
    );
    return {
      nodes: num(nodes.records[0]?.get("c") ?? 0),
      edges: num(edges.records[0]?.get("c") ?? 0),
    };
  });
}

/** 图库整体节点数（漂移检测的廉价哨兵；含跨团队，仅用于重启后快速判断"是否需要重建"）。 */
export async function graphTotalNodes(): Promise<number> {
  return withGraphSession("READ", async (session) => {
    const res = await session.run("MATCH (n) WHERE n:Asset OR n:AssetType RETURN count(n) AS c");
    return num(res.records[0]?.get("c") ?? 0);
  });
}

export { GraphUnavailableError };
