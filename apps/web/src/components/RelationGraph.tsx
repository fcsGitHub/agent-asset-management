// 关系图谱页：全团队资产关系可视化。数据全部来自真实端点
// （GET /relations 团队级 + GET /assets/search?lifecycle=all）。
// 布局为本地实现的力导向模拟（确定性初始圆环布局，无随机、无外部依赖）：
// 斥力 + 弹簧 + 向心力，alpha 衰减收敛；节点可拖拽固定，点击打开资产详情。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Empty } from "./Empty";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string }
interface RelEdge {
  id: string; type_key: string; status: string;
  source_asset_id: string; target_asset_id: string;
  source_name: string; target_name: string;
}

interface SimNode {
  id: string; name: string; typeKey: string; lifecycle: string;
  x: number; y: number; vx: number; vy: number;
  degree: number;
}
interface SimEdge { id: string; typeKey: string; status: string; source: number; target: number; label: string; lane: number; lanes: number }

const W = 1000;
const H = 620;

// 聚焦跳数记忆（M25）：上次选择的跳数持久化，重进页面或经 NL 再次聚焦时沿用。
// 存储不可用（隐私模式等）时静默回退 1 跳——偏好记忆是增强，不是功能依赖。
const HOPS_KEY = "taw.graph.focusHops";
function loadFocusHops(): number {
  try {
    const v = Number(localStorage.getItem(HOPS_KEY));
    return v === 2 || v === 3 ? v : 1;
  } catch {
    return 1;
  }
}

// 边标签显隐偏好（M53 去杂乱）：大图默认可关掉全部关系标签（悬停 title 仍可读）
const EDGE_LABELS_KEY = "taw.graph.showEdgeLabels";
function loadShowEdgeLabels(): boolean {
  try {
    return localStorage.getItem(EDGE_LABELS_KEY) !== "0";
  } catch {
    return true;
  }
}

// 类型着色：按 type_key 排序后取调色板（确定性，同类型同色）
const PALETTE = ["#3b6ea5", "#2e6b4f", "#8a5a9e", "#b0703c", "#4f7d9e", "#7d6a3b", "#a54a6f", "#4a8a7a", "#6b6b9e", "#8a7a4a"];

export interface GraphPathRequest { fromId: string; toId: string; nonce: number }

interface PathChainNode { id: string; name: string; via: string | null; forward: boolean }
type PathView =
  | { status: "loading" }
  | { status: "found"; hops: number; chain: PathChainNode[]; edgeIds: Set<string>; nodeIds: Set<string> }
  | { status: "not-found" }
  | { status: "error"; message: string };

