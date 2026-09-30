// Agent 对话区：kimi-code desktop 风格的工作区会话。
// 左侧对话流（用户气泡 / Agent 块：头像、状态药丸、工具卡渐进展开、Markdown 正文、
// 流式光标），底部 Composer（自适应高度、Enter 发送、运行中变为停止）。
// 数据全部真实：历史来自 /sessions/:id/{messages,runs}，运行经 SSE 事件流驱动。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError } from "../api";
import { Markdown, type TextTransform } from "../lib/markdown";
import { toolAssetRefs } from "../lib/toolRefs";
import { linkifyAssets } from "../lib/linkifyAssets";
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconMessage,
  IconSend,
  IconShield,
  IconStop,
  IconX,
} from "./icons";

interface ProjectRef { teamId: string; projectId: string; name: string }
interface Msg { id: string; role: string; content: string; seq: number; created_at?: string }
interface ToolInvocation { call_id: string; name: string; args: unknown; result: unknown; status: string; error: string }
interface RunBudget { maxToolCalls?: number; maxTokens?: number }
interface RunRecord { id: string; status: string; prompt: string; result: unknown; error: string; created_at: string; used?: { toolCalls?: number; tokens?: number }; budget?: RunBudget; context_refs?: string[]; invocations: ToolInvocation[] }
interface RunToolBlock { callId: string; name: string; args: unknown; state: "running" | "ok" | "denied" | "error"; result?: unknown; error?: string; startedAt?: number; durationMs?: number }
/** 界面侧的运行视图：事件流实时更新；历史运行从 /sessions/:id/runs 重建。
 *  turn 记录当前正在流式的回合号（-1=无流式），message_delta 换回合时旧段自动收入思考过程。 */
interface RunView { id: string; status: string; prompt: string; text: string; note: string; streaming: boolean; tools: RunToolBlock[]; createdAt: string; used?: { toolCalls?: number; tokens?: number }; budget?: RunBudget; refs: string[]; thoughts: string[]; turn: number }
/** @ 引用的资产（composer 选中态） */
interface ContextRef { id: string; name: string; typeKey: string; version: string }

/** 引用条目落库/提示词共用格式：人类可读 + id 可被界面回解析（refAssetId）。 */
export const formatContextRef = (r: ContextRef): string =>
  `资产「${r.name}」(id: ${r.id}, 类型 ${r.typeKey} v${r.version})`;
const refAssetId = (ref: string): string | null =>
  ref.match(/id:\s*([0-9a-f-]{36})/)?.[1] ?? null;
const refLabel = (ref: string): string =>
  ref.match(/「([^」]+)」/)?.[1] ?? ref;

/** 运行结果两种落库形态：完成时为最终文本（string）；其他终态可能为结构化对象。 */
function resultText(res: unknown): string {
  if (typeof res === "string") return res;
  if (typeof res === "object" && res !== null && "finalText" in res) {
    return String((res as { finalText?: unknown }).finalText ?? "");
  }
  return "";
}

type TimelineItem = { kind: "msg"; msg: Msg } | { kind: "run"; run: RunView };

const displayToolName = (wire: string) => wire.replace(/__/g, ".");

/** token 计数紧凑显示：1234 → 1.2k，20000 → 20k */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n);

/** 会话时间线：用户消息（持久化）与 Agent 运行按创建顺序交织。
 *  运行在创建事务中持久化同名用户消息，故按「内容相同的下一条 user 消息」对齐；
 *  未匹配的运行（如刚创建、消息尚未刷新）追加在尾部。 */
