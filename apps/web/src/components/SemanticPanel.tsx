// 语义候选工作台：真实抽取（规则基线 + 可选 LLM 增强）→ 人工映射端点资产 → 确认断言。
// 候选永远是候选；确认只能由人完成（确认 = 既有 POST /relations confirm:true，
// domain/range 与成环禁止由服务端强制执行，违规如实回显）。
// worker 不可达 / LLM 降级均如实展示，不伪造候选。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import { Empty } from "./Empty";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string; head_revision_id: string }
interface RelTypeInfo { id: string; type_key: string; version: string; title: string; source_type_keys: string[]; target_type_keys: string[] }

interface CandidateRelation {
  type: string;
  source: { text: string; start: number; end: number };
  target: { text: string; start: number; end: number };
  confidence: number;
  evidence: { segment: string; matched_pattern: string | null };
  status: string;
  llm_proposed?: boolean;
}
interface ExtractResult {
  candidate_relations: CandidateRelation[];
  evidence_anchors: { text: string; label: string; start: number; end: number }[];
  warnings: string[];
  extractor_version: string;
}

/** 候选端点文本 → 团队资产名精确匹配（自动预选）；否则留空由人工选择。 */
function matchAsset(assets: AssetRow[], text: string): string {
  const hit = assets.find((a) => a.name === text) ?? assets.find((a) => a.name.includes(text) || text.includes(a.name));
  return hit?.id ?? "";
}

