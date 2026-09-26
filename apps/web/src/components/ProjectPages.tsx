// 项目域页面：总览仪表盘 / 团队动态 / 审批队列。
// 数据全部来自真实端点（/projects/:id/overview、/activity、/projects/:id/change-requests），
// 布局范式吸收 AgentPM：统计卡行 → 待办 → 人机混排活动流。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../App";
import { Empty } from "./Empty";
import { CrItemCard, CrComments, type CRComment, type CRItemDiff } from "./CrDiff";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }

interface Overview {
  project: { name: string; code: string; status: string };
  projectScope: {
    branches: { open: number; total: number };
    changeRequests: { open: number; awaitingReview: number; changesRequested: number; merged: number };
    releases: { total: number; last30d: number };
  };
  teamScope: {
    assets: { active: number; archived: number };
    revisions: number;
    relations: { confirmed: number; proposed: number };
  };
}

interface ActivityItem {
  key?: string;
  ts: string;
  kind: "audit" | "agent";
  action: string;
  summary: string;
  actor: string;
  objectId: string | null;
  project?: string;
}

// 历史分页游标：页尾条目的（精确时间戳, kind, id），由服务端签发、原样回传
interface ActivityCursor { before: string; beforeKind: string; beforeId: string }

interface CRRow { id: string; title: string; status: string; created_at: string; created_by_name: string; branch_name: string; item_count: number }
interface IssueRow { id: string; title: string; status: string; created_at: string; asset_name: string | null }
interface CRDetail {
  id: string; title: string; status: string; branch_name: string; created_by_name: string;
  motivation: string; items: { asset_id: string; asset_name: string; base_seq: number; candidate_seq: number; diff?: CRItemDiff }[];
  snapshots: { id: string; candidate_digest: string; review_digest: string; channel: string; superseded: boolean; created_at: string }[];
  comments: CRComment[];
}

export function fmtTime(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleString("zh-CN", { hour12: false });
}

const STATUS_LABELS: Record<string, string> = {
  draft: "草稿", open: "待准备", awaiting_review: "待审核", changes_requested: "已退回",
  merged: "已合并", withdrawn: "已撤回", completed: "完成", failed: "失败", cancelled: "已取消",
  queued: "排队中", running: "运行中", blocked: "受阻",
};

const ISSUE_STATUS_LABELS: Record<string, string> = {
  open: "待处理", in_progress: "处理中", resolved: "已解决", closed: "已关闭",
};