function buildTimeline(msgs: Msg[], runs: RunView[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let ri = 0;
  for (const m of msgs) {
    items.push({ kind: "msg", msg: m });
    if (m.role === "user" && ri < runs.length && runs[ri]!.prompt === m.content) {
      items.push({ kind: "run", run: runs[ri]! });
      ri++;
    }
  }
  for (; ri < runs.length; ri++) items.push({ kind: "run", run: runs[ri]! });
  return items;
}

function toolSummary(t: RunToolBlock): string {
  const a = (t.args ?? {}) as Record<string, unknown>;
  const s = (v: unknown): string =>
    typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  switch (t.name) {
    case "asset.search": return s(a.q ?? a.query) || "检索资产";
    case "asset.getRevision": return s(a.assetName) || (s(a.assetId) ? `读取资产 ${s(a.assetId).slice(0, 8)}…` : "读取资产修订");
    case "relation.query": return s(a.assetName) || s(a.name) || "查询关系";
    case "issue.create": return s(a.title) || "创建工单";
    case "proposal.create": return s(a.title) || s(a.kind) || "提交提案";
    case "external.notify": return s(a.target) || s(a.channel) || "外部通知";
    default: {
      const first = Object.values(a).map(s).find((v) => v);
      return first ? (first.length > 60 ? `${first.slice(0, 60)}…` : first) : "";
    }
  }
}

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中", running: "运行中", completed: "已完成", blocked: "已暂停",
  cancelled: "已取消", failed: "失败", unknown_reconcile: "对账中",
};

/** 空会话引导任务（M48）：真实可执行的轻量任务，点击即发起运行。 */
const STARTER_PROMPTS = [
  "检索团队资产目录，用 Markdown 表格总结（列：名称、类型、状态）",
  "找一个缺少说明制品的资产，为它提交一条整理提案",
  "检查现有资产之间的关系，指出两处可能缺失的依赖或文档关系",
  "挑两个有间接关系的资产，用关联路径查询讲清它们是怎么连起来的（每步的关系类型）",
];

function ToolCard({ tool, onOpenAsset }: { tool: RunToolBlock; onOpenAsset?: (assetId: string) => void }) {
  const stateText =
    tool.state === "running" ? "执行中"
    : tool.state === "denied" ? "权限网关拒绝"
    : tool.state === "error" ? (tool.error ? `出错：${tool.error}` : "出错")
    : "";
  const durText = tool.durationMs != null ? ` · ${(tool.durationMs / 1000).toFixed(1)}s` : "";
  // 参数/结果里可解析出的资产引用：渲染为可点击 chips，直达工作区资产详情
  const refs = toolAssetRefs(tool);
  return (
    <details className="tool">
      <summary className="tool-head">
        <span className={`tool-state ${tool.state}`}>
          {tool.state === "running" && <span className="spin" />}
          {tool.state === "ok" && <IconCheck size={12} />}
          {tool.state === "denied" && <IconShield size={12} />}
          {tool.state === "error" && <IconX size={12} />}
        </span>
        <span className="tool-name">{tool.name}</span>
        <span className="tool-summary">{toolSummary(tool)}{stateText && ` · ${stateText}`}{durText}</span>
        <IconChevronDown size={13} className="chev" />
      </summary>
      <div className="tool-detail">
        {refs.length > 0 && (
          <>
            <div className="tool-detail-label">相关资产</div>
            <div className="refs tool-refs">
              {refs.map((r) =>
                onOpenAsset ? (
                  <button key={r.id} className="ref-chip" title={`在工作区打开 ${r.name ?? r.id}`} onClick={() => onOpenAsset(r.id)}>
                    <span className="at"><IconBox size={11} /></span>
                    <span className="ellipsis">{r.name ?? `${r.id.slice(0, 8)}…`}</span>
                  </button>
                ) : (
                  <span key={r.id} className="ref-chip static" title={r.id}>
                    <span className="at"><IconBox size={11} /></span>
                    <span className="ellipsis">{r.name ?? `${r.id.slice(0, 8)}…`}</span>
                  </span>
                )
              )}
            </div>
          </>
        )}
        <div className="tool-detail-label">参数</div>
        <pre>{JSON.stringify(tool.args, null, 2)}</pre>
        {tool.state === "ok" && tool.result != null && (
          <>
            <div className="tool-detail-label">结果</div>
            <pre>{JSON.stringify(tool.result, null, 2).slice(0, 1200)}</pre>
          </>
        )}
        {(tool.state === "error" || tool.state === "denied") && tool.error && (
          <>
            <div className="tool-detail-label">错误</div>
            <pre>{tool.error}</pre>
          </>
        )}
      </div>
    </details>
  );
}

