// 资产详情「多跳关联」卡（M52）：图数据库邻域检索（GET /graph/neighborhood），
// 前端 BFS（lib/hopChains）为每个关联资产生成从当前资产出发的最短关联链。
// 图库离线 503 / 投影滞后（found=false）都如实提示；深度 1–3 可选。
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { buildHopChains, type HopChain } from "../lib/hopChains";

interface NeighborhoodNode { assetId: string; name: string; typeKey: string; lifecycle: string }
interface NeighborhoodEdge { relId: string; relKey: string; source: string; target: string }

type NeighborhoodView =
  | { status: "loading" }
  | { status: "found"; nodes: NeighborhoodNode[]; edges: NeighborhoodEdge[] }
  | { status: "stale" }
  | { status: "error"; message: string };

export function NeighborhoodCard({ teamId, assetId, onOpenAsset }: {
  teamId: string;
  assetId: string;
  onOpenAsset?: (assetId: string) => void;
}) {
  const [depth, setDepth] = useState(2);
  const [view, setView] = useState<NeighborhoodView>({ status: "loading" });
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    setView({ status: "loading" });
    let cancelled = false;
    void api<{ found: boolean; reason?: string; nodes?: NeighborhoodNode[]; edges?: NeighborhoodEdge[] }>(
      "/graph/neighborhood",
      { query: { teamId, assetId, depth: String(depth) } }
    )
      .then((r) => {
        if (cancelled) return;
        if (!r.found) setView({ status: "stale" });
        else setView({ status: "found", nodes: r.nodes ?? [], edges: r.edges ?? [] });
      })
      .catch((e) => {
        if (cancelled) return;
        setView({ status: "error", message: e instanceof ApiError ? e.message : "多跳关联查询失败" });
      });
    return () => { cancelled = true; };
  }, [teamId, assetId, depth, reloadNonce]);

  const chains = useCallback((): { node: NeighborhoodNode; chain: HopChain }[] => {
    if (view.status !== "found") return [];
    const byId = new Map(view.nodes.map((n) => [n.assetId, n]));
    const m = buildHopChains(assetId, view.edges.map((e) => ({ source: e.source, target: e.target, relKey: e.relKey })));
    return [...m.values()]
      .map((chain) => ({ node: byId.get(chain.assetId)!, chain }))
      .filter((x) => Boolean(x.node))
      .sort((a, b) => a.chain.hops - b.chain.hops || a.node.name.localeCompare(b.node.name, "zh-CN"));
  }, [view, assetId]);

  const renderChain = (chain: HopChain, names: Map<string, NeighborhoodNode>) => {
    // 链条紧凑渲染：本资产 —relKey→ B —relKey→ C（每步渲染箭头与该步目标名；
    // 方向逆行时箭头反向；终点可点打开）
    return chain.steps.map((s, i) => {
      const arrow = s.forward ? `${s.relKey} →` : `← ${s.relKey}`;
      const name = names.get(s.assetId)?.name ?? "…";
      const isLast = i === chain.steps.length - 1;
      return (
        <span key={`${s.assetId}-${i}`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <span className="onto-parent" style={{ margin: "0 4px" }}>{arrow}</span>
          {isLast && onOpenAsset ? (
            <button className="badge" title={name} onClick={() => onOpenAsset(s.assetId)}>
              {name.length > 18 ? `${name.slice(0, 17)}…` : name}
            </button>
          ) : (
            <span className="badge">{name.length > 18 ? `${name.slice(0, 17)}…` : name}</span>
          )}
        </span>
      );
    });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>多跳关联（图数据库）</h3>
        <select aria-label="关联跳数" value={depth} onChange={(e) => setDepth(Number(e.target.value))}>
          <option value={1}>1 跳</option>
          <option value={2}>2 跳</option>
          <option value={3}>3 跳</option>
        </select>
        <button onClick={() => setReloadNonce((n) => n + 1)}>刷新</button>
      </div>
      <p className="hint" style={{ padding: 0 }}>
        沿已确认关系向外探索（图数据库投影，不含类型层次边）；每行是从本资产出发的最短关联链，终点可点击打开。
      </p>
      {view.status === "loading" && <div className="state">查询邻域…</div>}
      {view.status === "error" && <div className="error-text">多跳关联暂不可用：{view.message}</div>}
      {view.status === "stale" && (
        <div className="hint">该资产尚未同步进图库投影（有新变更待对账）；可点「刷新」稍后再试。</div>
      )}
      {view.status === "found" && chains().length === 0 && (
        <div className="hint">{depth} 跳内没有已确认的关联资产。</div>
      )}
      {view.status === "found" && chains().length > 0 && (
        <table className="list">
          <thead>
            <tr><th>跳数</th><th>最短关联链（从本资产出发）</th></tr>
          </thead>
          <tbody>
            {chains().map(({ node, chain }) => (
              <tr key={node.assetId}>
                <td><span className="chip chip-dim">{chain.hops} 跳</span></td>
                <td>{renderChain(chain, new Map(view.status === "found" ? view.nodes.map((n) => [n.assetId, n]) : []))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
