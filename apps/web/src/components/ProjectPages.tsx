// 项目域页面：总览仪表盘 / 团队动态 / 审批队列。
// 数据全部来自真实端点（/projects/:id/overview、/activity、/projects/:id/change-requests），
// 布局范式吸收 AgentPM：统计卡行 → 待办 → 人机混排活动流。
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../App";
import { Empty } from "./Empty";

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

interface CRRow { id: string; title: string; status: string; created_at: string; created_by_name: string; branch_name: string; item_count: number }
interface IssueRow { id: string; title: string; status: string; created_at: string; asset_name: string | null }
interface CRDetail {
  id: string; title: string; status: string; branch_name: string; created_by_name: string;
  motivation: string; items: { asset_id: string; asset_name: string; base_seq: number; candidate_seq: number }[];
  snapshots: { id: string; candidate_digest: string; review_digest: string; channel: string; superseded: boolean; created_at: string }[];
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

function ActivityList({ items, compact }: { items: ActivityItem[]; compact?: boolean }) {
  if (items.length === 0) {
    return <Empty icon="🕒" title="还没有动态" hint="治理动作（归档/发布/回滚）和 Agent 运行会出现在这里。" />;
  }
  return (
    <ul className="activity-feed">
      {items.map((it, i) => (
        <li key={`${it.ts}-${i}`} className="activity-item">
          <span className="activity-icon" aria-hidden="true">{it.kind === "agent" ? "🤖" : "👤"}</span>
          <span className="activity-body">
            <span className="activity-actor">{it.actor}</span>
            <span className="activity-text">
              {it.kind === "agent" ? "Agent 运行" : ""}{it.kind === "agent" && it.project ? `（${it.project}）` : it.kind === "agent" ? "" : " "}{it.summary}
            </span>
            {it.kind === "agent" && <span className="chip">{statusChip(it.action.replace("agent.run.", ""))}</span>}
            {it.kind === "audit" && <span className="chip chip-dim">{it.action}</span>}
          </span>
          {!compact && <span className="activity-time">{fmtTime(it.ts)}</span>}
        </li>
      ))}
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
 *  团队级动作（资产归档/恢复等）仅在"全部项目"视图出现。 */
export function ActivityPage({
  project,
  projects,
  onOpenAsset,
}: {
  project?: ProjectInfo;
  projects?: ProjectInfo[];
  onOpenAsset: (assetId: string) => void;
}) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(50);
  const [filterProjectId, setFilterProjectId] = useState("");
  const [live, setLive] = useState(false);
  const limitRef = useRef(limit);
  limitRef.current = limit;

  const reload = useCallback(() => {
    if (!project) return;
    const query: Record<string, string> = { teamId: project.teamId, limit: String(limitRef.current) };
    if (filterProjectId) query.projectId = filterProjectId;
    void api<{ items: ActivityItem[] }>("/activity", { query })
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载动态失败"));
  }, [project, filterProjectId]);

  useEffect(reload, [reload]);

  // 实时流：连接期间新事件由服务端推送；断线重连成功后整体刷新对齐（流本身只推实时事件）
  useEffect(() => {
    setLive(false);
    if (!project) return;
    const qs = new URLSearchParams({ teamId: project.teamId });
    if (filterProjectId) qs.set("projectId", filterProjectId);
    const es = new EventSource(`/api/v1/activity/stream?${qs}`);
    es.addEventListener("activity", (e) => {
      const item = JSON.parse((e as MessageEvent).data) as ActivityItem;
      if (!item.key) return;
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
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    return () => es.close();
  }, [project, filterProjectId]);

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
        <select aria-label="条数" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          <option value={20}>最近 20 条</option>
          <option value={50}>最近 50 条</option>
          <option value={100}>最近 100 条</option>
        </select>
        <button onClick={reload}>刷新</button>
      </div>
      {error && <div className="error-text">{error}</div>}
      {items && <ActivityList items={items} />}
      {!items && !error && <div className="state">正在加载…</div>}
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
              <ul>
                {detail.items.map((it) => (
                  <li key={it.asset_id}>{it.asset_name}（修订 {it.base_seq} → {it.candidate_seq}）</li>
                ))}
              </ul>
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
