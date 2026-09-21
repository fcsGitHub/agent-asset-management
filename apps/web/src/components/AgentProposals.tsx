// Agent 提案审核：proposal.create 落库的整理提案（asset_registration / relation_suggestion）
// 首次开放给人类——列表、结构化展示、接受/忽略决定。提案永远不会自动生效；
// asset_registration 可一键按提案预填登记表单（人工完成真实登记）。
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { Empty } from "./Empty";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface ProposalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
  run_prompt: string;
  initiated_by_name: string | null;
  reviewed_by_name: string | null;
}
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string }
// diff 用的现有资产摘要（来自资产详情端点的首修订属性）
interface AssetDiff { id: string; name: string; lifecycle: string; type_key: string; headProps: Record<string, unknown> }

const KIND_LABELS: Record<string, string> = {
  asset_registration: "资产登记提案",
  relation_suggestion: "关系建议提案",
};

/** 从自由 JSON payload 中提取常见的命名键（LLM 生成内容，键名做兼容回退）。 */
function pickName(payload: Record<string, unknown>): string | null {
  for (const k of ["name", "assetName", "title", "asset_name"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}
function pickTypeKey(payload: Record<string, unknown>): string | null {
  for (const k of ["typeKey", "type_key", "type", "suggestedType", "assetType"]) {
    const v = payload[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

export function AgentProposals({ project, onPrefillRegister }: {
  project?: ProjectInfo;
  onPrefillRegister?: (hint: { name?: string; typeKeyHint?: string }) => void;
}) {
  const [rows, setRows] = useState<ProposalRow[] | null>(null);
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  // 批量审核（M20）：勾选 + 批量接受/拒绝，逐条回执；备注（M23）可选，写入每条审核留痕
  const [pSel, setPSel] = useState<Record<string, boolean>>({});
  const [pBusy, setPBusy] = useState(false);
  const [pNote, setPNote] = useState("");
  // 提案 diff（M26）：登记提案与现有资产的对比（同名检测 + 类型/属性差异）。
  // 资产列表随项目加载；命中的资产详情按需拉取一次。
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [diffOpen, setDiffOpen] = useState<Record<string, boolean>>({});
  const [diffData, setDiffData] = useState<Record<string, AssetDiff | null>>({});
  const [diffErr, setDiffErr] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!project) return;
    void api<AssetRow[]>("/assets/search", { query: { teamId: project.teamId, lifecycle: "all", limit: "200" } })
      .then(setAssets)
      .catch(() => setAssets([]));
  }, [project]);

  async function toggleDiff(p: ProposalRow) {
    if (!project) return;
    const opening = !diffOpen[p.id];
    setDiffOpen((prev) => ({ ...prev, [p.id]: opening }));
    if (!opening || diffData[p.id] !== undefined) return;
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    const name = pickName(payload);
    const exact = name ? assets.find((a) => a.name === name) : undefined;
    if (!exact) {
      setDiffData((prev) => ({ ...prev, [p.id]: null }));
      return;
    }
    try {
      const d = await api<{ id: string; name: string; lifecycle: string; type_key: string; revisions?: Array<{ properties?: Record<string, unknown> }> }>(
        `/assets/${exact.id}`, { query: { teamId: project.teamId } }
      );
      setDiffData((prev) => ({
        ...prev,
        [p.id]: { id: d.id, name: d.name, lifecycle: d.lifecycle, type_key: d.type_key, headProps: d.revisions?.[0]?.properties ?? {} },
      }));
    } catch (err) {
      setDiffData((prev) => ({ ...prev, [p.id]: null }));
      setDiffErr((prev) => ({ ...prev, [p.id]: err instanceof ApiError ? err.message : "加载资产详情失败" }));
    }
  }

  const load = useCallback(() => {
    if (!project) return;
    const query: Record<string, string> = { teamId: project.teamId };
    if (status !== "all") query.status = status;
    void api<ProposalRow[]>(`/projects/${project.projectId}/proposals`, { query })
      .then(setRows)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载提案失败"));
  }, [project, status]);

  useEffect(load, [load]);

  async function review(p: ProposalRow, decision: "accepted" | "rejected") {
    if (!project) return;
    setRowErrors((prev) => ({ ...prev, [p.id]: "" }));
    try {
      await api(`/proposals/${p.id}/review`, { method: "POST", body: { teamId: project.teamId, decision } });
      load();
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [p.id]: err instanceof ApiError ? err.message : "审核失败" }));
    }
  }

  async function batchReview(decision: "accepted" | "rejected") {
    if (!project || !rows) return;
    const note = pNote.trim();
    const items = rows.filter((p) => pSel[p.id] && p.status === "pending")
      .map((p) => ({ proposalId: p.id, decision, note: note || undefined }));
    if (items.length === 0) return;
    setPBusy(true);
    setError("");
    try {
      const r = await api<{ reviewed: number; results: Array<{ proposalId: string; ok: boolean; code?: string; message?: string }> }>(
        `/projects/${project.projectId}/proposals/batch-review`,
        { method: "POST", body: { teamId: project.teamId, items } },
      );
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const res of r.results) {
          if (!res.ok) next[res.proposalId] = `${res.code ?? "INTERNAL"}：${res.message ?? "审核失败"}`;
        }
        return next;
      });
      setPSel({});
      setPNote("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "批量审核失败");
    } finally {
      setPBusy(false);
    }
  }

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="Agent 提案按项目展示。" />;

  return (
    <div className="card">
      <div className="card-head">
        <h3>Agent 提案</h3>
        <select aria-label="按状态筛选" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">待审核</option>
          <option value="accepted">已接受</option>
          <option value="rejected">已忽略</option>
          <option value="all">全部</option>
        </select>
        <button onClick={load}>刷新</button>
      </div>
      <p className="hint" style={{ padding: 0 }}>
        提案由 Agent 在运行中产出（如建议登记的资产、建议的关系），仅是候选——接受不会自动写库；
        登记类提案可预填表单由人工完成，关系类建议可在「语义候选」工作台人工确认。
      </p>
      {error && <div className="error-text">{error}</div>}
      {rows !== null && rows.length === 0 && (
        <Empty
          icon="📝"
          title={status === "pending" ? "没有待审提案" : "这里还没有提案"}
          hint="在左侧对话区给 Agent 派任务（如「梳理资产并提出整理建议」），产出的提案会出现在这里。"
        />
      )}
      {rows !== null && rows.length > 0 && status === "pending" && (
        <div className="sem-batchbar">
          <label className="sem-check">
            <input
              type="checkbox"
              aria-label="全选待审提案"
              checked={rows.every((p) => p.status !== "pending" || pSel[p.id])}
              onChange={(e) => setPSel(Object.fromEntries(rows.filter((p) => p.status === "pending").map((p) => [p.id, e.target.checked])))}
            />
            全选
          </label>
          <span className="sem-conf">已选 {rows.filter((p) => pSel[p.id] && p.status === "pending").length} 个待审提案</span>
          <input
            style={{ flex: 1, minWidth: 180 }}
            aria-label="批量审核备注（可选）"
            placeholder="批量备注（可选，写入每条审核留痕）"
            maxLength={2000}
            value={pNote}
            onChange={(e) => setPNote(e.target.value)}
          />
          <button className="primary" disabled={pBusy} onClick={() => void batchReview("accepted")}>
            {pBusy ? "处理中…" : "批量接受"}
          </button>
          <button disabled={pBusy} onClick={() => void batchReview("rejected")}>批量忽略</button>
          <span className="sem-conf">接受不自动写库；逐条回执，失败不影响其余</span>
        </div>
      )}
      {rows !== null && rows.length > 0 && (
        <ul className="proposal-list">
          {rows.map((p) => {
            const payload = (p.payload ?? {}) as Record<string, unknown>;
            const reviewInfo = (payload.review ?? {}) as Record<string, unknown>;
            const name = pickName(payload);
            const typeKey = pickTypeKey(payload);
            return (
              <li key={p.id} className={`proposal-item${p.status !== "pending" ? " proposal-done" : ""}`}>
                <div className="proposal-head">
                  {p.status === "pending" && status === "pending" && (
                    <input
                      type="checkbox"
                      aria-label={`批选 ${pickName(payload) ?? p.id}`}
                      checked={!!pSel[p.id]}
                      onChange={(e) => setPSel((prev) => ({ ...prev, [p.id]: e.target.checked }))}
                    />
                  )}
                  <span className="badge">{KIND_LABELS[p.kind] ?? p.kind}</span>
                  <span className={`chip ${p.status === "pending" ? "chip-warn" : "chip-dim"}`}>
                    {p.status === "pending" ? "待审核" : p.status === "accepted" ? "已接受" : "已忽略"}
                  </span>
                  <span className="proposal-meta">
                    发起 {p.initiated_by_name ?? "Agent"} · {new Date(p.created_at).toLocaleString("zh-CN", { hour12: false })}
                    {p.status !== "pending" && p.reviewed_by_name ? ` · 审核 ${p.reviewed_by_name}` : ""}
                  </span>
                </div>
                {name && (
                  <div className="proposal-name">
                    建议名称：<strong>{name}</strong>
                    {typeKey && <span className="proposal-meta"> · 类型提示 {typeKey}</span>}
                  </div>
                )}
                {p.kind === "asset_registration" && (name || typeKey) && (
                  <div className="proposal-diff">
                    <button onClick={() => void toggleDiff(p)}>{diffOpen[p.id] ? "收起对比" : "与现有资产对比"}</button>
                    {diffOpen[p.id] && (
                      <div style={{ marginTop: 6 }}>
                        {diffErr[p.id] && <div className="error-text">{diffErr[p.id]}</div>}
                        {diffData[p.id] === undefined && <div className="state">加载对比…</div>}
                        {diffData[p.id] === null && (() => {
                          const similar = name
                            ? assets.filter((a) => a.name !== name && (a.name.includes(name) || name.includes(a.name))).slice(0, 5)
                            : [];
                          return (
                            <div className="proposal-note">
                              ✓ 无同名资产，可按提案预填登记。
                              {similar.length > 0 && <span> 名称相近：{similar.map((a) => a.name).join("、")}</span>}
                            </div>
                          );
                        })()}
                        {diffData[p.id] && (() => {
                          const d = diffData[p.id]!;
                          const NAME_KEYS = ["name", "assetName", "title", "asset_name"];
                          const TYPE_KEYS = ["typeKey", "type_key", "type", "suggestedType", "assetType"];
                          const propKeys = [...new Set([
                            ...Object.keys(payload).filter((k) => !NAME_KEYS.includes(k) && !TYPE_KEYS.includes(k)),
                            ...Object.keys(d.headProps),
                          ])];
                          const show = (v: unknown): string =>
                            v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);
                          return (
                            <div>
                              <div className="proposal-note">
                                ⚠ 已存在同名资产：{d.name}（{d.type_key} · {d.lifecycle === "archived" ? "已归档" : "在用"}）——接受提案不会写入，请注意是否重复登记。
                              </div>
                              <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
                                <li key="__type">
                                  类型：提案 {show(typeKey)} · 现有 {show(d.type_key)} {typeKey === d.type_key ? "✓" : "⚠"}
                                </li>
                                {propKeys.map((k) => {
                                  const pvs = show(payload[k]);
                                  const evs = show(d.headProps[k]);
                                  return (
                                    <li key={k}>
                                      {k}：提案 {pvs} · 现有 {evs} {pvs === evs ? "✓" : "⚠"}
                                    </li>
                                  );
                                })}
                              </ul>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                )}
                {typeof reviewInfo.note === "string" && reviewInfo.note && (
                  <div className="proposal-note">审核备注：{reviewInfo.note}</div>
                )}
                <details className="proposal-raw">
                  <summary>提案内容（JSON）</summary>
                  <pre className="proposal-payload">{JSON.stringify(payload, null, 2).slice(0, 1200)}</pre>
                </details>
                <details className="proposal-raw">
                  <summary>来源运行指令</summary>
                  <div className="proposal-note">{p.run_prompt?.slice(0, 300) || "—"}</div>
                </details>
                {p.status === "pending" && (
                  <div className="btn-row">
                    {p.kind === "asset_registration" && (name || typeKey) && onPrefillRegister && (
                      <button onClick={() => onPrefillRegister({ name: name ?? undefined, typeKeyHint: typeKey ?? undefined })}>
                        按提案预填登记…
                      </button>
                    )}
                    <button className="primary" onClick={() => void review(p, "accepted")}>接受</button>
                    <button onClick={() => void review(p, "rejected")}>忽略</button>
                  </div>
                )}
                {rowErrors[p.id] && <div className="error-text">{rowErrors[p.id]}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {rows === null && !error && <div className="state">正在加载提案…</div>}
    </div>
  );
}