/** 上下文引用 chips：附着于用户消息，可点击跳转到工作区资产详情（id 从引用串回解析）。 */
function RefChips({ refs, onOpenAsset }: { refs: string[]; onOpenAsset?: (id: string) => void }) {
  return (
    <div className="refs">
      {refs.map((r, i) => {
        const id = refAssetId(r);
        const label = refLabel(r);
        return id && onOpenAsset ? (
          <button key={i} className="ref-chip" title={`在工作区打开 ${label}`} onClick={() => onOpenAsset(id)}>
            <span className="at">@</span>
            <span className="ellipsis">{label}</span>
          </button>
        ) : (
          <span key={i} className="ref-chip static" title={r}>
            <span className="at">@</span>
            <span className="ellipsis">{label}</span>
          </span>
        );
      })}
    </div>
  );
}

/** 复制 Agent 回复原文（Markdown 源），悬停可见，点击后短暂反馈。 */
function CopyBtn({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="copy-btn"
      title={ok ? "已复制" : "复制 Markdown 原文"}
      aria-label={ok ? "已复制" : "复制回复"}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          window.setTimeout(() => setOk(false), 1600);
        }).catch(() => undefined);
      }}
    >
      {ok ? <IconCheck size={12} /> : <IconCopy size={12} />}
    </button>
  );
}

