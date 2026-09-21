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
interface SimEdge { id: string; typeKey: string; status: string; source: number; target: number; label: string }

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

// 类型着色：按 type_key 排序后取调色板（确定性，同类型同色）
const PALETTE = ["#3b6ea5", "#2e6b4f", "#8a5a9e", "#b0703c", "#4f7d9e", "#7d6a3b", "#a54a6f", "#4a8a7a", "#6b6b9e", "#8a7a4a"];

export function RelationGraph({ project, onOpenAsset, initialFocusId }: {
  project?: ProjectInfo;
  onOpenAsset: (assetId: string) => void;
  /** NL「聚焦 X 的图谱」等入口预置的聚焦资产（M21）；仅注入状态，用户仍可自由改选 */
  initialFocusId?: string;
}) {
  const [edges, setEdges] = useState<RelEdge[] | null>(null);
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [error, setError] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [focusId, setFocusId] = useState("");
  const [focusHops, setFocusHops] = useState(loadFocusHops);
  const [tick, setTick] = useState(0); // 模拟帧驱动
  const nodesRef = useRef<SimNode[]>([]);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ index: number; moved: boolean } | null>(null);
  const dragMovedRef = useRef(false);

  useEffect(() => {
    if (initialFocusId) setFocusId(initialFocusId);
  }, [initialFocusId]);

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

  // 过滤后的边与参与节点。聚焦模式：BFS 展开聚焦资产 N 跳邻域（1/2/3 跳）；
  // 无关系连接的资产默认隐藏（数量如实提示）。
  const { simEdges, simNodes, hiddenAssets } = useMemo(() => {
    const byId = new Map(assets.map((a) => [a.id, a]));
    const base = (edges ?? []).filter(
      (e) =>
        byId.has(e.source_asset_id) && byId.has(e.target_asset_id) &&
        (!typeFilter || e.type_key === typeFilter) &&
        (!statusFilter || e.status === statusFilter)
    );
    let kept = base;
    if (focusId && byId.has(focusId)) {
      // 邻域集合：从聚焦资产沿边 BFS focusHops 跳
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
    const degree = new Map<string, number>();
    for (const e of kept) {
      degree.set(e.source_asset_id, (degree.get(e.source_asset_id) ?? 0) + 1);
      degree.set(e.target_asset_id, (degree.get(e.target_asset_id) ?? 0) + 1);
    }
    if (focusId && byId.has(focusId) && !degree.has(focusId)) degree.set(focusId, 0);
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
    const edgeList: SimEdge[] = kept.map((e) => ({
      id: e.id, typeKey: e.type_key, status: e.status,
      source: index.get(e.source_asset_id)!, target: index.get(e.target_asset_id)!,
      label: e.type_key,
    }));
    return { simEdges: edgeList, simNodes: nodeList, hiddenAssets: assets.length - degree.size };
  }, [edges, assets, typeFilter, statusFilter, focusId, focusHops]);

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
      ".edge line { stroke: #5f7169; stroke-width: 1.4; opacity: 0.65; }",
      ".edge.proposed line { stroke-dasharray: 5 4; opacity: 0.55; }",
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
      {edges !== null && edges.length > 0 && simNodes.length === 0 && (
        <Empty icon="⛃" title="关系引用的资产不在最近 200 个资产内" hint="资产目录超过 200 条时图谱只展示最近登记的资产参与的关系。" />
      )}
      {simNodes.length > 0 && (
        <>
          {focusId && simNodes.length > 0 && (
            <p className="hint" style={{ marginTop: 0 }}>
              聚焦模式：显示聚焦资产 {focusHops} 跳邻域（{simNodes.length} 节点 / {simEdges.length} 关系）。
            </p>
          )}
          {hiddenAssets > 0 && (
            <p className="hint" style={{ marginTop: 0 }}>
              已隐藏 {hiddenAssets} 个无关系连接的资产；图谱只展示有关系的资产。拖拽节点可重排，点击节点打开资产详情。
            </p>
          )}
          <div className="graph-wrap card">
            <svg
              ref={svgRef}
              className="rel-graph"
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
                const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                return (
                  <g key={e.id} className={e.status === "proposed" ? "edge proposed" : "edge"}>
                    <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} markerEnd="url(#arrow)" strokeDasharray={e.status === "proposed" ? "5 4" : undefined} />
                    <text x={mx} y={my - 4} className="edge-label">{e.label}</text>
                  </g>
                );
              })}
              {simNodes.map((n, i) => {
                const r = 13 + Math.min(n.degree, 8);
                const color = colorOf.get(n.typeKey) ?? "#666";
                const isFocus = n.id === focusId;
                return (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    className="node"
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
                    <circle r={r} fill={color} stroke={isFocus ? "var(--accent)" : n.lifecycle === "archived" ? "var(--muted)" : "#fff"} strokeDasharray={n.lifecycle === "archived" ? "4 3" : undefined} strokeWidth={isFocus ? 3 : 2} opacity={0.92} />
                    <text y={r + 13} className="node-label">{n.name.length > 14 ? `${n.name.slice(0, 13)}…` : n.name}</text>
                    <title>{`${n.name}（${n.typeKey}）${n.lifecycle === "archived" ? "· 已归档" : ""} · 度 ${n.degree}`}</title>
                  </g>
                );
              })}
            </svg>
            <div className="graph-legend" aria-label="类型图例">
              {[...new Set(simNodes.map((n) => n.typeKey))].sort().map((k) => (
                <span key={k} className="legend-item">
                  <span className="legend-dot" style={{ background: colorOf.get(k) }} />
                  {k}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
      {!edges && !error && <div className="state">正在加载关系…</div>}
    </div>
  );
}