export function SemanticPanel({ project, onOpenAsset }: { project?: ProjectInfo; onOpenAsset: (assetId: string) => void }) {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [relTypes, setRelTypes] = useState<RelTypeInfo[]>([]);
  const [assetId, setAssetId] = useState("");
  const [text, setText] = useState("");
  const [hints, setHints] = useState("");
  const [enhanceLlm, setEnhanceLlm] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExtractResult | null>(null);
  // 每个候选的确认状态：mapping 记录人工选择的端点；asserted/dismissed 记录终态
  const [mapping, setMapping] = useState<Record<number, { source: string; target: string }>>({});
  const [asserted, setAsserted] = useState<Record<number, string>>({});
  const [dismissed, setDismissed] = useState<Record<number, boolean>>({});
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!project) return;
    void api<AssetRow[]>("/assets/search", { query: { teamId: project.teamId, lifecycle: "all", limit: "200" } })
      .then(setAssets)
      .catch(() => setAssets([]));
    void api<RelTypeInfo[]>("/relation-types", { query: { teamId: project.teamId } })
      .then(setRelTypes)
      .catch(() => setRelTypes([]));
  }, [project]);

  // 关系类型 key → 该 key 的最新版本（列表按 type_key, version 排序，取同 key 最后一个）
  const rtByKey = useMemo(() => {
    const m = new Map<string, RelTypeInfo>();
    for (const r of relTypes) {
      const cur = m.get(r.type_key);
      if (!cur || cur.version < r.version) m.set(r.type_key, r);
    }
    return m;
  }, [relTypes]);

  const asset = assets.find((a) => a.id === assetId);
  const headRevision = asset?.head_revision_id ?? "";

  const extract = useCallback(async () => {
    if (!project || !assetId || !headRevision || !text.trim()) return;
    setBusy(true); setError(""); setResult(null);
    setMapping({}); setAsserted({}); setDismissed({}); setRowErrors({});
    try {
      const entityHints = hints.split(/[,，\n]+/).map((s) => s.trim()).filter(Boolean)
        .map((t) => ({ text: t.slice(0, 100) }));
      const r = await api<ExtractResult>("/semantic/extract", {
        method: "POST",
        body: {
          teamId: project.teamId,
          revisionRef: `${project.teamId}/${assetId}/${headRevision}`,
          text: text.slice(0, 60000),
          entityHints,
          enhanceLlm,
        },
      });
      setResult(r);
      // 预选：端点文本能唯一对应团队资产名时自动填入（仍可修改）
      const pre: Record<number, { source: string; target: string }> = {};
      r.candidate_relations.forEach((c, i) => {
        const s = matchAsset(assets, c.source.text);
        const t = matchAsset(assets, c.target.text);
        if (s || t) pre[i] = { source: s, target: t };
      });
      setMapping(pre);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "抽取失败");
    } finally {
      setBusy(false);
    }
  }, [project, assetId, headRevision, text, hints, enhanceLlm, assets]);

  async function confirmAssertion(i: number, cand: CandidateRelation) {
    if (!project) return;
    const rt = rtByKey.get(cand.type);
    const m = mapping[i];
    if (!rt || !m?.source || !m?.target) return;
    setRowErrors((prev) => ({ ...prev, [i]: "" }));
    try {
      const res = await api<{ relationId: string }>("/relations", {
        method: "POST",
        body: { teamId: project.teamId, relationTypeVersionId: rt.id, sourceAssetId: m.source, targetAssetId: m.target, confirm: true },
      });
      setAsserted((prev) => ({ ...prev, [i]: res.relationId }));
    } catch (err) {
      setRowErrors((prev) => ({ ...prev, [i]: err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details).slice(0, 200)}` : ""}` : "断言失败" }));
    }
  }

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="语义候选按团队资产上下文抽取与确认。" />;

  const setMap = (i: number, side: "source" | "target", value: string) => {
    setMapping((prev) => ({ ...prev, [i]: { source: prev[i]?.source ?? "", target: prev[i]?.target ?? "", [side]: value } }));
  };

  const assetOptions = [...assets].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  const candList = result?.candidate_relations ?? [];

  return (
    <div className="card">
      <h3>语义候选工作台</h3>
      <p className="hint" style={{ padding: 0 }}>
        粘贴一段与资产相关的文本，抽取候选关系（规则基线，可选 LLM 增强）；候选必须经人工映射到真实资产并确认，才会成为正式关系断言。
      </p>
      <div className="field">
        <label>来源资产（候选证据锚定到其最新修订）</label>
        <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
          <option value="">选择资产…</option>
          {assetOptions.map((a) => (
            <option key={a.id} value={a.id}>{a.name}（{a.type_key}{a.lifecycle === "archived" ? " · 已归档" : ""}）</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>待分析文本</label>
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：「轨道传播模型说明书」依赖于「推进模块接口文档」定义的推力接口…" />
      </div>
      <div className="field" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input style={{ flex: 1 }} value={hints} onChange={(e) => setHints(e.target.value)} placeholder="实体提示（逗号分隔，可选）" />
        <label className="sem-check">
          <input type="checkbox" checked={enhanceLlm} onChange={(e) => setEnhanceLlm(e.target.checked)} />
          LLM 增强（真实 DeepSeek）
        </label>
        <button className="primary" disabled={busy || !assetId || !text.trim()} onClick={() => void extract()}>
          {busy ? "抽取中…" : "抽取候选"}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {result && result.warnings.length > 0 && (
        <div className="sem-warnings">
          {result.warnings.map((w, i) => <div key={i} className="error-text">⚠ {w}</div>)}
        </div>
      )}
      {result && (
        <div className="sem-meta">
          抽取器 <code>{result.extractor_version}</code> · 候选关系 {candList.length} 条 · 证据锚点 {result.evidence_anchors.length} 个
        </div>
      )}
      {candList.map((c, i) => {
        const rt = rtByKey.get(c.type);
        const m = mapping[i];
        const canConfirm = !!rt && !!m?.source && !!m?.target;
        const done = asserted[i];
        if (dismissed[i]) return null;
        return (
          <div key={`${c.type}-${c.source.start}-${i}`} className={`sem-cand${done ? " sem-cand-done" : ""}`}>
            <div className="sem-cand-head">
              <span className="badge">{c.type}</span>
              <span className="chip chip-dim">{c.llm_proposed ? "LLM 提议" : "规则"}</span>
              <span className="sem-conf">{Math.round((c.confidence ?? 0) * 100)}%</span>
              {done && <span className="chip chip-ok">✓ 已断言（{done.slice(0, 8)}…）</span>}
              {!rt && <span className="chip chip-warn">关系类型 {c.type} 未注册，需先在本体治理台登记</span>}
            </div>
            <div className="sem-cand-endpoints">
              <span className="sem-endpoint" onClick={() => m?.source && onOpenAsset(m.source)} title={m?.source ? "打开资产" : undefined}>
                {c.source.text}
              </span>
              <span className="sem-arrow">— {c.type} →</span>
              <span className="sem-endpoint" onClick={() => m?.target && onOpenAsset(m.target)} title={m?.target ? "打开资产" : undefined}>
                {c.target.text}
              </span>
            </div>
            {c.evidence?.segment && (
              <blockquote className="sem-evidence">…{c.evidence.segment}…</blockquote>
            )}
            {!done && (
              <div className="sem-map">
                <select aria-label="source 映射资产" value={m?.source ?? ""} onChange={(e) => setMap(i, "source", e.target.value)}>
                  <option value="">source 映射到资产…</option>
                  {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <select aria-label="target 映射资产" value={m?.target ?? ""} onChange={(e) => setMap(i, "target", e.target.value)}>
                  <option value="">target 映射到资产…</option>
                  {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <button className="primary" disabled={!canConfirm} onClick={() => void confirmAssertion(i, c)}>确认断言</button>
                <button onClick={() => setDismissed((prev) => ({ ...prev, [i]: true }))}>忽略</button>
              </div>
            )}
            {rowErrors[i] && <div className="error-text">{rowErrors[i]}</div>}
          </div>
        );
      })}
      {result && candList.length === 0 && (
        <Empty icon="⛓" title="没有抽出候选关系" hint="文本中需要出现至少两个实体提示（或已知实体名）以及可识别的关系模式。" />
      )}
    </div>
  );
}
