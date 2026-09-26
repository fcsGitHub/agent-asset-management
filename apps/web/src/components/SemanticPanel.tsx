// 语义候选工作台：真实抽取（规则基线 + 可选 LLM 增强）→ 人工映射端点资产 → 确认断言。
// 候选永远是候选；确认只能由人完成（确认 = 既有 POST /relations confirm:true，
// domain/range 与成环禁止由服务端强制执行，违规如实回显）。
// worker 不可达 / LLM 降级均如实展示，不伪造候选。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { refreshBadges } from "../lib/badges";
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
interface QueueItem {
  id: string;
  relation_type: string;
  source_text: string;
  target_text: string;
  evidence_segment: string;
  confidence: number;
  llm_proposed: boolean;
  extractor_version: string;
  status: string;
  created_at: string;
  created_by_name: string | null;
  asset_name: string | null;
}
interface CandidateDetail {
  id: string;
  asset_id: string;
  revision_id: string | null;
  relation_type: string;
  source_text: string; source_start: number; source_end: number;
  target_text: string; target_start: number; target_end: number;
  evidence_segment: string;
  confidence: number;
  llm_proposed: boolean;
  extractor_version: string;
  status: string;
  created_at: string;
  created_by_name: string | null;
  decided_at: string | null;
  decided_by_name: string | null;
  resolved_relation_id: string | null;
  asset_name: string | null;
  resolved_type_key: string | null;
  resolved_type_version: string | null;
}
interface BatchResult { candidateId: string; ok: boolean; relationId?: string; code?: string; message?: string }
// 入队预演（M23）：服务端同源判定结果 + 原样待提交载荷（确认时提交与预览完全一致的候选）
interface ImportCandidate {
  relationType: string;
  sourceText: string; sourceStart: number; sourceEnd: number;
  targetText: string; targetStart: number; targetEnd: number;
  evidenceSegment: string;
  confidence: number;
  llmProposed: boolean;
  extractorVersion: string;
}
interface ImportPreview {
  candidates: ImportCandidate[];
  total: number;
  wouldImport: number;
  duplicates: Array<{ index: number; reason: "queue" | "batch"; relationType: string; sourceText: string; targetText: string }>;
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.message}${err.details ? `：${JSON.stringify(err.details).slice(0, 200)}` : ""}`;
  }
  return err instanceof Error ? err.message : "操作失败";
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
  // 团队审核队列（跨会话持久化，0020）
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [qMapping, setQMapping] = useState<Record<string, { source: string; target: string }>>({});
  const [qErrors, setQErrors] = useState<Record<string, string>>({});
  const [importCount, setImportCount] = useState<number | null>(null);
  const [importSkipped, setImportSkipped] = useState<number | null>(null);
  // 入队预演（M23）：先服务端预演去重，确认后才真实入队
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  // 批审（M18）：勾选 + 批量确认/忽略；详情展开按需拉取
  const [qSel, setQSel] = useState<Record<string, boolean>>({});
  const [qBusy, setQBusy] = useState(false);
  const [qDetailOpen, setQDetailOpen] = useState<Record<string, boolean>>({});
  const [qDetail, setQDetail] = useState<Record<string, CandidateDetail | null>>({});
  // 队列视图（M19）：待审（可批审）/ 已确认 / 已忽略
  const [qStatus, setQStatus] = useState<"pending" | "confirmed" | "dismissed">("pending");
  // 回导（M28）：解析导出件（items 数组，未知字段由服务端白名单丢弃）→ reimport → 如实回执
  async function onReimportFile(file: File) {
    if (!project) return;
    setReimportBusy(true);
    setReimportMsg("");
    try {
      let payload: Record<string, unknown>;
      if (/\.csv$/i.test(file.name)) {
        // CSV 回导件（M29）：服务端宽容解析（BOM/#说明行/转义引号）
        payload = { teamId: project.teamId, csv: await file.text() };
      } else {
        const parsed = JSON.parse(await file.text()) as { items?: unknown };
        if (!Array.isArray(parsed.items) || parsed.items.length === 0) {
          throw new Error("文件格式不正确：缺少非空 items 数组");
        }
        payload = { teamId: project.teamId, items: parsed.items };
      }
      const r = await api<{ imported: number; skipped: number; unresolvedIndexes: number[] }>(
        "/semantic/candidates/reimport",
        { method: "POST", body: payload },
      );
      setReimportMsg(
        `回导完成：入队 ${r.imported} 条，跳过重复 ${r.skipped} 条` +
        (r.unresolvedIndexes.length ? `，无法定位来源资产 ${r.unresolvedIndexes.length} 条` : ""),
      );
      loadQueue();
    } catch (err) {
      setReimportMsg(err instanceof ApiError ? errorText(err) : `回导失败：${err instanceof Error ? err.message : "文件解析失败"}`);
    } finally {
      setReimportBusy(false);
    }
  }

  // 队列导出（M27）：导出当前视图状态的候选（服务端盖章 semantic.queue.export，动态页可见）
  async function exportQueue(format: "csv" | "json") {
    if (!project) return;
    try {
      const qs = new URLSearchParams({ teamId: project.teamId, status: qStatus, format });
      const res = await fetch(`/api/v1/semantic/candidates/export?${qs}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `taw-queue-${qStatus}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setQErrors((prev) => ({ ...prev, __export: err instanceof Error ? err.message : "导出失败" }));
    }
  }

  // 批量重映射（M25）：为已选候选统一设置 source/target 端点（空侧不改），仅改映射不自动确认
  const [bulkSource, setBulkSource] = useState("");
  const [bulkTarget, setBulkTarget] = useState("");
  const [bulkMsg, setBulkMsg] = useState("");
  // 回导（M28）：从导出件 JSON 回入队列（幂等：确认/待审跳过、已忽略放行）
  const reimportInputRef = useRef<HTMLInputElement>(null);
  const [reimportBusy, setReimportBusy] = useState(false);
  const [reimportMsg, setReimportMsg] = useState("");

  const loadQueue = useCallback(() => {
    if (!project) return;
    void api<QueueItem[]>("/semantic/candidates", { query: { teamId: project.teamId, status: qStatus } })
      .then((rows) => {
        setQueue(rows);
        // 队列即徽标数据源：每次载入（含确认/忽略/入队后的重载）同步顶栏待办计数
        refreshBadges();
        if (qStatus !== "pending") return;
        // 按资产名自动预映射（可改选）
        setQMapping((prev) => {
          const next = { ...prev };
          for (const item of rows) {
            if (next[item.id]?.source && next[item.id]?.target) continue;
            next[item.id] = {
              source: next[item.id]?.source || matchAsset(assets, item.source_text),
              target: next[item.id]?.target || matchAsset(assets, item.target_text),
            };
          }
          return next;
        });
      })
      .catch(() => setQueue([]));
  }, [project, assets, qStatus]);

  useEffect(loadQueue, [loadQueue]);

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
    setPreview(null); setImportCount(null);
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
      setRowErrors((prev) => ({ ...prev, [i]: errorText(err) }));
    }
  }

  // 把本次抽取的候选存入团队审核队列（跨会话，其他成员可见可审）。
  // 两步（M23）：先服务端预演去重（与真实入队同源判定），确认后才真实入队。
  function buildCandidates(): ImportCandidate[] {
    if (!result) return [];
    return result.candidate_relations.map((c) => ({
      relationType: c.type,
      sourceText: c.source.text, sourceStart: c.source.start ?? 0, sourceEnd: c.source.end ?? 0,
      targetText: c.target.text, targetStart: c.target.start ?? 0, targetEnd: c.target.end ?? 0,
      evidenceSegment: c.evidence?.segment ?? "",
      confidence: c.confidence ?? 0,
      llmProposed: !!c.llm_proposed,
      extractorVersion: result.extractor_version,
    }));
  }

  async function previewImport() {
    if (!project || !result || !assetId) return;
    setError("");
    setPreviewBusy(true);
    try {
      const candidates = buildCandidates();
      const r = await api<{ total: number; wouldImport: number; duplicates: ImportPreview["duplicates"] }>(
        "/semantic/candidates/import/preview",
        {
          method: "POST",
          body: { teamId: project.teamId, assetId, revisionId: headRevision || undefined, candidates },
        },
      );
      setPreview({ candidates, total: r.total, wouldImport: r.wouldImport, duplicates: r.duplicates });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setPreviewBusy(false);
    }
  }

  async function confirmImport() {
    if (!project || !preview) return;
    setError("");
    try {
      const r = await api<{ imported: number; skipped: number }>("/semantic/candidates/import", {
        method: "POST",
        body: {
          teamId: project.teamId, assetId, revisionId: headRevision || undefined,
          candidates: preview.candidates,
        },
      });
      setImportCount(r.imported);
      setImportSkipped(r.skipped);
      setPreview(null);
      loadQueue();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function confirmQueue(item: QueueItem) {
    if (!project) return;
    const m = qMapping[item.id];
    if (!m?.source || !m?.target) return;
    setQErrors((prev) => ({ ...prev, [item.id]: "" }));
    try {
      await api(`/semantic/candidates/${item.id}/confirm`, {
        method: "POST",
        body: { teamId: project.teamId, sourceAssetId: m.source, targetAssetId: m.target },
      });
      loadQueue();
    } catch (err) {
      // 违规（domain/range、成环、未注册类型等）如实回显，候选保持待审
      setQErrors((prev) => ({ ...prev, [item.id]: errorText(err) }));
    }
  }

  async function dismissQueue(item: QueueItem) {
    if (!project) return;
    try {
      await api(`/semantic/candidates/${item.id}/dismiss`, { method: "POST", body: { teamId: project.teamId } });
      loadQueue();
    } catch (err) {
      setQErrors((prev) => ({ ...prev, [item.id]: errorText(err) }));
    }
  }

  // 批量重映射（M25）：已选候选统一设置端点——常见场景是 N 条候选共享同一 source/target 资产，
  // 逐条下拉太繁琐。空侧表示"该侧不改"；只改映射，确认仍走既有逐条/批量路径与全部校验
  function applyBulkMapping() {
    if (!queue) return;
    const ids = queue.filter((q) => qSel[q.id]).map((q) => q.id);
    if (ids.length === 0 || (!bulkSource && !bulkTarget)) return;
    setQMapping((prev) => {
      const next = { ...prev };
      for (const id of ids) {
        next[id] = { source: bulkSource || prev[id]?.source || "", target: bulkTarget || prev[id]?.target || "" };
      }
      return next;
    });
    setBulkMsg(`已为 ${ids.length} 条已选候选设置端点（仅改映射，不自动确认）`);
    setBulkSource("");
    setBulkTarget("");
  }

  // 批量确认：未映射端点的勾选项不送审、行内如实提示；其余逐条送批，逐条回执
  async function batchConfirmSelected() {
    if (!project || !queue) return;
    const ids = queue.filter((q) => qSel[q.id]).map((q) => q.id);
    if (ids.length === 0) return;
    const items: Array<{ candidateId: string; sourceAssetId: string; targetAssetId: string }> = [];
    const missing: string[] = [];
    for (const id of ids) {
      const m = qMapping[id];
      if (m?.source && m?.target) items.push({ candidateId: id, sourceAssetId: m.source, targetAssetId: m.target });
      else missing.push(id);
    }
    setQErrors((prev) => {
      const next = { ...prev };
      for (const id of ids) next[id] = "";
      for (const id of missing) next[id] = "未映射端点资产，未纳入批量确认";
      return next;
    });
    if (items.length === 0) return;
    setQBusy(true);
    try {
      const r = await api<{ confirmed: number; results: BatchResult[] }>("/semantic/candidates/batch-confirm", {
        method: "POST",
        body: { teamId: project.teamId, items },
      });
      setQErrors((prev) => {
        const next = { ...prev };
        for (const res of r.results) {
          if (!res.ok) next[res.candidateId] = `${res.code ?? "INTERNAL"}：${res.message ?? "确认失败"}`;
        }
        return next;
      });
      setQSel({});
      setBulkMsg("");
      loadQueue();
    } catch (err) {
      setQErrors((prev) => ({ ...prev, [items[0]!.candidateId]: errorText(err) }));
    } finally {
      setQBusy(false);
    }
  }

  // 批量忽略：勾选项整批送审，已处理条目由服务端逐条如实回执
  async function batchDismissSelected() {
    if (!project || !queue) return;
    const ids = queue.filter((q) => qSel[q.id]).map((q) => q.id);
    if (ids.length === 0) return;
    setQBusy(true);
    try {
      const r = await api<{ dismissed: number; results: BatchResult[] }>("/semantic/candidates/batch-dismiss", {
        method: "POST",
        body: { teamId: project.teamId, candidateIds: ids },
      });
      setQErrors((prev) => {
        const next: Record<string, string> = {};
        for (const res of r.results) {
          if (!res.ok) next[res.candidateId] = `${res.code ?? "INTERNAL"}：忽略失败`;
        }
        return next;
      });
      setQSel({});
      loadQueue();
    } catch (err) {
      setQErrors((prev) => ({ ...prev, [ids[0]!]: errorText(err) }));
    } finally {
      setQBusy(false);
    }
  }

  async function toggleDetail(id: string) {
    const opening = !qDetailOpen[id];
    setQDetailOpen((prev) => ({ ...prev, [id]: opening }));
    if (!opening || qDetail[id]) return;
    if (!project) return;
    try {
      const d = await api<CandidateDetail>(`/semantic/candidates/${id}`, { query: { teamId: project.teamId } });
      setQDetail((prev) => ({ ...prev, [id]: d }));
    } catch (err) {
      setQDetail((prev) => ({ ...prev, [id]: null }));
      setQErrors((prev) => ({ ...prev, [id]: errorText(err) }));
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
          {candList.length > 0 && !preview && (
            <button style={{ marginLeft: 10 }} disabled={previewBusy || busy || !assetId} onClick={() => void previewImport()}>
              {previewBusy ? "预演中…" : `预览入队（${candList.length}）`}
            </button>
          )}
          {importCount !== null && (
            <span className="ok-text" style={{ marginLeft: 8 }}>
              已入队 {importCount} 条，团队成员均可审核
              {(importSkipped ?? 0) > 0 && `；跳过重复 ${importSkipped} 条（队列中已有同类型同端点的候选）`}
            </span>
          )}
        </div>
      )}
      {preview && (
        <div className="sem-batchbar" style={{ display: "block", padding: "8px 12px" }}>
          <strong>入队预演</strong>：本次将入队 <span className="ok-text">{preview.wouldImport}</span> 条
          {preview.duplicates.length > 0 && <>，跳过 <span className="error-text" style={{ display: "inline" }}>{preview.duplicates.length}</span> 条</>}
          （共 {preview.total} 条）。
          {preview.duplicates.length > 0 && (
            <ul style={{ margin: "6px 0", paddingLeft: 20 }}>
              {preview.duplicates.map((d) => (
                <li key={d.index}>
                  <span className="badge">{d.relationType}</span> {d.sourceText} → {d.targetText}
                  {" — "}
                  {d.reason === "queue" ? "队列中已有同类型同端点的候选" : "本批次内重复（前序同键条目将先入队）"}
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="primary" disabled={previewBusy} onClick={() => void confirmImport()}>
              确认入队（{preview.wouldImport}）
            </button>
            <button onClick={() => setPreview(null)}>取消</button>
            <span className="sem-conf">预演基于当前队列状态；跳过项不会重复入队</span>
          </div>
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

      {/* ---------- 团队待审核队列（持久化，跨会话/跨成员） ---------- */}
      <details className="sem-queue" open>
        <summary><h3>待审核队列{queue !== null ? `（${queue.length}）` : ""}</h3></summary>
        <p className="hint" style={{ padding: 0 }}>
          入队的候选持久保存，团队任何成员都可映射端点并确认；确认走与服务端关系断言完全相同的校验（domain/range、成环禁止），违规时候选保持待审。
        </p>
        <div className="sem-batchbar" style={{ padding: "6px 10px" }}>
          <label className="sem-check">
            视图
            <select
              aria-label="队列状态筛选"
              value={qStatus}
              onChange={(e) => { setQStatus(e.target.value as typeof qStatus); setQSel({}); setBulkMsg(""); setReimportMsg(""); }}
              style={{ marginLeft: 6 }}
            >
              <option value="pending">待审核</option>
              <option value="confirmed">已确认</option>
              <option value="dismissed">已忽略</option>
            </select>
          </label>
          {qStatus !== "pending" && <span className="sem-conf">历史视图只读；「详情」可查看决策留痕与断言去向</span>}
          <span style={{ flex: 1 }} />
          <button onClick={() => void exportQueue("csv")}>导出 CSV</button>
          <button onClick={() => void exportQueue("json")}>导出 JSON</button>
          <input
            ref={reimportInputRef}
            type="file"
            accept="application/json,.json,.csv,text/csv"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onReimportFile(f);
              e.target.value = "";
            }}
          />
          <button disabled={reimportBusy} title="选择本工作台导出的 JSON 件，已忽略的候选会重新入队待审；确认/待审的重复项自动跳过"
            onClick={() => reimportInputRef.current?.click()}>
            {reimportBusy ? "回导中…" : "回导 JSON"}
          </button>
        </div>
        {(qErrors["__export"] || reimportMsg) && (
          <div className={reimportMsg && !reimportMsg.startsWith("回导失败") ? "ok-text" : "error-text"}>
            {reimportMsg || qErrors["__export"]}
          </div>
        )}
        {queue === null && <div className="state">加载中…</div>}
        {queue !== null && queue.length === 0 && (
          <Empty
            icon="📥"
            title="这里没有候选"
            hint={qStatus === "pending" ? "抽取候选后点「存入审核队列」，或等待其他成员入队。" : "该状态下暂无历史候选。"}
          />
        )}
        {queue !== null && queue.length > 0 && qStatus === "pending" && (
          <div className="sem-batchbar">
            <label className="sem-check">
              <input
                type="checkbox"
                aria-label="全选待审候选"
                checked={queue.every((q) => qSel[q.id])}
                onChange={(e) => setQSel(Object.fromEntries(queue.map((q) => [q.id, e.target.checked])))}
              />
              全选
            </label>
            <span className="sem-conf">已选 {queue.filter((q) => qSel[q.id]).length} / {queue.length}</span>
            <select
              aria-label="批量设置 source 端点"
              value={bulkSource}
              onChange={(e) => { setBulkSource(e.target.value); setBulkMsg(""); }}
              style={{ maxWidth: 170 }}
            >
              <option value="">source 不改</option>
              {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <select
              aria-label="批量设置 target 端点"
              value={bulkTarget}
              onChange={(e) => { setBulkTarget(e.target.value); setBulkMsg(""); }}
              style={{ maxWidth: 170 }}
            >
              <option value="">target 不改</option>
              {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
            <button
              disabled={qBusy || queue.every((q) => !qSel[q.id]) || (!bulkSource && !bulkTarget)}
              onClick={applyBulkMapping}
            >
              应用到已选
            </button>
            {bulkMsg && <span className="ok-text">{bulkMsg}</span>}
            <button className="primary" disabled={qBusy || queue.every((q) => !qSel[q.id])} onClick={() => void batchConfirmSelected()}>
              {qBusy ? "处理中…" : "批量确认"}
            </button>
            <button disabled={qBusy || queue.every((q) => !qSel[q.id])} onClick={() => void batchDismissSelected()}>
              批量忽略
            </button>
            <span className="sem-conf">批量确认需先映射端点；未映射的条目会被跳过并逐行提示</span>
          </div>
        )}
        {queue !== null && queue.map((item) => {
          const m = qMapping[item.id];
          const canConfirm = !!m?.source && !!m?.target;
          const detail = qDetail[item.id];
          const detailOpen = !!qDetailOpen[item.id];
          const pendingView = qStatus === "pending";
          return (
            <div key={item.id} className="sem-cand">
              <div className="sem-cand-head">
                {pendingView && (
                  <input
                    type="checkbox"
                    aria-label={`批选 ${item.source_text}`}
                    checked={!!qSel[item.id]}
                    onChange={(e) => setQSel((prev) => ({ ...prev, [item.id]: e.target.checked }))}
                  />
                )}
                <span className="badge">{item.relation_type}</span>
                <span className="chip chip-dim">{item.llm_proposed ? "LLM 提议" : "规则"}</span>
                <span className="sem-conf">{Math.round((item.confidence ?? 0) * 100)}%</span>
                <span className="sem-conf">
                  入队 {item.created_by_name ?? "成员"} · 证据来源 {item.asset_name ?? "—"}
                </span>
              </div>
              <div className="sem-cand-endpoints">
                <span>{item.source_text}</span>
                <span className="sem-arrow">— {item.relation_type} →</span>
                <span>{item.target_text}</span>
              </div>
              {item.evidence_segment && <blockquote className="sem-evidence">…{item.evidence_segment}…</blockquote>}
              <div className="sem-map">
                {pendingView && (
                  <>
                    <select
                      aria-label={`队列 source 映射 ${item.id}`}
                      value={m?.source ?? ""}
                      onChange={(e) => setQMapping((prev) => ({ ...prev, [item.id]: { source: e.target.value, target: prev[item.id]?.target ?? "" } }))}
                    >
                      <option value="">source 映射到资产…</option>
                      {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <select
                      aria-label={`队列 target 映射 ${item.id}`}
                      value={m?.target ?? ""}
                      onChange={(e) => setQMapping((prev) => ({ ...prev, [item.id]: { source: prev[item.id]?.source ?? "", target: e.target.value } }))}
                    >
                      <option value="">target 映射到资产…</option>
                      {assetOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                    <button className="primary" disabled={!canConfirm} onClick={() => void confirmQueue(item)}>确认断言</button>
                    <button onClick={() => void dismissQueue(item)}>忽略</button>
                  </>
                )}
                <button onClick={() => void toggleDetail(item.id)}>{detailOpen ? "收起详情" : "详情"}</button>
              </div>
              {detailOpen && (
                <div className="sem-detail">
                  {!detail && <div className="state">加载详情…</div>}
                  {detail && (
                    <dl>
                      <dt>状态</dt><dd>
                        {detail.status === "pending" && "待审核"}
                        {detail.status === "confirmed" && `已确认 · 断言 ${detail.resolved_relation_id?.slice(0, 8)}…（${detail.resolved_type_key ?? "?"} v${detail.resolved_type_version ?? "?"}）`}
                        {detail.status === "dismissed" && "已忽略"}
                      </dd>
                      <dt>证据来源</dt><dd>
                        {detail.asset_id && <span className="sem-endpoint" onClick={() => onOpenAsset(detail.asset_id)}>{detail.asset_name ?? detail.asset_id.slice(0, 8)}…（点击打开）</span>}
                        {detail.revision_id && <> · 修订 {detail.revision_id.slice(0, 8)}…</>}
                      </dd>
                      <dt>原文定位</dt><dd>
                        source [{detail.source_start}, {detail.source_end}) · target [{detail.target_start}, {detail.target_end})
                      </dd>
                      <dt>抽取器</dt><dd><code>{detail.extractor_version || "—"}</code>{detail.llm_proposed ? "（LLM 提议）" : ""}</dd>
                      <dt>入队</dt><dd>{detail.created_by_name ?? "—"} · {new Date(detail.created_at).toLocaleString()}</dd>
                      <dt>决策</dt><dd>
                        {detail.status === "pending"
                          ? "待定"
                          : `${detail.decided_by_name ?? "—"} · ${detail.decided_at ? new Date(detail.decided_at).toLocaleString() : "—"}`}
                      </dd>
                    </dl>
                  )}
                </div>
              )}
              {qErrors[item.id] && <div className="error-text">{qErrors[item.id]}</div>}
            </div>
          );
        })}
      </details>
    </div>
  );
}
