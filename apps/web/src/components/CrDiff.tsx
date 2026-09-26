// CR 冻结差异组件（M43 引入、M45 抽共享）：发布与通道 / 审批队列 两处 CR 详情复用。
// diff 由 GET /change-requests/:id 逐项携带（绑定 CR 固化的 base/candidate 修订）。
import { IconChevronDown } from "./icons";

export interface CRDiffProp { key: string; kind: "added" | "changed" | "removed"; from?: unknown; to?: unknown }
export interface CRDiffArtifact { role: string; name: string; fromDigest?: string; toDigest?: string; binary: boolean; conflict: boolean; textPatch?: { type: "context" | "add" | "del"; line: string }[] }
export interface CRItemDiff { properties: CRDiffProp[]; artifacts: CRDiffArtifact[]; relations: { added: { typeKey: string; target: string }[]; removed: { typeKey: string; target: string }[] } }
export interface CRDiffItem { asset_id: string; asset_name: string; base_seq: number; candidate_seq: number; diff?: CRItemDiff }
export interface CRComment { id: string; content: string; created_at: string; author_name: string | null }

/** 评审留痕（M47）：退回原因等 CR 评论按时间排列；无留痕时如实不渲染（调用方判空）。 */
export function CrComments({ comments }: { comments: CRComment[] }) {
  return (
    <div className="cr-comments">
      {comments.map((c) => (
        <div key={c.id} className="cr-comment">
          <div className="cr-comment-meta">
            <span className="cr-comment-author">{c.author_name ?? "成员"}</span>
            <span className="cr-comment-time">{new Date(c.created_at).toLocaleString("zh-CN")}</span>
          </div>
          <div className="cr-comment-body">{c.content}</div>
        </div>
      ))}
    </div>
  );
}

/** 单项差异明细：属性逐字段 + 制品（文本行补丁/二进制摘要）+ 关系增减。 */
export function CrItemDiffView({ diff }: { diff: CRItemDiff }) {
  const fmt = (v: unknown): string => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > 90 ? `${s.slice(0, 90)}…` : s;
  };
  const relCount = diff.relations.added.length + diff.relations.removed.length;
  const empty = diff.properties.length === 0 && diff.artifacts.length === 0 && relCount === 0;
  if (empty) return <div className="state">内容无变化。</div>;
  return (
    <div className="cr-diff">
      {diff.properties.length > 0 && (
        <div className="cr-diff-sec">
          <div className="cr-diff-label">属性变更（{diff.properties.length}）</div>
          {diff.properties.map((p) => (
            <div key={p.key} className={`diff-line ${p.kind}`}>
              <span className="diff-sign">{p.kind === "added" ? "+" : p.kind === "removed" ? "−" : "~"}</span>
              <code className="diff-key">{p.key}</code>
              <span className="diff-val">
                {p.kind === "added" && `= ${fmt(p.to)}`}
                {p.kind === "removed" && `= ${fmt(p.from)}`}
                {p.kind === "changed" && `${fmt(p.from)} → ${fmt(p.to)}`}
              </span>
            </div>
          ))}
        </div>
      )}
      {diff.artifacts.length > 0 && (
        <div className="cr-diff-sec">
          <div className="cr-diff-label">制品（{diff.artifacts.length}）</div>
          {diff.artifacts.map((a, i) => (
            <div key={`${a.role}:${a.name}:${i}`} className="cr-diff-art">
              <div className={`diff-line ${!a.fromDigest ? "added" : !a.toDigest ? "removed" : "changed"}`}>
                <span className="diff-sign">{!a.fromDigest ? "+" : !a.toDigest ? "−" : "~"}</span>
                <span className="diff-key">{a.name}</span>
                <span className="diff-val">
                  {a.role}
                  {a.binary ? " · 二进制" : ""}
                  {a.conflict ? " · 双侧同改（冲突需人工裁决）" : ""}
                  {a.fromDigest && a.toDigest && a.fromDigest !== a.toDigest
                    ? ` · 摘要 ${a.fromDigest.slice(0, 8)}… → ${a.toDigest.slice(0, 8)}…` : ""}
                </span>
              </div>
              {a.textPatch && a.textPatch.length > 0 && (
                <pre className="diff-patch">
                  {a.textPatch.slice(0, 60).map((l, j) => (
                    <span key={j} className={`diff-line ${l.type === "add" ? "added" : l.type === "del" ? "removed" : "ctx"}`}>
                      {l.type === "add" ? "+ " : l.type === "del" ? "− " : "  "}{l.line}{"\n"}
                    </span>
                  ))}
                  {a.textPatch.length > 60 && (
                    <span className="diff-line ctx">  … 还有 {a.textPatch.length - 60} 行未显示{"\n"}</span>
                  )}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
      {relCount > 0 && (
        <div className="cr-diff-sec">
          <div className="cr-diff-label">关系（{relCount}）</div>
          {diff.relations.added.map((r, i) => (
            <div key={`a-${r.typeKey}-${r.target}-${i}`} className="diff-line added">
              <span className="diff-sign">+</span>
              <span className="diff-val">{r.typeKey} → {r.target}</span>
            </div>
          ))}
          {diff.relations.removed.map((r, i) => (
            <div key={`r-${r.typeKey}-${r.target}-${i}`} className="diff-line removed">
              <span className="diff-sign">−</span>
              <span className="diff-val">{r.typeKey} → {r.target}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 变更项卡片：汇总行（资产名 / r_base→r_cand / 差异计数）+ 展开差异明细。 */
export function CrItemCard({ item }: { item: CRDiffItem }) {
  const relN = item.diff ? item.diff.relations.added.length + item.diff.relations.removed.length : 0;
  const propN = item.diff?.properties.length ?? 0;
  const artN = item.diff?.artifacts.length ?? 0;
  const changeN = propN + artN + relN;
  return (
    <details className="cr-item">
      <summary>
        <span className="cr-item-name">{item.asset_name}</span>
        <span className="cr-item-revs">r{item.base_seq} → r{item.candidate_seq}</span>
        {item.diff && (
          <span className={`cr-item-counts${changeN === 0 ? " dim" : ""}`}>
            {changeN === 0
              ? "无变化"
              : [
                  propN > 0 ? `属性 ${propN}` : "",
                  artN > 0 ? `制品 ${artN}` : "",
                  relN > 0 ? `关系 ${relN}` : "",
                ].filter(Boolean).join(" · ")}
          </span>
        )}
        <IconChevronDown size={13} className="chev" />
      </summary>
      {item.diff
        ? <CrItemDiffView diff={item.diff} />
        : <div className="state">该 CR 的修订数据过旧，无法计算差异。</div>}
    </details>
  );
}