function statusChip(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function StatCard({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: "warn" | "ok" }) {
  return (
    <div className={`stat-card${tone ? ` stat-${tone}` : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// 审计条目详情（M27）：治理回执原文（detail jsonb）按需拉取后的展示结构
export interface AuditEntryDetail {
  id: string;
  action: string;
  object_kind: string;
  object_id: string | null;
  detail: Record<string, unknown> | null;
  project_name: string | null;
  created_at: string;
  actor: string | null;
}

function ActivityList({ items, compact, auditDetail, onAuditToggle }: {
  items: ActivityItem[];
  compact?: boolean;
  /** 动态页（非 compact）注入：审计条目展开详情的加载态/内容 */
  auditDetail?: Record<string, { loading: boolean; data: AuditEntryDetail | null; error?: string }>;
  onAuditToggle?: (item: ActivityItem) => void;
}) {
  if (items.length === 0) {
    return <Empty icon="🕒" title="还没有动态" hint="治理动作（归档/发布/回滚）和 Agent 运行会出现在这里。" />;
  }
  return (
    <ul className="activity-feed">
      {items.map((it, i) => {
        const open = !compact && it.kind === "audit" && it.key !== undefined && !!auditDetail?.[it.key];
        const d = open && it.key ? auditDetail?.[it.key] : undefined;
        return (
          <li key={`${it.ts}-${i}`} className="activity-item">
            <span className="activity-icon" aria-hidden="true">{it.kind === "agent" ? "🤖" : "👤"}</span>
            <span className="activity-body">
              <span className="activity-actor">{it.actor}</span>
              <span
                className="activity-text"
                role={it.kind === "audit" && !compact && onAuditToggle ? "button" : undefined}
                style={it.kind === "audit" && !compact && onAuditToggle ? { cursor: "pointer" } : undefined}
                onClick={it.kind === "audit" && !compact && onAuditToggle ? () => onAuditToggle(it) : undefined}
                title={it.kind === "audit" && !compact && onAuditToggle ? "点击查看回执原文" : undefined}
              >
                {it.kind === "agent" ? "Agent 运行" : ""}{it.kind === "agent" && it.project ? `（${it.project}）` : it.kind === "agent" ? "" : " "}{it.summary}
              </span>
              {it.kind === "agent" && <span className="chip">{statusChip(it.action.replace("agent.run.", ""))}</span>}
              {it.kind === "audit" && <span className="chip chip-dim">{it.action}</span>}
            </span>
            {!compact && <span className="activity-time">{fmtTime(it.ts)}</span>}
            {open && (
              <div className="audit-detail" style={{ marginTop: 6, paddingLeft: 12, borderLeft: "2px solid var(--muted)", width: "100%" }}>
                {d?.loading && <div className="state">加载回执原文…</div>}
                {d?.error && <div className="error-text">{d.error}</div>}
                {d?.data && (
                  <>
                    <div className="proposal-meta">
                      {d.data.action} · {d.data.actor ?? "系统"} · {fmtTime(d.data.created_at)}
                      {d.data.project_name ? ` · ${d.data.project_name}` : ""}
                      {d.data.object_kind ? ` · ${d.data.object_kind}` : ""}
                      {d.data.object_id ? ` · ${d.data.object_id.slice(0, 8)}…` : ""}
                    </div>
                    <pre className="proposal-payload" style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>
                      {d.data.detail ? JSON.stringify(d.data.detail, null, 2).slice(0, 1500) : "（无回执正文）"}
                    </pre>
                  </>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** 总览仪表盘：统计卡 + 待审核 CR + 近况。 */
export function DashboardPage({
  project,
  me,
  onNavigate,
}: {
  project?: ProjectInfo;
  me: Me;
  onNavigate: (page: "activity" | "approvals" | "workbench") => void;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<ActivityItem[] | null>(null);
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    if (!project) return;
    setError("");
    void api<Overview>(`/projects/${project.projectId}/overview`, { query: { teamId: project.teamId } })
      .then(setOverview)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载总览失败"));
    void api<{ items: ActivityItem[] }>("/activity", { query: { teamId: project.teamId, limit: "8" } })
      .then((r) => setActivity(r.items))
      .catch(() => setActivity([]));
    void api<IssueRow[]>(`/projects/${project.projectId}/issues`, { query: { teamId: project.teamId } })
      .then(setIssues)
      .catch(() => setIssues([]));
  }, [project]);

  useEffect(reload, [reload]);

  if (!project) {
    return <Empty icon="🗂" title="选择或创建一个项目" hint="总览仪表盘按项目展示分支、审核与发布进度。" />;
  }
  const role = me.teams.find((t) => t.teamId === project.teamId)?.role ?? "member";
  const pendingReviews = overview ? overview.projectScope.changeRequests.awaitingReview + overview.projectScope.changeRequests.changesRequested : 0;

  return (
    <div className="page">
      <div className="page-head">
        <h2>{project.name} · 总览</h2>
        <span className="chip chip-dim">{role === "admin" ? "团队管理员" : "成员"}</span>
        <button onClick={reload}>刷新</button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {overview && (
        <>
          <div className="stat-grid">
            <StatCard label="开放分支" value={overview.projectScope.branches.open} sub={`共 ${overview.projectScope.branches.total} 个`} />
            <StatCard
              label="待审核 CR"
              value={pendingReviews}
              sub={`${overview.projectScope.changeRequests.awaitingReview} 待审 / ${overview.projectScope.changeRequests.changesRequested} 已退回`}
              tone={pendingReviews > 0 ? "warn" : "ok"}
            />
            <StatCard label="发布（近 30 天）" value={overview.projectScope.releases.last30d} sub={`累计 ${overview.projectScope.releases.total} 次`} />
            <StatCard label="团队资产" value={overview.teamScope.assets.active} sub={`归档 ${overview.teamScope.assets.archived}`} />
            <StatCard label="修订总数" value={overview.teamScope.revisions} />
            <StatCard label="已确认关系" value={overview.teamScope.relations.confirmed} sub={`待定 ${overview.teamScope.relations.proposed}`} />
          </div>
          <div className="page-columns">
            <section className="card">
              <div className="card-head">
                <h3>待处理审核</h3>
                <button onClick={() => onNavigate("approvals")}>查看全部 →</button>
              </div>
              {pendingReviews === 0 ? (
                <Empty icon="✅" title="没有待处理的审核" hint="所有变更请求都已处理完毕。" />
              ) : (
                <p className="hint">
                  有 {pendingReviews} 个变更请求等待处理（待审核 / 已退回）。到审批页查看详情，
                  或直接进入发布流程准备快照并发布。
                </p>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h3>最近动态</h3>
                <button onClick={() => onNavigate("activity")}>查看全部 →</button>
              </div>
              {activity && <ActivityList items={activity} compact />}
            </section>
          </div>
          <div className="page-columns">
            <section className="card">
              <h3>最近问题</h3>
              {issues === null ? (
                <div className="state">加载中…</div>
              ) : issues.length === 0 ? (
                <Empty icon="🗒" title="还没有问题工单" hint="在对话区让 Agent 建 Issue，或在 ⌘K 里说「报告问题：<标题>」。" />
              ) : (
                <ul className="issue-list">
                  {issues.slice(0, 5).map((i) => (
                    <li key={i.id} className="issue-row">
                      <span className={`chip chip-${i.status === "open" ? "warn" : "dim"}`}>{ISSUE_STATUS_LABELS[i.status] ?? i.status}</span>
                      <span className="issue-title">{i.title}</span>
                      {i.asset_name && <span className="issue-asset">· {i.asset_name}</span>}
                      <span className="issue-time">{fmtTime(i.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card">
              <h3>快捷入口</h3>
              <div className="btn-row">
                <button onClick={() => onNavigate("workbench")}>打开工作台</button>
                <button onClick={() => onNavigate("approvals")}>审批队列</button>
                <button onClick={() => onNavigate("activity")}>团队动态</button>
              </div>
              <p className="hint">提示：Ctrl/⌘+K 可随时搜索资产并跳转；按 ? 查看全部快捷键。</p>
            </section>
          </div>
        </>
      )}
      {!overview && !error && <div className="state">正在加载总览…</div>}
    </div>
  );
}

/** 团队动态：人的治理动作 + Agent 运行（人机混排时间线）。
 *  实时推送：SSE 订阅 /activity/stream（Postgres NOTIFY 触发，非轮询），
 *  事件按 key 去重覆盖（Agent 运行状态变化原地更新），断线重连后整体重取对齐。
 *  项目过滤：项目级动作（审核准备/发布/回滚/Agent 运行）按项目显示；
 *  团队级动作（资产归档/恢复等）仅在"全部项目"视图出现。
 *  action 过滤（M24）：历史与翻页由服务端同源过滤，实时推送事件由客户端按同一口径守护。 */
export function ActivityPage({
  project,
  projects,
  onOpenAsset,
  presetAction,
}: {
  project?: ProjectInfo;
  projects?: ProjectInfo[];
  onOpenAsset: (assetId: string) => void;
  /** NL「看归档记录」等意图预置的 action 过滤（M26）；仅注入状态，用户仍可自由改选 */
  presetAction?: { action: string; nonce: number } | null;
}) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const [filterProjectId, setFilterProjectId] = useState("");
  // action 过滤（M24）："" 不过滤；"agent" 仅 Agent 运行；其余按审计动作精确匹配。
  // 选项由服务端 /activity 响应同源下发（与服务端标签一致，不硬编码副本）。
  const [actionFilter, setActionFilter] = useState("");
  const [actionOptions, setActionOptions] = useState<Array<{ value: string; label: string }>>([]);
  // 操作者过滤（M30）：按团队成员精确筛选其审计动作与运行；选项同源下发
  const [actorId, setActorId] = useState("");
  const [actorOptions, setActorOptions] = useState<Array<{ id: string; label: string }>>([]);
  // 时间范围（M26）：闭区间 [since, until]，datetime-local 值（分钟精度），空 = 不约束该侧
  const [sinceLocal, setSinceLocal] = useState("");
  const [untilLocal, setUntilLocal] = useState("");
  const [live, setLive] = useState(false);

  // NL 意图注入的 action 过滤预设（M26）：nonce 变化即应用（同值可重复触发）
  useEffect(() => {
    if (presetAction?.action) setActionFilter(presetAction.action);
  }, [presetAction]);

  // datetime-local 是浏览器本地时间；无时区后缀的文本会被 DB 按其自身时区解释而错位。
  // 显式转换为带 Z 的 UTC 时间戳，保证"用户所见即过滤范围"（M26 修复）
  const toApiTs = (v: string): string => {
    if (!v) return v;
    if (v.length === 16) v = `${v}:00`;
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
  };
  const limitRef = useRef(limit);
  limitRef.current = limit;
  // 历史分页游标（M20）：页尾（精确时间戳, kind, id）；null = 没有更早的历史
  const [next, setNext] = useState<ActivityCursor | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // 请求时序守卫（M26 修复）：过滤条件变化（含 NL 预置注入）会立刻触发新请求，
  // 慢到的旧响应不得覆盖新结果（真实缺陷：无过滤首请求后到，混入未过滤条目）
  const fetchSeqRef = useRef(0);
  // 审计条目详情（M27）：按需拉取治理回执原文（key = "audit:<id>"）
  const [auditDetail, setAuditDetail] = useState<Record<string, { loading: boolean; data: AuditEntryDetail | null; error?: string }>>({});

  const applyItems = useCallback((incoming: ActivityItem[], append: boolean) => {
    setItems((prev) => {
      if (!append) return incoming;
      const seen = new Set((prev ?? []).map((x) => x.key));
      return [...(prev ?? []), ...incoming.filter((x) => x.key && !seen.has(x.key))];
    });
  }, []);

  const fetchPage = useCallback(async (cursor: ActivityCursor | null): Promise<ActivityCursor | null> => {
    if (!project) return null;
    const seq = ++fetchSeqRef.current;
    const query: Record<string, string> = { teamId: project.teamId, limit: String(limitRef.current) };
    if (filterProjectId) query.projectId = filterProjectId;
    if (actionFilter) query.action = actionFilter;
    if (actorId) query.actorId = actorId;
    if (sinceLocal) query.since = toApiTs(sinceLocal);
    if (untilLocal) query.until = toApiTs(untilLocal);
    if (cursor) {
      query.before = cursor.before;
      query.beforeKind = cursor.beforeKind;
      query.beforeId = cursor.beforeId;
    }
    const r = await api<{ items: ActivityItem[]; next: ActivityCursor | null; actions?: Array<{ value: string; label: string }>; actors?: Array<{ id: string; label: string }> }>("/activity", { query });
    if (seq !== fetchSeqRef.current) return null; // 过期响应：不渲染、不更新游标
    if (r.actions) setActionOptions(r.actions);
    if (r.actors) setActorOptions(r.actors);
    applyItems(r.items, !!cursor);
    setNext(r.next); // 游标由本函数统一管理：只有最新请求才能推进/回收「加载更早」
    return r.next;
  }, [project, filterProjectId, actionFilter, actorId, sinceLocal, untilLocal, applyItems]);

  const reload = useCallback(() => {
    if (!project) return;
    setError("");
    void fetchPage(null)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载动态失败"));
  }, [project, fetchPage]);

  useEffect(reload, [reload]);

  const loadOlder = useCallback(() => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    void fetchPage(next)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载更早动态失败"))
      .finally(() => setLoadingMore(false));
  }, [next, loadingMore, fetchPage]);

  // 审计导出：服务端以与列表相同的分页查询全量遍历（含当前项目与 action 过滤），
  // 时间正序写出；csv（BOM）或 json（结构化 + 截断标志）由服务端序列化
  async function exportAs(format: "csv" | "json") {
    if (!project) return;
    setError("");
    try {
      const qs = new URLSearchParams({ teamId: project.teamId });
      if (filterProjectId) qs.set("projectId", filterProjectId);
      if (actionFilter) qs.set("action", actionFilter);
      if (actorId) qs.set("actorId", actorId);
      if (sinceLocal) qs.set("since", toApiTs(sinceLocal));
      if (untilLocal) qs.set("until", toApiTs(untilLocal));
      qs.set("format", format);
      const res = await fetch(`/api/v1/activity/export?${qs}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `taw-audit-${project.teamId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "导出失败");
    }
  }

  // 展开/收起审计条目详情：首开时拉取一次，收起即移除（再开重新展示缓存或重拉）
  async function toggleAuditDetail(it: ActivityItem) {
    if (!project || !it.key) return;
    const key = it.key;
    if (auditDetail[key]) {
      setAuditDetail((prev) => { const n = { ...prev }; delete n[key]; return n; });
      return;
    }
    setAuditDetail((prev) => ({ ...prev, [key]: { loading: true, data: null } }));
    try {
      const d = await api<AuditEntryDetail>(`/activity/audit/${key.slice("audit:".length)}`, { query: { teamId: project.teamId } });
      setAuditDetail((prev) => ({ ...prev, [key]: { loading: false, data: d } }));
    } catch (err) {
      setAuditDetail((prev) => ({ ...prev, [key]: { loading: false, data: null, error: err instanceof ApiError ? err.message : "加载回执原文失败" } }));
    }
  }

  // 实时流：连接期间新事件由服务端推送；断线重连成功后整体刷新对齐（流本身只推实时事件）。
  // action 过滤在客户端同步生效：不属于当前过滤的实时事件不插入视图（历史翻页由服务端过滤）。
  useEffect(() => {
    setLive(false);
    if (!project) return;
    const qs = new URLSearchParams({ teamId: project.teamId });
    if (filterProjectId) qs.set("projectId", filterProjectId);
    const es = new EventSource(`/api/v1/activity/stream?${qs}`);
    es.addEventListener("activity", (e) => {
      const item = JSON.parse((e as MessageEvent).data) as ActivityItem;
      if (!item.key) return;
      if (actionFilter === "agent" && item.kind !== "agent") return;
      if (actionFilter && actionFilter !== "agent" && item.action !== actionFilter) return;
      if (actorId) {
        const label = actorOptions.find((o) => o.id === actorId)?.label;
        if (label && item.actor !== label) return;
      }
      setItems((prev) => {
        const list = prev ?? [];
        const idx = list.findIndex((x) => x.key === item.key);
        if (idx >= 0) {
          const next = [...list];
          next[idx] = { ...next[idx]!, ...item };
          return next;
        }
        return [item, ...list].slice(0, limitRef.current);
      });
    });
    // 服务端 LISTEN 断链重连后的补齐信号：断窗内的事件不会补推，整体重取对齐
    es.addEventListener("resync", () => { reload(); });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [project, filterProjectId, actionFilter, actorId, actorOptions, reload]);

  // 重连成功（live 由 false→true 且已有历史）时重取一次对齐
  const firstLive = useRef(true);
  useEffect(() => {
    if (live && !firstLive.current) reload();
    if (live) firstLive.current = false;
  }, [live, reload]);

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="动态按团队展示，选择项目后加载。" />;
  return (
    <div className="page">
      <div className="page-head">
        <h2>团队动态</h2>
        <span className={`chip ${live ? "chip-live" : "chip-dim"}`} title={live ? "Postgres 触发器实时推送" : "实时流未连接，显示历史"}>
          {live ? "● 实时" : "○ 未连接"}
        </span>
        <select
          aria-label="按项目过滤"
          value={filterProjectId}
          onChange={(e) => setFilterProjectId(e.target.value)}
          title="项目级动作按项目显示；团队级动作仅在全部视图出现"
        >
          <option value="">全部项目（团队视图）</option>
          {(projects ?? []).filter((p) => p.teamId === project?.teamId).map((p) => (
            <option key={p.projectId} value={p.projectId}>{p.name}</option>
          ))}
        </select>
        <select aria-label="按 action 类型过滤" value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}
          title="按动作类型过滤历史；实时新事件同样遵循当前过滤">
          <option value="">全部动作</option>
          {actionOptions.map((o) => (
            <option key={o.value} value={o.value}>{o.value === "agent" ? `${o.label}（全部状态）` : `${o.label}（${o.value}）`}</option>
          ))}
        </select>
        <select aria-label="按操作者过滤" value={actorId} onChange={(e) => setActorId(e.target.value)}
          title="只看该成员的治理动作与 Agent 运行">
          <option value="">全部操作者</option>
          {actorOptions.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <input
          type="datetime-local"
          aria-label="开始时间"
          title="只看此时间之后的动态（含）"
          value={sinceLocal}
          onChange={(e) => setSinceLocal(e.target.value)}
          style={{ maxWidth: 190 }}
        />
        <input
          type="datetime-local"
          aria-label="结束时间"
          title="只看此时间之前的动态（含）"
          value={untilLocal}
          onChange={(e) => setUntilLocal(e.target.value)}
          style={{ maxWidth: 190 }}
        />
        {(sinceLocal || untilLocal) && (
          <button title="清除时间范围" onClick={() => { setSinceLocal(""); setUntilLocal(""); }}>清除时间</button>
        )}
        <select aria-label="条数" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={20}>最近 20 条</option>
          <option value={50}>最近 50 条</option>
          <option value={100}>最近 100 条</option>
        </select>
        <button onClick={reload}>刷新</button>
        <button
          title={filterProjectId ? "导出当前项目过滤下的全部历史（CSV）" : "导出团队全部历史（CSV）"}
          onClick={() => void exportAs("csv")}
        >
          导出 CSV
        </button>
        <button
          title={filterProjectId ? "导出当前过滤范围的结构化历史（JSON）" : "导出团队全部历史的结构化 JSON"}
          onClick={() => void exportAs("json")}
        >
          导出 JSON
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {items && <ActivityList items={items} auditDetail={auditDetail} onAuditToggle={(it) => void toggleAuditDetail(it)} />}
      {!items && !error && <div className="state">正在加载…</div>}
      {next && (
        <div className="btn-row" style={{ justifyContent: "center" }}>
          <button disabled={loadingMore} onClick={loadOlder}>{loadingMore ? "加载中…" : "加载更早"}</button>
        </div>
      )}
      {items !== null && !next && items.length > 0 && (
        <p className="hint" style={{ textAlign: "center" }}>已加载全部动态。</p>
      )}
      <p className="hint">点击动态中的资产类条目可在工作台打开资产。👤 为人的治理动作（审计），🤖 为 Agent 运行；流式更新由数据库触发器推送。</p>
    </div>
  );
}

/** 审批队列：项目下待处理的 CR（待审核 / 已退回 / 待准备），详情只读，发布动作留在发布流程。 */
export function ApprovalsPage({ project, onOpenRelease }: { project?: ProjectInfo; onOpenRelease: () => void }) {
  const [crs, setCrs] = useState<CRRow[] | null>(null);
  const [detail, setDetail] = useState<CRDetail | null>(null);
  const [error, setError] = useState("");

  const reload = useCallback(() => {
    if (!project) return;
    void api<CRRow[]>(`/projects/${project.projectId}/change-requests`, { query: { teamId: project.teamId } })
      .then(setCrs)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载变更请求失败"));
  }, [project]);

  useEffect(reload, [reload]);
  useEffect(() => setDetail(null), [project]);

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="审批队列按项目展示待处理的变更请求。" />;
  const pending = (crs ?? []).filter((c) => ["open", "awaiting_review", "changes_requested"].includes(c.status));

  return (
    <div className="page">
      <div className="page-head">
        <h2>审批队列</h2>
        <span className="chip chip-dim">{pending.length} 个待处理</span>
        <button onClick={reload}>刷新</button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {crs && pending.length === 0 && (
        <Empty icon="✅" title="没有待处理的变更请求" hint="新 CR 创建后会出现在这里。" />
      )}
      {pending.length > 0 && (
        <div className="split">
          <ul className="cr-list">
            {pending.map((c) => (
              <li key={c.id}>
                <button
                  className={`cr-row${detail?.id === c.id ? " active" : ""}`}
                  onClick={() => {
                    setError("");
                    void api<CRDetail>(`/change-requests/${c.id}`, { query: { teamId: project.teamId } })
                      .then(setDetail)
                      .catch((e) => setError(e instanceof ApiError ? e.message : "加载 CR 失败"));
                  }}
                >
                  <span className="cr-title">{c.title}</span>
                  <span className={`chip chip-${c.status === "awaiting_review" ? "warn" : c.status === "changes_requested" ? "dan" : "dim"}`}>
                    {statusChip(c.status)}
                  </span>
                  <span className="cr-meta">{c.branch_name} · {c.item_count} 项 · {c.created_by_name}</span>
                </button>
              </li>
            ))}
          </ul>
          {detail && (
            <section className="card cr-detail">
              <h3>{detail.title}</h3>
              <div className="kv">
                <span className="k">状态</span><span><span className={`chip chip-${detail.status === "awaiting_review" ? "warn" : "dim"}`}>{statusChip(detail.status)}</span></span>
                <span className="k">分支</span><span>{detail.branch_name}</span>
                <span className="k">发起人</span><span>{detail.created_by_name}</span>
              </div>
              <h4>动机</h4>
              <p className="prewrap">{detail.motivation || "（未填写）"}</p>
              <h4>变更项（{detail.items.length}）</h4>
              <div className="cr-items">
                {detail.items.map((it) => <CrItemCard key={it.asset_id} item={it} />)}
              </div>
              <h4>审核快照</h4>
              {detail.snapshots.length === 0 ? (
                <p className="hint">尚未生成审核快照。进入发布流程生成后再发布。</p>
              ) : (
                <ul>
                  {detail.snapshots.map((s) => (
                    <li key={s.id}>
                      {s.channel} 通道 · 摘要 {s.review_digest.slice(0, 12)}…{s.superseded ? "（已被新快照取代）" : ""}
                    </li>
                  ))}
                </ul>
              )}
              {detail.comments.length > 0 && (
                <>
                  <h4>评审留痕（{detail.comments.length}）</h4>
                  <CrComments comments={detail.comments} />
                </>
              )}
              <div className="btn-row">
                <button className="primary" onClick={onOpenRelease}>进入发布流程处理 →</button>
              </div>
            </section>
          )}
        </div>
      )}
      {!crs && !error && <div className="state">正在加载…</div>}
    </div>
  );
}