/** 运行用量/预算：流式期间随 usage 事件实时刷新，终态定格；预算未知时只显示绝对值。 */
function UsageMeter({ used, budget, live }: { used: { toolCalls?: number; tokens?: number }; budget?: RunBudget; live?: boolean }) {
  const tools = used.toolCalls ?? 0;
  const tokens = used.tokens ?? 0;
  const maxT = budget?.maxToolCalls;
  const maxTk = budget?.maxTokens;
  const ratio = maxTk ? Math.min(tokens / maxTk, 1) : null;
  return (
    <div className={`run-meta run-usage${live ? " live" : ""}`}>
      <span>{tools}{maxT ? `/${maxT}` : ""} 次工具调用</span>
      <span className="usage-sep">·</span>
      <span>{fmtTokens(tokens)}{maxTk ? `/${fmtTokens(maxTk)}` : ""} tokens</span>
      {ratio !== null && (
        <span
          className={`usage-bar${ratio >= 1 ? " full" : ratio >= 0.8 ? " hot" : ""}`}
          role="progressbar"
          aria-valuenow={Math.round(ratio * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          title={`token 预算使用 ${Math.round(ratio * 100)}%`}
        >
          <span className="usage-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

function RunBlock({ run, onOpenAsset, renderText }: { run: RunView; onOpenAsset?: (assetId: string) => void; renderText?: TextTransform }) {
  const time = useMemo(() => {
    const d = new Date(run.createdAt);
    return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }, [run.createdAt]);
  return (
    <div className="msg msg-agent" data-run-status={run.status}>
      <div className="agent-row">
        <span className="agent-avatar" aria-hidden="true">集</span>
        <div className="agent-body">
          <div className="agent-name">
            工作集 Agent
            <span className={`run-pill run-pill-${run.status}${run.streaming ? " live" : ""}`}>
              {run.streaming && <span className="spin" />}
              {STATUS_LABEL[run.status] ?? run.status}
            </span>
            {time && <span className="agent-time">{time}</span>}
            {run.text && <CopyBtn text={run.text} />}
          </div>
          {run.tools.length > 0 && (
            <div className="tools">
              {run.tools.map((t) => <ToolCard key={t.callId} tool={t} onOpenAsset={onOpenAsset} />)}
            </div>
          )}
          {run.thoughts.length > 0 && (
            <details className="thoughts">
              <summary>
                思考过程（{run.thoughts.length} 轮）
                <IconChevronDown size={13} className="chev" />
              </summary>
              <div className="thoughts-body">
                {run.thoughts.map((t, i) => (
                  <div key={i} className="thought-item">
                    <span className="thought-idx">#{i + 1}</span>
                    <Markdown text={t} renderText={renderText} />
                  </div>
                ))}
              </div>
            </details>
          )}
          {run.text && (
            <div className="agent-text">
              <Markdown text={run.text} renderText={renderText} />
              {run.streaming && <span className="cursor" aria-hidden="true" />}
            </div>
          )}
          {run.streaming && !run.text && (
            <div className="agent-text agent-thinking" aria-label="正在输出">
              <span className="cursor" aria-hidden="true" />
              {run.tools.some((t) => t.state === "running") ? "正在调用工具…" : "正在思考…"}
            </div>
          )}
          {run.note && (
            <div className="run-note">
              <IconAlert size={13} />
              <span>{run.note}</span>
            </div>
          )}
          {run.streaming && run.used ? (
            <UsageMeter used={run.used} budget={run.budget} live />
          ) : !run.streaming && run.used && (run.used.toolCalls || run.used.tokens) ? (
            <UsageMeter used={run.used} budget={run.budget} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AgentPane({ project, sessionId, sessionTitle, onOpenAsset, onRunStateChange, collapsed, onToggleCollapse }: {
  project?: ProjectRef; sessionId: string; sessionTitle?: string; onOpenAsset?: (assetId: string) => void;
  /** 运行状态上报（顶栏状态药丸）：有无正在流式运行的 run */
  onRunStateChange?: (running: boolean) => void;
  /** 对话区收起（M67⑥）：组件保持挂载（SSE 订阅/输入状态不断线），只换渲染成细条 */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stuck, setStuck] = useState(true);
  const [picked, setPicked] = useState<ContextRef[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [candidates, setCandidates] = useState<ContextRef[]>([]);
  // 团队资产名表（M44）：正文资产名链接化的匹配源，随项目加载
  const [assetRefs, setAssetRefs] = useState<{ id: string; name: string }[]>([]);
  // SSE 运行流连接状态：live=事件流在线；reconnecting=断线自动重连中（如实提示，不伪装）
  const [conn, setConn] = useState<"idle" | "live" | "reconnecting">("idle");
  const esRef = useRef<EventSource | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // @ 引用触发：输入末尾为 @ 或 @关键词 时检索资产（防抖 250ms，真实 /assets/search）
  const mentionMatch = text.match(/@([^@\n]*)$/);
  const mentionQuery = mentionOpen && mentionMatch ? mentionMatch[1]! : "";
  useEffect(() => {
    if (!project) return;
    void api<{ id: string; name: string }[]>("/assets/search", { query: { teamId: project.teamId, lifecycle: "all", limit: "200" } })
      .then((rows) => setAssetRefs(rows.map((r) => ({ id: r.id, name: r.name }))))
      .catch(() => setAssetRefs([]));
  }, [project]);

  // 正文资产名链接化（M44）：Markdown 纯文本叶节点经此变换，命中的资产名变可点击按钮
  const renderAssetText = useCallback((t: string, key: string): ReactNode => {
    if (!onOpenAsset || assetRefs.length === 0 || t.length < 4) return t;
    const segs = linkifyAssets(t, assetRefs);
    if (segs.every((s) => s.kind === "text")) return t;
    return segs.map((s, i) =>
      s.kind === "text" ? (
        <Fragment key={`${key}-s${i}`}>{s.text}</Fragment>
      ) : (
        <button
          key={`${key}-s${i}`}
          className="md-asset-link"
          title={`在工作区打开 ${s.name}`}
          onClick={() => onOpenAsset(s.id)}
        >
          {s.text}
        </button>
      )
    );
  }, [assetRefs, onOpenAsset]);
  useEffect(() => {
    if (!mentionOpen || !project) return;
    const t = window.setTimeout(() => {
      void api<{ id: string; name: string; type_key: string; type_version: string }[]>("/assets/search", {
        query: { teamId: project.teamId, q: mentionQuery, lifecycle: "all", limit: "8" },
      })
        .then((rows) =>
          setCandidates(rows.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => ({ id: r.id, name: r.name, typeKey: r.type_key, version: r.type_version })))
        )
        .catch(() => setCandidates([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [mentionOpen, mentionQuery, project, picked]);

  const loadHistory = useCallback((teamId: string, sid: string) => {
    void api<Msg[]>(`/sessions/${sid}/messages`, { query: { teamId } })
      .then(setMsgs)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载会话失败"));
    void api<RunRecord[]>(`/sessions/${sid}/runs`, { query: { teamId } })
      .then((rows) =>
        setRuns(
          // 端点返回 DESC 最近 20 条；时间线按创建时间升序重建（与消息 seq 同向）
          [...rows]
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
            .map((r) => ({
              id: r.id,
              status: r.status,
              prompt: r.prompt,
              createdAt: r.created_at,
              text: resultText(r.result),
              note: r.error,
              streaming: false,
              used: r.used,
              budget: r.budget,
              refs: r.context_refs ?? [],
              thoughts: [],
              turn: -1,
              tools: r.invocations.map((i) => ({
                callId: i.call_id, name: displayToolName(i.name), args: i.args,
                state: i.status === "ok" ? "ok" : i.status === "denied" ? "denied" : "error",
                result: i.result, error: i.error,
              })),
            }))
        )
      )
      .catch(() => setRuns([]));
  }, []);

  useEffect(() => {
    setMsgs(null);
    setError("");
    setRuns([]);
    setPicked([]);
    setMentionOpen(false);
    setConn("idle");
    stickRef.current = true;
    setStuck(true);
    esRef.current?.close();
    esRef.current = null;
    if (!project || !sessionId) return;
    loadHistory(project.teamId, sessionId);
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [project, sessionId, loadHistory]);

  // 贴底自动滚动：用户上翻浏览历史时不打扰（stickRef=false），回到底部恢复跟随
  const timeline = useMemo(() => buildTimeline(msgs ?? [], runs), [msgs, runs]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [timeline]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const isStuck = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = isStuck;
    setStuck(isStuck);
  };

  function openEventStream(teamId: string, runId: string) {
    const es = new EventSource(`/api/v1/runs/${runId}/events?teamId=${teamId}`);
    esRef.current = es;
    setConn("live");
    es.onopen = () => setConn("live");
    es.onerror = () => {
      // EventSource 自动按 Last-Event-ID 重连续传；CONNECTING 期间如实提示
      if (es.readyState === EventSource.CONNECTING) setConn("reconnecting");
    };
    const patch = (fn: (r: RunView) => RunView) =>
      setRuns((prev) => prev.map((r) => (r.id === runId ? fn(r) : r)));
    es.addEventListener("tool_call", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { callId: string; name: string; args: unknown };
      patch((r) => ({ ...r, tools: [...r.tools, { callId: p.callId, name: displayToolName(p.name), args: p.args, state: "running", startedAt: Date.now() }] }));
    });
    es.addEventListener("tool_result", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { callId: string; status: string; result: unknown; error: string };
      patch((r) => ({
        ...r,
        tools: r.tools.map((t) =>
          t.callId === p.callId
            ? {
                ...t,
                state: p.status === "ok" ? "ok" : p.status === "denied" ? "denied" : "error",
                result: p.result,
                error: p.error,
                durationMs: t.startedAt != null ? Date.now() - t.startedAt : undefined,
              }
            : t
        ),
      }));
    });
    // 逐字流式（M53）：内容 delta 追加；换回合时旧段收入思考过程（与 message 事件对齐）
    es.addEventListener("message_delta", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { delta: string; turn: number };
      patch((r) => ({
        ...r,
        text: p.turn !== r.turn ? p.delta : r.text + p.delta,
        thoughts: p.turn !== r.turn && r.text ? [...r.thoughts, r.text] : r.thoughts,
        turn: p.turn,
      }));
    });
    es.addEventListener("message", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { role: string; text: string };
      // 多轮运行：每轮 assistant 文本是完整一段；旧段收入「思考过程」，最新段作为正文
      if (p.role === "assistant") {
        patch((r) => ({
          ...r,
          text: p.text,
          thoughts: r.text && r.text !== p.text ? [...r.thoughts, r.text] : r.thoughts,
        }));
      }
    });
    es.addEventListener("usage", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { toolCalls: number; tokens: number; maxToolCalls: number; maxTokens: number };
      patch((r) => ({
        ...r,
        used: { toolCalls: p.toolCalls, tokens: p.tokens },
        budget: { maxToolCalls: p.maxToolCalls, maxTokens: p.maxTokens },
      }));
    });
    es.addEventListener("completed", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { finalText: string };
      patch((r) => ({
        ...r,
        text: p.finalText,
        status: "completed",
        streaming: false,
        // 终态正文与最后一轮 message 相同时不重复收入思考过程
        thoughts: r.text && r.text !== p.finalText ? [...r.thoughts, r.text] : r.thoughts,
      }));
      es.close();
      if (project) void api<Msg[]>(`/sessions/${sessionId}/messages`, { query: { teamId } }).then(setMsgs).catch(() => undefined);
    });
    es.addEventListener("blocked", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { reason: string; limit?: number };
      const why = p.reason === "budget_tool_calls" ? `工具调用达到预算上限（${p.limit}）`
        : p.reason === "budget_tokens" ? `token 达到预算上限（${p.limit}）`
        : p.reason === "max_turns" ? "运行轮数达到上限" : p.reason;
      patch((r) => ({ ...r, status: "blocked", streaming: false, note: `已暂停等待处置：${why}` }));
      es.close();
    });
    es.addEventListener("cancelled", () => {
      patch((r) => ({ ...r, status: "cancelled", streaming: false, note: "已被用户取消。" }));
      es.close();
    });
    es.addEventListener("failed", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { error: string };
      patch((r) => ({ ...r, status: "failed", streaming: false, note: `运行失败：${p.error}` }));
      es.close();
    });
    es.addEventListener("unknown_reconcile", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { tool: string; detail: string };
      patch((r) => ({ ...r, status: "unknown_reconcile", streaming: false, note: `外部副作用结果未知（${p.tool}），已进入对账，不盲目重试。` }));
      es.close();
    });
    es.addEventListener("done", () => {
      es.close();
      setConn("idle");
      if (esRef.current === es) esRef.current = null;
    });
  }

  async function send(override?: string) {
    const content = (override ?? text).trim();
    if (!project || !sessionId || !content) return;
    setSending(true);
    setError("");
    const refs = picked.map(formatContextRef);
    setText("");
    setPicked([]);
    setMentionOpen(false);
    requestAnimationFrame(autosize);
    try {
      // 真实 LLM 运行：创建运行（同事务持久化用户消息），SSE 流式接工具事件与回复
      const created = await api<{ runId: string }>(`/sessions/${sessionId}/runs`, {
        method: "POST",
        body: { teamId: project.teamId, prompt: content, contextRefs: refs },
      });
      setRuns((prev) => [...prev, { id: created.runId, status: "running", prompt: content, text: "", note: "", streaming: true, tools: [], createdAt: new Date().toISOString(), refs, thoughts: [], turn: -1 }]);
      openEventStream(project.teamId, created.runId);
      // 用户消息已在创建事务中持久化：立即刷新，让自己的气泡先出现在运行块之上
      stickRef.current = true;
      void api<Msg[]>(`/sessions/${sessionId}/messages`, { query: { teamId: project.teamId } }).then(setMsgs).catch(() => undefined);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 503 || err.code.startsWith("LLM_"))) {
        // 模型不可用：诚实降级为普通消息持久化，不伪造 Agent 回复
        try {
          await api(`/sessions/${sessionId}/messages`, { method: "POST", body: { teamId: project.teamId, role: "user", content } });
          setMsgs(await api<Msg[]>(`/sessions/${sessionId}/messages`, { query: { teamId: project.teamId } }));
          setError("模型未配置或不可用，本条已保存为普通消息（未触发 Agent）。");
        } catch {
          setError("发送失败：模型不可用且消息保存失败。");
        }
      } else {
        setError(err instanceof ApiError ? err.message : "发送失败");
      }
    } finally {
      setSending(false);
    }
  }

  async function cancelRun(runId: string) {
    if (!project) return;
    try {
      await api(`/runs/${runId}/cancel`, { method: "POST", body: { teamId: project.teamId, reason: "用户在界面取消" } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "取消失败");
    }
  }

  const autosize = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
  };

  const pickMention = (ref: ContextRef) => {
    setPicked((prev) => [...prev, ref]);
    setText((t) => t.replace(/@[^@\n]*$/, ""));
    setMentionOpen(false);
    setMentionIndex(0);
    taRef.current?.focus();
  };

  const streamingRun = runs.find((r) => r.streaming);
  const anyStreaming = !!streamingRun;
  useEffect(() => {
    onRunStateChange?.(anyStreaming);
  }, [anyStreaming, onRunStateChange]);
  // 会话级用量汇总（M46）：近 20 次运行的 tokens/工具调用合计；流式期间随 usage 事件实时跳动
  const totals = useMemo(() => {
    let tokens = 0, toolCalls = 0, counted = 0;
    for (const r of runs) {
      if (!r.used) continue;
      tokens += r.used.tokens ?? 0;
      toolCalls += r.used.toolCalls ?? 0;
      counted++;
    }
    return { tokens, toolCalls, counted };
  }, [runs]);
  const ready = !!project && !!sessionId;

  // 收起态（M67⑥）：细条 + 展开按钮；运行中如实显示流式药丸，收起不打断 SSE
  if (collapsed) {
    return (
      <aside className="agent-pane agent-pane-rail" aria-label="Agent 对话区（已收起）">
        <button
          className="rail-expand"
          title="展开对话区"
          aria-label="展开对话区"
          onClick={onToggleCollapse}
        >
          »
        </button>
        <button className="rail-tab" title={`AGENT · ${sessionTitle || project?.name || "未选择会话"}`} onClick={onToggleCollapse}>
          <span className="rail-title">AGENT</span>
        </button>
        {anyStreaming && <span className="rail-live" title="Agent 运行中（收起不打断，展开查看）" />}
      </aside>
    );
  }

  return (
    <aside className="agent-pane" aria-label="Agent 对话区">
      <div className="pane-label">
        <span className="pane-label-title">AGENT</span>
        <span className="pane-label-note ellipsis">{sessionTitle || project?.name || "未选择会话"}</span>
        {totals.counted > 0 && (
          <span className="pane-usage" title={`本会话最近 ${totals.counted} 次运行合计：${totals.tokens} tokens、${totals.toolCalls} 次工具调用（更早的运行不计入）`}>
            Σ {fmtTokens(totals.tokens)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          title="收起对话区（再点细条展开；运行与订阅不中断）"
          aria-label="收起对话区"
          onClick={onToggleCollapse}
        >
          «
        </button>
      </div>
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {msgs === null && !error && (
          <div className="state">{sessionId ? "加载会话…" : "从左侧选择一个会话。"}</div>
        )}
        {error && <div className="state error">{error}</div>}
        {msgs !== null && timeline.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon"><IconMessage size={30} /></div>
            <div className="empty-title">开始这段会话</div>
            <div className="empty-hint">
              发送任务给 Agent——真实模型执行，工具调用全程可见；也可以先在右侧工作区登记资产。
            </div>
            <div className="starter-chips" role="list" aria-label="试试这些任务">
              {STARTER_PROMPTS.map((s) => (
                <button
                  key={s}
                  className="starter-chip"
                  disabled={sending || !ready}
                  onClick={() => void send(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {timeline.map((item, idx) => {
          if (item.kind === "run") return <RunBlock key={item.run.id} run={item.run} onOpenAsset={onOpenAsset} renderText={renderAssetText} />;
          // 紧随其后且配对的运行携带来自 composer 的 @ 引用，渲染在气泡下方
          const next = timeline[idx + 1];
          const refs = next && next.kind === "run" ? next.run.refs : [];
          return (
            <div key={item.msg.id} className={`msg msg-${item.msg.role}`}>
              {item.msg.role === "user" ? (
                <>
                  <div
                    className="bubble"
                    title={item.msg.created_at ? new Date(item.msg.created_at).toLocaleString("zh-CN") : undefined}
                  >
                    {item.msg.content}
                  </div>
                  {refs.length > 0 && <RefChips refs={refs} onOpenAsset={onOpenAsset} />}
                </>
              ) : item.msg.role === "assistant" ? (
                <div className="agent-row">
                  <span className="agent-avatar" aria-hidden="true">集</span>
                  <div className="agent-body">
                    <div className="agent-name">
                      工作集 Agent
                      <CopyBtn text={item.msg.content} />
                    </div>
                    <div className="agent-text"><Markdown text={item.msg.content} renderText={renderAssetText} /></div>
                  </div>
                </div>
              ) : (
                <div className="bubble">{item.msg.content}</div>
              )}
            </div>
          );
        })}
      </div>
      {!stuck && (
        <button
          className="scroll-bottom"
          onClick={() => {
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
            stickRef.current = true;
            setStuck(true);
          }}
        >
          ↓ 回到底部
        </button>
      )}
      <div className="composer-zone">
        {conn === "reconnecting" && (
          <div className="conn-banner" role="status">
            <span className="spin" />
            连接中断，正在自动重连——事件流将按序号续传，不会丢失或重复。
          </div>
        )}
        <div className="composer">
          {mentionOpen && (
            <div className="mention-pop" role="listbox" aria-label="引用资产">
              <header>引用资产 · 加入 Agent 上下文</header>
              <div className="mention-list">
                {candidates.length === 0 && (
                  <div className="pop-note">没有匹配资产。继续输入筛选，或按 Esc 关闭。</div>
                )}
                {candidates.map((c, i) => (
                  <button
                    key={c.id}
                    role="option"
                    aria-selected={i === mentionIndex}
                    className={`mention-item${i === mentionIndex ? " hover" : ""}`}
                    onMouseEnter={() => setMentionIndex(i)}
                    onClick={() => pickMention(c)}
                  >
                    <span className="mi-icon"><IconBox size={12} /></span>
                    <span className="ellipsis">{c.name}</span>
                    <span className="ver">{c.typeKey} v{c.version}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {picked.length > 0 && (
            <div className="picked-refs">
              {picked.map((r) => (
                <span key={r.id} className="picked-ref">
                  @{r.name}
                  <span className="mono">{r.typeKey} v{r.version}</span>
                  <button
                    aria-label={`移除引用 ${r.name}`}
                    onClick={() => setPicked((prev) => prev.filter((p) => p.id !== r.id))}
                  >
                    <IconX size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            rows={1}
            placeholder={ready ? "给 Agent 派任务，@ 引用资产加入上下文…" : "先选择项目与会话"}
            aria-label="发送给 Agent 的消息"
            value={text}
            disabled={!ready}
            onChange={(e) => {
              setText(e.target.value);
              setMentionOpen(/@([^@\n]*)$/.test(e.target.value));
              setMentionIndex(0);
              requestAnimationFrame(autosize);
            }}
            onKeyDown={(e) => {
              if (mentionOpen && candidates.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % candidates.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setMentionIndex((i) => (i - 1 + candidates.length) % candidates.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickMention(candidates[mentionIndex]!);
                  return;
                }
              }
              if (e.key === "Escape" && mentionOpen) {
                e.preventDefault();
                setMentionOpen(false);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (!streamingRun && !sending) void send();
              }
            }}
          />
          <div className="composer-bar">
            <span className="composer-perm" title="Agent 仅可写工作分支草稿；发布等高权动作必须由人类执行">
              <IconShield size={11} />
              仅草稿写入权限
            </span>
            <span className="composer-hint">Enter 发送 · Shift+Enter 换行 · @ 引用资产</span>
            {streamingRun ? (
              <button
                className="send-btn stop"
                onClick={() => void cancelRun(streamingRun.id)}
                aria-label="停止运行"
              >
                <IconStop size={13} />
                停止
              </button>
            ) : (
              <button
                className="send-btn"
                onClick={() => void send()}
                disabled={sending || !text.trim() || !ready}
                aria-label="发送"
              >
                <IconSend size={14} />
                {sending ? "发送中" : "发送"}
              </button>
            )}
          </div>
        </div>
        <p className="composer-note">
          Agent 仅草稿写入权限；发布、审批、权限变更等动作始终由人类执行。
        </p>
      </div>
    </aside>
  );
}