export function RelationGraph({ project, onOpenAsset, initialFocusId, initialPath }: {
  project?: ProjectInfo;
  onOpenAsset: (assetId: string) => void;
  /** NL「聚焦 X 的图谱」等入口预置的聚焦资产（M21）；仅注入状态，用户仍可自由改选 */
  initialFocusId?: string;
  /** NL「A 和 B 怎么关联」入口预置的路径查询（M51）：拉取 /graph/path 并高亮链路 */
  initialPath?: GraphPathRequest | null;
}) {
  const [edges, setEdges] = useState<RelEdge[] | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [focusId, setFocusId] = useState("");
  const [focusHops, setFocusHops] = useState(loadFocusHops);
  // 去杂乱（M53，吸收 OpenCTI 图内过滤思路）：类型图例点选显隐 + 低连接度节点降噪
  const [hiddenTypes, setHiddenTypes] = useState<Set<string>>(new Set());
  const [minDegree, setMinDegree] = useState(0);
  const [showEdgeLabels, setShowEdgeLabels] = useState(loadShowEdgeLabels);
  const [tick, setTick] = useState(0); // 模拟帧驱动
  const nodesRef = useRef<SimNode[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    if (initialFocusId) setFocusId(initialFocusId);
  }, [initialFocusId]);

  const [pathView, setPathView] = useState<PathView | null>(null);
  const pathNonceRef = useRef(0);
  // 聚焦邻域改走服务端（M54，老化候选项）：图库在线时 /graph/neighborhood 直出子图
  // （引擎=graph）；离线或投影滞后时回退客户端 BFS（引擎=sql-fallback，提示如实区分）
  const [serverNeighborhood, setServerNeighborhood] = useState<{ edgeIds: Set<string>; nodeIds: Set<string> } | null>(null);
  const [focusEngine, setFocusEngine] = useState<"" | "graph" | "sql-fallback">("");  useEffect(() => {
    if (!initialPath || !project) return;
    if (initialPath.nonce === pathNonceRef.current) return;
    pathNonceRef.current = initialPath.nonce;
    setPathView({ status: "loading" });
    void api<{ found: boolean; hops?: number; nodes?: { assetId: string; name: string }[]; edges?: { relId: string; relKey: string; source: string; target: string }[] }>(
      "/graph/path",
      { query: { teamId: project.teamId, from: initialPath.fromId, to: initialPath.toId } }
    )
      .then((r) => {
        if (!r.found || !r.nodes || !r.edges) {
          setPathView({ status: "not-found" });
          return;
        }
        // 链条渲染：edges[i] 连接 nodes[i]—nodes[i+1]；箭头按真实方向标注
        const chain: PathChainNode[] = r.nodes.map((n, i) => {
          const e = i > 0 ? r.edges![i - 1] : undefined;
          return {
            id: n.assetId,
            name: n.name,
            via: e?.relKey ?? null,
            forward: e ? e.source === r.nodes![i - 1]!.assetId : true,
          };
        });
        setPathView({
          status: "found",
          hops: r.edges.length,
          chain,
          edgeIds: new Set(r.edges.map((e) => e.relId)),
          nodeIds: new Set(r.nodes.map((n) => n.assetId)),
        });
      })
      .catch((e) => setPathView({ status: "error", message: e instanceof Error ? e.message : "路径查询失败" }));
  }, [initialPath, project]);

  // 聚焦时拉服务端邻域（M54）：路径模式或未聚焦时清空；失败/滞后回退客户端 BFS
  useEffect(() => {
    if (!project || !focusId || pathView?.status === "found") {
      setServerNeighborhood(null);
      setFocusEngine("");
      return;
    }
    let cancelled = false;
    void api<{ found: boolean; reason?: string; nodes?: { assetId: string }[]; edges?: { relId: string }[] }>(
      "/graph/neighborhood",
      { query: { teamId: project.teamId, assetId: focusId, depth: String(focusHops) } }
    )
      .then((r) => {
        if (cancelled) return;
        if (r.found && r.nodes && r.edges) {
          setServerNeighborhood({
            nodeIds: new Set(r.nodes.map((n) => n.assetId)),
            edgeIds: new Set(r.edges.map((e) => e.relId)),
          });
          setFocusEngine("graph");
        } else {
          setServerNeighborhood(null);
          setFocusEngine("sql-fallback");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setServerNeighborhood(null);
          setFocusEngine("sql-fallback");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [project, focusId, focusHops, pathView?.status]);

  const reload = useCallback(() => {
    if (!project) return;
    setError("");
    setEdges(null);
    void api<{ outgoing: RelEdge[]; incoming: RelEdge[] }>("/relations", { query: { teamId: project.teamId } })
      .then((r) => {
        // 团队级查询 outgoing/incoming 各自返回全量，按 id 去重
        const byId = new Map<string, RelEdge>();
        for (const e of [...r.outgoing, ...r.incoming]) byId.set(e.id, e);
        setEdges([...byId.values()]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "加载关系失败"));
    void api<AssetRow[]>("/assets/search", { query: { teamId: project.teamId, lifecycle: "all", limit: "200" } })
      .then(setAssets)
      .catch(() => setAssets([]));
  }, [project]);

  useEffect(reload, [reload]);

  // 过滤后的边与参与节点。过滤顺序：类型显隐 → 聚焦/路径 → 度数降噪。
  // 聚焦模式：BFS 展开聚焦资产 N 跳邻域（1/2/3 跳）；路径模式只留链路边（过滤全旁路）；
  // 无关系连接的资产默认隐藏（数量如实提示）。
  const { simEdges, simNodes, hiddenAssets, prunedNodes, legend } = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]));
    let base = (edges ?? []).filter(
      (e) =>
        byId.has(e.source_asset_id) && byId.has(e.target_asset_id) &&
        (!typeFilter || e.type_key === typeFilter) &&
        (!statusFilter || e.status === statusFilter)
    );
    // 类型显隐（M53）：被隐藏类型资产的连边整体剔除（端点任一命中即隐）
    if (hiddenTypes.size > 0) {
      base = base.filter(
        (e) =>
          !hiddenTypes.has(byId.get(e.source_asset_id)!.type_key) &&
          !hiddenTypes.has(byId.get(e.target_asset_id)!.type_key)
      );
    }
    let kept = base;
    let keepIds: Set<string> | null = null;
    if (pathView?.status === "found") {
      // 路径模式（M51）：只保留链路上的关系边——链条节点天然带度，不会消失
      kept = base.filter((e) => pathView.edgeIds.has(e.id));
    } else if (focusId && byId.has(focusId)) {
      if (serverNeighborhood) {
        // 服务端图库邻域（M54）：图库边集交集（relId 与关系断言 id 同源）
        kept = base.filter((e) => serverNeighborhood.edgeIds.has(e.id));
      } else {
        // 客户端 BFS 回退（图库离线/投影滞后）：从聚焦资产沿边 BFS focusHops 跳
        const adjacency = new Map<string, string[]>();
        for (const e of base) {
          adjacency.set(e.source_asset_id, [...(adjacency.get(e.source_asset_id) ?? []), e.target_asset_id]);
          adjacency.set(e.target_asset_id, [...(adjacency.get(e.target_asset_id) ?? []), e.source_asset_id]);
        }
        const inSet = new Set<string>([focusId]);
        let frontier = [focusId];
        for (let hop = 0; hop < focusHops; hop++) {
          const next: string[] = [];
          for (const node of frontier) {
            for (const nb of adjacency.get(node) ?? []) {
              if (!inSet.has(nb)) {
                inSet.add(nb);
                next.push(nb);
              }
            }
          }
          frontier = next;
        }
        kept = base.filter((e) => inSet.has(e.source_asset_id) && inSet.has(e.target_asset_id));
      }
    } else if (minDegree > 0) {
      // 度数降噪（M53）：先算一遍度，把度 < minDegree 的节点连边剔除（聚焦资产豁免）。
      // 单轮剪枝（不迭代收敛）：剪完的孤立节点消失即可，如实提示数量。
      const pre = new Map<string, number>();
      for (const e of kept) {
        pre.set(e.source_asset_id, (pre.get(e.source_asset_id) ?? 0) + 1);
        pre.set(e.target_asset_id, (pre.get(e.target_asset_id) ?? 0) + 1);
      }
      kept = kept.filter((e) => {
        const okS = (pre.get(e.source_asset_id) ?? 0) >= minDegree || e.source_asset_id === focusId;
        const okT = (pre.get(e.target_asset_id) ?? 0) >= minDegree || e.target_asset_id === focusId;
        return okS && okT;
      });
      // 达标节点即使连边被剪光也保留（度归 0）：中心枢纽正是要留下的密集核，
      // 否则星型图在度 ≥ 2 时会整体消失。
      keepIds = new Set(
        [...pre.entries()].filter(([id, d]) => d >= minDegree || id === focusId).map(([id]) => id)
      );
    }
    const degree = new Map<string, number>();
    for (const e of kept) {
      degree.set(e.source_asset_id, (degree.get(e.source_asset_id) ?? 0) + 1);
      degree.set(e.target_asset_id, (degree.get(e.target_asset_id) ?? 0) + 1);
    }
    if (focusId && byId.has(focusId) && !degree.has(focusId)) degree.set(focusId, 0);
    for (const id of keepIds ?? []) if (!degree.has(id)) degree.set(id, 0);
    const nodeList: SimNode[] = [];
    const index = new Map<string, number>();
    for (const id of [...degree.keys()].sort()) {
      const a = byId.get(id)!;
      index.set(id, nodeList.length);
      // 确定性圆环初始布局（按 id 排序），模拟收敛路径可复现
      const angle = (nodeList.length / Math.max(degree.size, 1)) * 2 * Math.PI;
      nodeList.push({
        id, name: a.name, typeKey: a.type_key, lifecycle: a.lifecycle,
        x: W / 2 + Math.cos(angle) * 220, y: H / 2 + Math.sin(angle) * 180,
        vx: 0, vy: 0, degree: degree.get(id) ?? 0,
      });
    }
    // 类型可见度统计（M53）：图例上显示当前可见的各类型节点数
    const typeCounts = new Map<string, number>();
    for (const n of nodeList) typeCounts.set(n.typeKey, (typeCounts.get(n.typeKey) ?? 0) + 1);
    const edgeList: SimEdge[] = kept.map((e) => ({
      id: e.id, typeKey: e.type_key, status: e.status,
      source: index.get(e.source_asset_id)!, target: index.get(e.target_asset_id)!,
      label: e.type_key, lane: 0, lanes: 1,
    }));
    // 平行边分车道（M46）：同一对节点间的多条关系按组分配对称车道，
    // 渲染时各自弯开（控制点沿法线偏移），线与标签都不再叠合
    const groups = new Map<string, SimEdge[]>();
    for (const e of edgeList) {
      const key = e.source < e.target ? `${e.source}|${e.target}` : `${e.target}|${e.source}`;
      const g = groups.get(key) ?? [];
      g.push(e);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      g.forEach((e, i) => {
        e.lane = i - (g.length - 1) / 2;
        e.lanes = g.length;
      });
    }
    // prunedNodes：度数降噪单独隐藏的数量 = 类型过滤后参与边集的资产中已不在可见度表里的
    let pruned = 0;
    if (minDegree > 0 && pathView?.status !== "found" && !(focusId && byId.has(focusId))) {
      const participants = new Set<string>();
      for (const e of base) {
        participants.add(e.source_asset_id);
        participants.add(e.target_asset_id);
      }
      for (const id of participants) if (!degree.has(id)) pruned++;
    }
    // 图例（M53）：覆盖全部参与关系的类型（含被隐藏的），可见数/总数并排——
    // 被隐藏的类型仍保留在图例里（off 态），可再次点选恢复，而不必整体重置。
    const totalByType = new Map<string, number>();
    const participantsAll = new Set<string>();
    for (const e of edges ?? []) {
      participantsAll.add(e.source_asset_id);
      participantsAll.add(e.target_asset_id);
    }
    for (const id of participantsAll) {
      const a = byId.get(id);
      if (a) totalByType.set(a.type_key, (totalByType.get(a.type_key) ?? 0) + 1);
    }
    const legend = [...new Set([...totalByType.keys(), ...typeCounts.keys()])].map((typeKey) => ({
      typeKey,
      visible: typeCounts.get(typeKey) ?? 0,
      total: totalByType.get(typeKey) ?? 0,
    }));
    return { simEdges: edgeList, simNodes: nodeList, hiddenAssets: assets.length - degree.size, typeCounts, prunedNodes: pruned, legend };
  }, [edges, assets, typeFilter, statusFilter, focusId, focusHops, pathView, hiddenTypes, minDegree, serverNeighborhood]);

  nodesRef.current = simNodes;

  // 力导向模拟：alpha 衰减至收敛；拖拽/过滤变化时重启
  useEffect(() => {
    let raf = 0;
    let alpha = 1;
    const nodes = nodesRef.current;
    const step = () => {
      if (alpha < 0.015) return;
      // 斥力（O(n²)，n≤200）
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          let dx = a.x - b.x, dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) { dx = (i - j) * 0.7 + 0.5; dy = (i % 7 - j % 7) * 0.7 + 0.5; d2 = dx * dx + dy * dy; }
          const f = (1600 * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
        }
        a.vy += (H / 2 - a.y) * 0.004 * alpha; // 向心
        a.vx += (W / 2 - a.x) * 0.004 * alpha;
      }
      // 弹簧
      for (const e of simEdges) {
        const a = nodes[e.source], b = nodes[e.target];
        if (!a || !b) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const f = (d - 130) * 0.015 * alpha;
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
      }
      // 积分 + 阻尼 + 边界
      for (const n of nodes) {
        n.vx *= 0.85; n.vy *= 0.85;
        n.x = Math.min(W - 30, Math.max(30, n.x + n.vx));
        n.y = Math.min(H - 30, Math.max(30, n.y + n.vy));
      }
      alpha *= 0.985;
      setTick((t) => t + 1);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [simEdges, simNodes]);

  const typeKeys = useMemo(() => [...new Set((edges ?? []).map((e) => e.type_key))].sort(), [edges]);
  const colorOf = useMemo(() => {
    const m = new Map<string, string>();
    typeKeys.forEach((k, i) => m.set(k, PALETTE[i % PALETTE.length]!));
    // 节点色按资产 type_key（可能大于边类型集合）
    let i = typeKeys.length;
    for (const a of assets) if (!m.has(a.type_key)) { m.set(a.type_key, PALETTE[i % PALETTE.length]!); i++; }
    return m;
  }, [typeKeys, assets]);

  // 图谱快照导出（M29）：把当前视图序列化为独立 SVG 文件。CSS 变量在独立文件中
  // 不可解析，注入同值的具体色样式并修正 marker 填充；节点/边的几何与颜色本就
  // 是内联属性，无需转换。
  function buildStandaloneSvg(): string | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("width", String(W));
    clone.setAttribute("height", String(H));
    const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
    style.textContent = [
      "svg { background: #fffefa; font-family: sans-serif; }",
      ".edge path { stroke: #5f7169; stroke-width: 1.4; opacity: 0.65; }",
      ".edge.path-edge path { stroke: #1e6b52; stroke-width: 2.6; opacity: 1; }",
      ".edge.path-edge .edge-label { fill: #1e6b52; font-weight: 600; }",
      ".edge.proposed path { stroke-dasharray: 5 4; opacity: 0.55; }",
      ".edge-label { font-size: 11px; fill: #5f7169; text-anchor: middle; paint-order: stroke; stroke: #fffefa; stroke-width: 3px; }",
      ".node-label { font-size: 12px; fill: #1c2b26; text-anchor: middle; paint-order: stroke; stroke: #fffefa; stroke-width: 3px; }",
    ].join("\n");
    clone.insertBefore(style, clone.firstChild);
    const markerPath = clone.querySelector("marker path");
    if (markerPath) markerPath.setAttribute("fill", "#5f7169");
    return new XMLSerializer().serializeToString(clone);
  }

  function download(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportSvg() {
    const text = buildStandaloneSvg();
    if (!text) return;
    download(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `taw-graph-${new Date().toISOString().slice(0, 10)}.svg`);
  }

  // PNG 位图导出（M30）：复用独立 SVG，经 Image/canvas 以 2x 分辨率栅格化
  async function exportPng() {
    const text = buildStandaloneSvg();
    if (!text) return;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = W * scale;
    canvas.height = H * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#fffefa";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob) download(blob, `taw-graph-${new Date().toISOString().slice(0, 10)}.png`);
  }

  const svgPoint = (ev: PointerEvent | React.PointerEvent): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  };

  useEffect(() => {
    const move = (ev: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const n = nodesRef.current[drag.index];
      if (!n) return;
      const p = svgPoint(ev);
      if (Math.abs(p.x - n.x) > 2 || Math.abs(p.y - n.y) > 2) drag.moved = true;
      n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
      setTick((t) => t + 1);
    };
    const up = () => {
      if (dragRef.current) dragMovedRef.current = dragRef.current.moved;
      dragRef.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="关系图谱按团队展示资产间的类型化关系。" />;
  if (error) return <div className="state error">{error}</div>;

  void tick; // 渲染由 state tick 驱动（模拟帧）

  return (
    <div className="page">
      <div className="page-head">
        <h2>关系图谱</h2>
        <span className="chip chip-dim">{simNodes.length} 节点 · {simEdges.length} 关系</span>
        <select aria-label="按关系类型过滤" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">全部关系类型</option>
          {typeKeys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select aria-label="按关系状态过滤" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="confirmed">已确认</option>
          <option value="proposed">待定</option>
        </select>
        <select aria-label="聚焦资产" value={focusId} onChange={(e) => setFocusId(e.target.value)}>
          <option value="">全部资产</option>
          {[...assets].sort((a, b) => a.name.localeCompare(b.name, "zh-CN")).map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        {focusId && (
          <select
            aria-label="聚焦跳数"
            value={focusHops}
            onChange={(e) => {
              const n = Number(e.target.value);
              setFocusHops(n);
              try { localStorage.setItem(HOPS_KEY, String(n)); } catch { /* 偏好记忆不可用时功能不受影响 */ }
            }}
          >
            <option value={1}>1 跳邻域</option>
            <option value={2}>2 跳邻域</option>
            <option value={3}>3 跳邻域</option>
          </select>
        )}
        <select
          aria-label="度数降噪"
          value={minDegree}
          onChange={(e) => setMinDegree(Number(e.target.value))}
          title="隐藏低连接度的资产，只看关系密集的核心网络（聚焦模式下不生效）"
        >
          <option value={0}>全部节点</option>
          <option value={1}>度 ≥ 1</option>
          <option value={2}>度 ≥ 2</option>
          <option value={3}>度 ≥ 3</option>
        </select>
        <label className="legend-toggle" title="隐藏/显示关系类型标签（大图更清爽）">
          <input
            type="checkbox"
            checked={showEdgeLabels}
            onChange={(e) => {
              setShowEdgeLabels(e.target.checked);
              try { localStorage.setItem(EDGE_LABELS_KEY, e.target.checked ? "1" : "0"); } catch { /* 偏好记忆不可用时功能不受影响 */ }
            }}
          />
          关系标签
        </label>
        <button onClick={reload}>刷新</button>
        {simNodes.length > 0 && (
          <>
            <button title="把当前图谱视图保存为独立 SVG 文件" onClick={exportSvg}>导出 SVG</button>
            <button title="把当前图谱视图保存为 PNG 位图（2x 分辨率）" onClick={() => void exportPng()}>导出 PNG</button>
          </>
        )}
      </div>
      {error && <div className="error-text">{error}</div>}
      {edges !== null && edges.length === 0 && (
        <Empty icon="⚭" title="团队还没有已登记的关系" hint="在资产详情页断言关系（或由语义候选确认）后，这里会展示关系网络。" />
      )}
      {edges !== null && edges.length > 0 && simNodes.length === 0 && minDegree > 0 && (
        <Empty icon="⛃" title="度数降噪后没有满足阈值的节点" hint="当前图里所有资产的连接度都低于阈值——调低「度数降噪」选项或点击「全部节点」重试。" />
      )}
      {edges !== null && edges.length > 0 && simNodes.length === 0 && minDegree === 0 && (
        <Empty icon="⛃" title="关系引用的资产不在最近 200 个资产内" hint="资产目录超过 200 条时图谱只展示最近登记的资产参与的关系。" />
      )}
      {simNodes.length > 0 && (
        <>
          {pathView && (
            <div className="graph-path-banner" role="status" aria-label="关联路径查询结果">
              {pathView.status === "loading" && <span className="hint">正在查询关联路径…</span>}
              {pathView.status === "not-found" && (
                <span className="hint">两资产在当前关系图中没有关联路径（图库边集内不可达）。</span>
              )}
              {pathView.status === "error" && <span className="error-text">{pathView.message}</span>}
              {pathView.status === "found" && (
                <>
                  <span className="chip chip-ok">关联路径 · {pathView.hops} 跳</span>
                  {pathView.chain.map((c) => (
                    <span key={c.id} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
                      <span className="path-arrow" title={c.via ?? ""} style={{ display: c.via ? undefined : "none" }}>
                        {c.forward ? `${c.via} →` : `← ${c.via}`}
                      </span>
                      <button className="badge" title={c.name} onClick={() => onOpenAsset(c.id)}>
                        {c.name.length > 16 ? `${c.name.slice(0, 15)}…` : c.name}
                      </button>
                    </span>
                  ))}
                </>
              )}
              <span style={{ flex: 1 }} />
              <button onClick={() => setPathView(null)}>退出路径高亮</button>
            </div>
          )}
          {focusId && simNodes.length > 0 && pathView?.status !== "found" && (
            <p className="hint" style={{ marginTop: 0 }}>
              聚焦模式：显示聚焦资产 {focusHops} 跳邻域（{simNodes.length} 节点 / {simEdges.length} 关系）。
              {focusEngine === "graph" && " 邻域子图来自图数据库服务端。"}
              {focusEngine === "sql-fallback" && " 图库不可用或投影滞后，已回退目录数据客户端计算。"}
            </p>
          )}
          {hiddenAssets > 0 && (
            <p className="hint" style={{ marginTop: 0 }}>
              已隐藏 {hiddenAssets} 个资产（无关系连接、被图例隐藏或低于度数阈值{prunedNodes > 0 ? `，其中度数降噪隐藏 ${prunedNodes} 个` : ""}）。
              拖拽节点可重排，点击节点打开资产详情。
            </p>
          )}
          <div className="graph-wrap card">
            <svg
              ref={svgRef}
              className={`rel-graph${pathView?.status === "found" ? " has-path" : ""}`}
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`关系图谱：${simNodes.length} 个资产，${simEdges.length} 条关系`}
            >
              <defs>
                <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--muted)" />
                </marker>
              </defs>
              {simEdges.map((e) => {
                const a = simNodes[e.source], b = simNodes[e.target];
                if (!a || !b) return null;
                // 平行边（lanes>1）：二次贝塞尔沿弦法线弯开；lane=0 或单边保持直线
                let d = `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
                let lx = (a.x + b.x) / 2, ly = (a.y + b.y) / 2;
                if (e.lanes > 1 && e.lane !== 0) {
                  // 法线/锚点按无向规范向（小编号→大编号）计算：双向平行边
                  // 共享同一套车道几何，箭头仍按真实 source→target 方向绘制
                  const flip = e.source > e.target;
                  const p0 = flip ? b : a, p1 = flip ? a : b;
                  const dx = p1.x - p0.x, dy = p1.y - p0.y;
                  const len = Math.hypot(dx, dy) || 1;
                  const off = e.lane * 30;
                  const cx = (p0.x + p1.x) / 2 + (-dy / len) * off;
                  const cy = (p0.y + p1.y) / 2 + (dx / len) * off;
                  d = `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
                  // 标签锚点沿规范向随车道切向错开（幅度收敛，不贴近节点），再折回真实方向
                  const tc = 0.5 + e.lane * 0.11;
                  const t = flip ? 1 - tc : tc;
                  const u = 1 - t;
                  lx = u * u * a.x + 2 * u * t * cx + t * t * b.x;
                  ly = u * u * a.y + 2 * u * t * cy + t * t * b.y;
                }
                const onPath = pathView?.status === "found" && pathView.edgeIds.has(e.id);
                return (
                  <g key={e.id} className={onPath ? "edge path-edge" : e.status === "proposed" ? "edge proposed" : "edge"}>
                    <path d={d} fill="none" markerEnd="url(#arrow)" strokeDasharray={e.status === "proposed" ? "5 4" : undefined} />
                    {showEdgeLabels && <text x={lx} y={ly - 4} className="edge-label">{e.label}</text>}
                  </g>
                );
              })}
              {simNodes.map((n, i) => {
                const r = 13 + Math.min(n.degree, 8);
                const color = colorOf.get(n.typeKey) ?? "#666";
                const isFocus = n.id === focusId;
                const onPathNode = pathView?.status === "found" && pathView.nodeIds.has(n.id);
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    className={`node${onPathNode ? " path-node" : ""}`}
                    onPointerDown={(ev) => {
                      ev.preventDefault();
                      dragRef.current = { index: i, moved: false };
                    }}
                    onClick={() => {
                      // 拖拽结束后的 click 不视为"打开资产"（移动超过阈值即拖拽）
                      if (dragMovedRef.current) {
                        dragMovedRef.current = false;
                        return;
                      }
                      onOpenAsset(n.id);
                    }}
                  >
                    {isFocus && <circle r={r + 6} fill="none" stroke="var(--accent)" strokeWidth={2} strokeDasharray="5 4" />}
                    {onPathNode && <circle r={r + 4} fill="none" stroke="var(--accent)" strokeWidth={2.5} />}
                    <circle r={r} fill={color} stroke={isFocus ? "var(--accent)" : n.lifecycle === "archived" ? "var(--muted)" : "#fff"} strokeDasharray={n.lifecycle === "archived" ? "4 3" : undefined} strokeWidth={isFocus ? 3 : 2} opacity={0.92} />
                    <text y={r + 13} className="node-label">{n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}</text>
                    <title>{`${n.name}（${n.typeKey}）${n.lifecycle === "archived" ? "· 已归档" : ""} · 度 ${n.degree}`}</title>
                  </g>
                );
              })}
            </svg>
            <div className="graph-legend" aria-label="类型图例（点选显隐该类型资产）">
              {legend.sort((a, b) => a.typeKey.localeCompare(b.typeKey)).map(({ typeKey, visible, total }) => (
                <button
                  key={typeKey}
                  className={`legend-toggle${hiddenTypes.has(typeKey) ? " off" : ""}`}
                  title={hiddenTypes.has(typeKey) ? `点击显示类型 ${typeKey}（当前隐藏）` : `点击隐藏类型 ${typeKey}，简化视图`}
                  disabled={pathView?.status === "found"}
                  onClick={() =>
                    setHiddenTypes((prev) => {
                      const next = new Set(prev);
                      if (next.has(typeKey)) next.delete(typeKey);
                      else next.add(typeKey);
                      return next;
                    })
                  }
                >
                  <span className="legend-dot" style={{ background: colorOf.get(typeKey) }} />
                  {typeKey}（{visible}/{total}）
                </button>
              ))}
              {hiddenTypes.size > 0 && (
                <button className="legend-reset" onClick={() => setHiddenTypes(new Set())}>重置显隐</button>
              )}
            </div>
          </div>
        </>
      )}
      {!edges && !error && <div className="state">正在加载关系…</div>}
    </div>
  );
}
