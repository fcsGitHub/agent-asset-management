import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, ApiError, uploadFile } from "../api";
import { refreshBadges } from "../lib/badges";
import type { Me } from "../App";
import { DashboardPage, ActivityPage, ApprovalsPage } from "../components/ProjectPages";
import { RelationGraph } from "../components/RelationGraph";
import { OntologyPage } from "../components/OntologyPage";
import { NeighborhoodCard } from "../components/NeighborhoodCard";
import { SemanticPanel } from "../components/SemanticPanel";
import { AgentProposals } from "../components/AgentProposals";
import { AgentPane } from "../components/AgentPane";
import { CommandBar, type NlIntentPayload } from "../components/CommandBar";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay";
import {
  IconActivity, IconAlert, IconArchive, IconBoard, IconBox, IconCheck, IconChevronRight, IconGraph, IconGrid,
  IconLayers, IconLock, IconMenu, IconMessage, IconMonitor, IconMoon, IconPencil, IconPlus,
  IconRefresh, IconSearch, IconSun,
} from "../components/icons";
import { CrItemCard, CrComments, type CRComment, type CRItemDiff } from "../components/CrDiff";
import { createGoPrefixHandler, isTypingTarget, type PageKey } from "../lib/shortcuts";
import { TYPE_FAMILIES } from "../lib/typeFamily";
import {
  chainRequiresTestEvidence, checkFormValues, formValuesToProperties,
  propertiesToFormValues, schemaToFormSpec,
} from "@taw/domain/schema-form";
import { SchemaFields, chainFromTypes, type TypeRow } from "../components/SchemaForm";
import { formatPropFilters, parsePropFilters } from "@taw/domain/prop-filter";

type ThemeMode = "auto" | "light" | "dark";
const THEME_LABEL: Record<ThemeMode, string> = { auto: "跟随系统", light: "浅色", dark: "深色" };

function useTheme(): [ThemeMode, () => void] {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    const t = localStorage.getItem("taw-theme");
    return t === "light" || t === "dark" ? t : "auto";
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    localStorage.setItem("taw-theme", theme);
  }, [theme]);
  const cycle = useCallback(
    () => setTheme((t) => (t === "auto" ? "light" : t === "light" ? "dark" : "auto")),
    []
  );
  return [theme, cycle];
}

const RAIL_PAGES: { key: PageKey; label: string; icon: ReactNode }[] = [
  { key: "dashboard", label: "总览", icon: <IconGrid size={17} /> },
  { key: "workbench", label: "工作台", icon: <IconBoard size={17} /> },
  { key: "activity", label: "动态", icon: <IconActivity size={17} /> },
  { key: "approvals", label: "审批", icon: <IconCheck size={17} /> },
  { key: "graph", label: "图谱", icon: <IconGraph size={17} /> },
  { key: "ontology", label: "本体", icon: <IconLayers size={17} /> },
];

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface SessionInfo { sessionId: string; title: string; visibility: string; mine: boolean; archived: boolean }
interface Msg { id: string; role: string; content: string; seq: number }
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string; head_revision_id: string; content_digest: string; has_artifacts?: boolean; relation_count?: number; completenessScore?: number; matched_alias?: string | null; pinned?: boolean }
interface AssetFacets { typeKeys: string[]; labels: { label: string; count: number }[]; categories: string[]; propertyKeys?: { key: string; count: number }[] }
// 本体树节点（M71②，GET /ontology/tree）：closureAssetCount = 选该类型做类闭包过滤的
// 真实命中资产数（自身 + 全部子类）；subclassKeys 供「已展开」提示如实列出。
interface OntologyTreeNode {
  key: string; title: string; version: string; parentKey: string | null;
  assetCount: number; closureAssetCount: number; subclassKeys: string[];
  propertyKeys: string[]; requiredKeys: string[]; requiresTestEvidence: boolean;
  children: OntologyTreeNode[];
}
interface TypeInfo {
  id: string; type_key: string; version: string; title: string;
  parent_type_key?: string | null; parent_version?: string | null;
  requires_test_evidence?: boolean;
  unit_vocabularies?: Record<string, string[]>;
  json_schema: {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: string[]; title?: string; minimum?: number; maximum?: number }>;
    additionalProperties?: boolean;
  };
}
interface AssetDetail {
  id: string; name: string; lifecycle: string; type_key: string; type_version: string;
  revisions: { id: string; seq: number; content_digest: string; properties: object; created_at: string; artifacts?: { blob_digest: string; artifact_role: string; original_name: string; media_type: string; size: number }[] }[];
  labels: string[]; categories: { category_path: string; is_primary: boolean }[];
  aliases?: string[];
  usage?: { download: number; copy_ref: number; agent_read: number };
  completeness?: { score: number; checks: { key: string; title: string; passed: boolean; detail: string; hint: string; weight: number }[] };
  lineageRefs?: { field: string; refs: string[] }[];
  pinned?: boolean;
  // 弃用元数据（M70）：标记时间/原因/继任者——详情横幅与 Agent 告警的数据源
  deprecatedAt?: string | null;
  deprecationNote?: string | null;
  successor?: { id: string; name: string; lifecycle: string } | null;
}
interface Relations { outgoing: RelRow[]; incoming: RelRow[] }
interface RelRow { id: string; type_key: string; status: string; source_name: string; target_name: string; source_asset_id?: string; target_asset_id?: string; source_lifecycle?: string; target_lifecycle?: string }

/** 字节人性化显示（制品大小）。 */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** http(s) 绝对地址判定（属性值直链，M53 吸收 NetBox Custom Links 思路的轻量形态）。 */
function isHttpUrl(v: string): boolean {
  return /^https?:\/\/\S+$/.test(v);
}

const LIFECYCLE_LABEL: Record<string, string> = { archived: "已归档", deprecated: "已弃用", active: "进行中" };

/** 资产详情「复制引用」按钮（M54，吸收 HF Hub「Use this model」/ Dataverse 引用格式思想）：
 * 一键复制规范引用串（与 Agent @ 引用同格式），粘贴进会话/工单即可作为上下文引用。
 * M55：复制行为上报 usage_events（copy_ref），驱动「最常使用」排序。 */
function CopyRefBtn({ text, teamId, assetId }: { text: string; teamId: string; assetId: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      title="复制规范引用（与 Agent @ 引用同格式，可直接粘贴到会话/工单）；复制会计入使用热度"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setOk(true);
          window.setTimeout(() => setOk(false), 1600);
          void api(`/assets/${assetId}/usage`, { method: "POST", body: { teamId, kind: "copy_ref" } }).catch(() => undefined);
        }).catch(() => undefined);
      }}
    >
      {ok ? "已复制引用" : "复制引用"}
    </button>
  );
}

/** 详情页「BibTeX」按钮（M66④，Zenodo「Cite」/GitHub「Cite this repository」锚点）：
 * 服务端生成标准 @misc 条目，复制进 LaTeX/文献管理器；导出计 copy_ref 使用热度。 */
function BibTeXBtn({ teamId, assetId }: { teamId: string; assetId: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      title="复制 BibTeX 引用（@misc，可直接进 LaTeX/文献管理器）；导出计入使用热度"
      onClick={() => {
        // 端点返回纯文本（application/x-bibtex），不走 JSON 助手
        void fetch(`/api/v1/assets/${assetId}/cite?teamId=${encodeURIComponent(teamId)}&format=bibtex`, { credentials: "same-origin" })
          .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((text) => navigator.clipboard.writeText(text))
          .then(() => {
            setOk(true);
            window.setTimeout(() => setOk(false), 1600);
            void api(`/assets/${assetId}/usage`, { method: "POST", body: { teamId, kind: "copy_ref" } }).catch(() => undefined);
          })
          .catch(() => undefined);
      }}
    >
      {ok ? "已复制 BibTeX" : "BibTeX"}
    </button>
  );
}

// 使用片段（M57）：按类型家族渲染的引用/调用模板（HF/Terraform 思想）。
// 数据来自 /assets/:id/snippets（@taw/domain 纯函数同源），复制成功计入 copy_ref 使用热度。
function SnippetCard({ teamId, assetId }: { teamId: string; assetId: string }) {
  const [snippets, setSnippets] = useState<{ kind: string; label: string; language: string; text: string }[] | null>(null);
  const [open, setOpen] = useState<string>("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    setSnippets(null);
    setOpen("");
    void api<{ snippets: { kind: string; label: string; language: string; text: string }[] }>(`/assets/${assetId}/snippets`, {
      query: { teamId },
    })
      .then((r) => setSnippets(r.snippets))
      .catch(() => setSnippets([]));
  }, [teamId, assetId]);
  if (snippets === null) return null;
  return (
    <div className="card">
      <h3>
        使用片段
        <span className="chip-dim" style={{ marginLeft: 8, fontSize: 12 }}>按类型生成 · 可复制即用</span>
      </h3>
      {snippets.length === 0 ? (
        <div className="state" style={{ padding: 0 }}>片段不可用。</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {snippets.map((s) => (
            <div key={s.kind} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
              <button
                className="link-btn"
                style={{ fontWeight: 600 }}
                aria-expanded={open === s.kind}
                onClick={() => setOpen((cur) => (cur === s.kind ? "" : s.kind))}
              >
                {open === s.kind ? "▾" : "▸"} {s.label}
              </button>
              <button
                className="link-btn"
                title="复制片段（计入使用热度）"
                onClick={() => {
                  void navigator.clipboard.writeText(s.text).then(() => {
                    setCopied(s.kind);
                    window.setTimeout(() => setCopied(""), 1600);
                    void api(`/assets/${assetId}/usage`, { method: "POST", body: { teamId, kind: "copy_ref" } }).catch(() => undefined);
                  }).catch(() => undefined);
                }}
              >
                {copied === s.kind ? "已复制" : "复制"}
              </button>
              {open === s.kind && (
                <pre
                  style={{
                    margin: 0, width: "100%", overflowX: "auto",
                    background: "color-mix(in srgb, var(--surface-2, #eee) 70%, transparent)",
                    border: "1px solid var(--line, #ddd)", borderRadius: 8,
                    padding: "8px 10px", fontSize: 12, lineHeight: 1.55,
                  }}
                >
                  {s.text}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 批量关联下载（M58）：资产 + confirmed 关系闭包一次请求打成自描述 ZIP
// （manifest.json + manifest-sha256.txt + 制品原文件；HF snapshot 思想 + BagIt 校验和）。
// 下载经浏览器原生 <a download>（会话 cookie 鉴权），服务端按包内资产计 download 热度。
function BundleCard({ teamId, assetId, directRelCount }: { teamId: string; assetId: string; directRelCount: number }) {
  const [depth, setDepth] = useState(1);
  const [direction, setDirection] = useState<"both" | "out" | "in">("both");
  const dirLabel = { both: "上下游", out: "仅下游", in: "仅上游" } as const;
  return (
    <div className="card">
      <h3>
        批量下载
        <span className="chip-dim" style={{ marginLeft: 8, fontSize: 12 }}>资产 + 关联闭包 · 自描述 ZIP</span>
      </h3>
      <div className="state" style={{ padding: 0, marginBottom: 8 }}>
        按已确认关系把本资产与{dirLabel[direction]}关联资产（各取当前修订）连制品一次打包，
        内含 manifest.json（资产/修订/关系清单）与 manifest-sha256.txt（逐文件校验和，离线可核完整性）。
        直接关联 {directRelCount} 个。
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12.5 }}>
          范围{" "}
          <select
            value={depth}
            onChange={(e) => setDepth(Number(e.target.value))}
            aria-label="关联跳数"
            style={{ padding: "1px 4px" }}
          >
            <option value={1}>1 跳（直接关联）</option>
            <option value={2}>2 跳</option>
            <option value={3}>3 跳</option>
          </select>
        </label>
        <label style={{ fontSize: 12.5 }}>
          方向{" "}
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as "both" | "out" | "in")}
            aria-label="关系方向"
            style={{ padding: "1px 4px" }}
          >
            <option value="both">上下游</option>
            <option value="out">仅下游（本资产 → 关联）</option>
            <option value="in">仅上游（关联 → 本资产）</option>
          </select>
        </label>
        <a
          className="ref-chip"
          href={`/api/v1/assets/${assetId}/bundle?teamId=${teamId}&depth=${depth}&direction=${direction}`}
          download
          title="下载 ZIP（manifest + 制品文件；计入各资产下载热度）"
        >
          ⬇ 下载 ZIP
        </a>
      </div>
    </div>
  );
}

export function Workbench({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  // 可分享视图（M54）：URL ?view=assets 直达目录（与筛选参数一并恢复）；M56 起集合页同样可直达；非法值回落总览
  const initialViewParam = useMemo(() => new URLSearchParams(window.location.search).get("view"), []);
  const initialViewValid = ["assets", "register", "semantic", "proposals", "release", "collections"].includes(initialViewParam ?? "");
  const [wsView, setWsView] = useState<"overview" | "assets" | "register" | "semantic" | "proposals" | "release" | "collections">(
    initialViewValid ? (initialViewParam as "assets" | "register" | "semantic" | "proposals" | "release" | "collections") : "overview"
  );
  const [assetId, setAssetId] = useState("");
  const [page, setPage] = useState<PageKey>(initialViewValid ? "workbench" : "dashboard");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cmdSeed, setCmdSeed] = useState<{ query: string; nonce: number }>({ query: "", nonce: 0 });
  const [registerHint, setRegisterHint] = useState<{ name?: string; typeKeyHint?: string; nonce: number }>({ nonce: 0 });
  // 轻量操作反馈（NL 建工单等异步结果）；6 秒自动消失
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "error"; nonce: number } | null>(null);
  // NL「聚焦 X 的图谱」解析出的聚焦资产（已聚焦同一资产时无需重复注入）
  const [graphFocus, setGraphFocus] = useState<{ id: string; nonce: number } | null>(null);
  // NL「A 和 B 怎么关联」（M51）：解析出的路径查询请求，图谱页据此拉取 /graph/path 并高亮
  const [graphPathReq, setGraphPathReq] = useState<{ fromId: string; toId: string; nonce: number } | null>(null);
  // NL「看归档记录」等意图预置的动态 action 过滤（M26）；nonce 变化即重复应用
  const [activityPreset, setActivityPreset] = useState<{ action: string; nonce: number } | null>(null);
  const [theme, cycleTheme] = useTheme();
  // Agent 运行状态（AgentPane 上报）：顶栏药丸如实反映 空闲/运行中
  const [agentRunning, setAgentRunning] = useState(false);
  const handleRunState = useCallback((running: boolean) => setAgentRunning(running), []);
  // Agent 区宽度：拖动分隔条调整（localStorage 记忆，双击复位，←→ 微调）。
  // M57 默认 44%→36%（用户反馈对话框过大）；存储键升 v2——旧键里持久化的 44 是
  // 挂载即写造成的"伪用户选择"，不继承，拖动后按新键记忆
  const DEFAULT_PANE_PCT = 36;
  // 对话区折叠（M67⑥）：收起成细条（组件保持挂载，SSE/输入不断线），状态记忆
  const [agentCollapsed, setAgentCollapsed] = useState<boolean>(() => localStorage.getItem("taw-agent-collapsed-v1") === "1");
  useEffect(() => {
    localStorage.setItem("taw-agent-collapsed-v1", agentCollapsed ? "1" : "0");
  }, [agentCollapsed]);
  const [panePct, setPanePct] = useState<number>(() => {
    const v = Number(localStorage.getItem("taw-pane-pct-v2"));
    return v >= 22 && v <= 65 ? v : DEFAULT_PANE_PCT;
  });
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    localStorage.setItem("taw-pane-pct-v2", String(Math.round(panePct * 10) / 10));
  }, [panePct]);
  const startPaneDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const main = mainRef.current;
    if (!main) return;
    const rect = main.getBoundingClientRect();
    const onMove = (ev: MouseEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setPanePct(Math.min(65, Math.max(22, pct)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("pane-dragging");
    };
    document.body.classList.add("pane-dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(t);
  }, [flash]);

  // 离开可分享视图（目录/集合）时清掉查询参数，避免陈旧 ?view=… 误导下次进入
  useEffect(() => {
    if ((page !== "workbench" || (wsView !== "assets" && wsView !== "collections")) && window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [page, wsView]);

  useEffect(() => {
    void api<ProjectInfo[]>("/projects")
      .then((p) => {
        setProjects(p);
        if (p[0]) setProjectId(p[0].projectId);
      })
      .catch((e) => setProjectsError(e instanceof ApiError ? e.message : "无法连接服务"));
  }, []);

  const project = useMemo(() => projects?.find((p) => p.projectId === projectId), [projects, projectId]);

  // 待办徽标（M42）：审批 CR / Agent 提案 / 语义候选的待处理计数。
  // 数据来自与对应页面完全相同的列表端点（口径一致），项目切换时加载 + 30s 轮询。
  const [badges, setBadges] = useState<{ approvals: number; proposals: number; semantic: number }>({
    approvals: 0, proposals: 0, semantic: 0,
  });
  const reloadBadges = useCallback(() => {
    if (!project) {
      setBadges({ approvals: 0, proposals: 0, semantic: 0 });
      return;
    }
    const teamId = project.teamId;
    void api<CRRow[]>(`/projects/${project.projectId}/change-requests`, { query: { teamId } })
      .then((rows) => setBadges((b) => ({
        ...b,
        approvals: rows.filter((r) => r.status === "awaiting_review" || r.status === "changes_requested").length,
      })))
      .catch(() => undefined);
    void api<unknown[]>(`/projects/${project.projectId}/proposals`, { query: { teamId, status: "pending" } })
      .then((rows) => setBadges((b) => ({ ...b, proposals: rows.length })))
      .catch(() => undefined);
    void api<unknown[]>("/semantic/candidates", { query: { teamId, status: "pending" } })
      .then((rows) => setBadges((b) => ({ ...b, semantic: rows.length })))
      .catch(() => undefined);
  }, [project]);
  useEffect(() => {
    reloadBadges();
    const t = window.setInterval(reloadBadges, 30000);
    // 各面板完成变更动作（确认候选/审提案/发布 CR 等）后派发该事件，徽标立即刷新不等轮询
    const onRefresh = () => reloadBadges();
    window.addEventListener("taw:badges-refresh", onRefresh);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("taw:badges-refresh", onRefresh);
    };
  }, [reloadBadges]);

  const reloadSessions = useCallback(() => {
    if (!project) return;
    void api<SessionInfo[]>(`/projects/${project.projectId}/sessions`, { query: { teamId: project.teamId } })
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [project]);

  useEffect(() => {
    reloadSessions();
  }, [reloadSessions]);

  // 会话维护（改名/归档）：创建者或团队管理员；归档当前会话后自动切到第一个未归档会话
  const isTeamAdmin = project ? me.teams.find((t) => t.teamId === project.teamId)?.role === "admin" : false;
  const [showArchived, setShowArchived] = useState(false);
  const patchSession = useCallback(async (s: SessionInfo, patch: { title?: string; archived?: boolean }) => {
    if (!project) return;
    try {
      await api(`/sessions/${s.sessionId}`, { method: "PATCH", body: { teamId: project.teamId, ...patch } });
      reloadSessions();
      if (patch.archived && s.sessionId === sessionId) {
        const next = sessions.find((x) => x.sessionId !== s.sessionId && !x.archived);
        setSessionId(next?.sessionId ?? "");
      }
      if (!patch.archived && patch.title === undefined) {
        // 恢复归档：若当前无选中会话则直接选中它
        if (!sessionId) setSessionId(s.sessionId);
      }
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "操作失败");
    }
  }, [project, reloadSessions, sessionId, sessions]);

  useEffect(() => {
    if (!sessions.some((s) => s.sessionId === sessionId)) setSessionId(sessions[0]?.sessionId ?? "");
  }, [sessions, sessionId]);

  const reloadProjects = useCallback(() => {
    void api<ProjectInfo[]>("/projects").then(setProjects).catch(() => undefined);
  }, []);

  // 全局键盘：Ctrl/⌘+K 命令栏；? 帮助；g+字母 两级跳转（输入框聚焦时不劫持）
  useEffect(() => {
    const go = createGoPrefixHandler(setPage);
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
        return;
      }
      if (e.key === "Escape") {
        setCmdOpen(false);
        setHelpOpen(false);
        return;
      }
      if (isTypingTarget(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      go(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openAssetFromSearch = useCallback((id: string) => {
    setAssetId(id);
    setWsView("assets");
    setPage("workbench");
    setMobileView("workspace");
  }, []);

  // NL 意图执行：只读意图映射到既有界面动作（跳转 / 命令栏搜索 / 预填登记表单）。
  // 写类意图（create_issue）在此执行 = 用户在命令栏卡片上点击"执行"的显式确认：
  // 解析端点本身零副作用，这里才调用既有 POST /issues（真实落库），结果以 flash 反馈。
  // 解析来自 POST /nl/parse（规则 L1 或真实 DeepSeek L2），此处不做二次解释。
  const executeNlIntent = useCallback((payload: NlIntentPayload): boolean => {
    if (payload.intent === "navigate" && payload.params.page) {
      // proposals 没有独立 rail 页：它是工作台内的「Agent 提案」标签
      if (payload.params.page === "proposals") {
        setPage("workbench");
        setWsView("proposals");
        setMobileView("workspace");
        return true;
      }
      // 图谱聚焦：资产名解析为 id 后进入聚焦模式；解析失败如实 flash，不静默装作聚焦
      if (payload.params.page === "graph" && payload.params.assetName) {
        const p = project;
        const name = payload.params.assetName;
        if (!p) return true;
        void (async () => {
          let hit: AssetRow | undefined;
          try {
            const hits = await api<AssetRow[]>("/assets/search", {
              query: { teamId: p.teamId, q: name, lifecycle: "all", limit: "10" },
            });
            hit = hits.find((a) => a.name === name) ?? hits[0];
          } catch { /* 解析失败按未找到处理 */ }
          if (hit) {
            setGraphFocus({ id: hit.id, nonce: Date.now() });
          } else {
            setFlash({ text: `未找到资产「${name}」，已打开未聚焦的图谱`, tone: "error", nonce: Date.now() });
          }
          setPage("graph");
          setMobileView("workspace");
        })();
        return true;
      }
      if (payload.params.page === "activity" && payload.params.activityAction) {
        setActivityPreset({ action: payload.params.activityAction, nonce: Date.now() });
      }
      setPage(payload.params.page);
      return true;
    }
    if (payload.intent === "graph_path") {
      const p = project;
      const fromName = payload.params.fromName ?? "";
      const toName = payload.params.toName ?? "";
      if (!p || !fromName || !toName) return true;
      void (async () => {
        // 名称 → id：精确名优先，唯一模糊命中可用；解析失败如实 flash，不静默装作查过
        const resolve = async (name: string): Promise<AssetRow | undefined> => {
          try {
            const hits = await api<AssetRow[]>("/assets/search", {
              query: { teamId: p.teamId, q: name, lifecycle: "all", limit: "10" },
            });
            return hits.find((a) => a.name === name) ?? (hits.length === 1 ? hits[0] : undefined);
          } catch {
            return undefined;
          }
        };
        const [from, to] = await Promise.all([resolve(fromName), resolve(toName)]);
        if (!from || !to) {
          setFlash({ text: `未找到资产「${!from ? fromName : toName}」，无法查询关联路径`, tone: "error", nonce: Date.now() });
        } else if (from.id === to.id) {
          setFlash({ text: `「${fromName}」与「${toName}」解析为同一资产`, tone: "error", nonce: Date.now() });
        } else {
          setGraphPathReq({ fromId: from.id, toId: to.id, nonce: Date.now() });
        }
        setPage("graph");
        setMobileView("workspace");
      })();
      return true;
    }
    if (payload.intent === "search_assets") {
      // 保持命令栏打开：回填解析出的关键词，直接呈现资产结果
      setCmdSeed({ query: payload.params.query ?? "", nonce: Date.now() });
      setCmdOpen(true);
      return false;
    }
    if (payload.intent === "fill_register_form") {
      setRegisterHint({
        name: payload.params.name,
        typeKeyHint: payload.params.typeKeyHint,
        nonce: Date.now(),
      });
      setPage("workbench");
      setWsView("register");
      setAssetId("");
      setMobileView("workspace");
      return true;
    }
    if (payload.intent === "create_issue") {
      const title = (payload.params.title ?? "").trim();
      if (!project) {
        setFlash({ text: "未创建工单：请先选择项目", tone: "error", nonce: Date.now() });
        return true;
      }
      if (!title) {
        setFlash({ text: "未创建工单：草稿缺少标题", tone: "error", nonce: Date.now() });
        return true;
      }
      const p = project;
      void (async () => {
        try {
          const res = await api<{ issueId: string }>("/issues", {
            method: "POST",
            body: { teamId: p.teamId, projectId: p.projectId, title, body: payload.params.body ?? "" },
          });
          setFlash({
            text: `问题工单已创建（${res.issueId.slice(0, 8)}…），见总览「最近问题」`,
            tone: "ok",
            nonce: Date.now(),
          });
        } catch (err) {
          setFlash({
            text: `创建工单失败：${err instanceof ApiError ? err.message : "网络错误"}`,
            tone: "error",
            nonce: Date.now(),
          });
        }
      })();
      return true;
    }
    if (payload.intent === "add_to_collection") {
      const p = project;
      const assetName = (payload.params.assetName ?? "").trim();
      const collectionName = (payload.params.collectionName ?? "").trim();
      if (!p) return true;
      if (!assetName || !collectionName) {
        setFlash({ text: "未加入集合：资产与集合缺一不可", tone: "error", nonce: Date.now() });
        return true;
      }
      void (async () => {
        // 两端名称 → id：精确名优先，唯一模糊命中可用；解析失败如实 flash，不静默装作加入
        try {
          const [hits, cols] = await Promise.all([
            api<AssetRow[]>("/assets/search", { query: { teamId: p.teamId, q: assetName, lifecycle: "all", limit: "10" } }),
            api<{ id: string; name: string }[]>("/collections", { query: { teamId: p.teamId } }),
          ]);
          const asset = hits.find((a) => a.name === assetName) ?? (hits.length === 1 ? hits[0] : undefined);
          const col = cols.find((c) => c.name === collectionName);
          if (!asset) {
            setFlash({ text: `未找到资产「${assetName}」，未加入集合`, tone: "error", nonce: Date.now() });
            return;
          }
          if (!col) {
            setFlash({ text: `未找到集合「${collectionName}」，可在工作台「集合」页新建`, tone: "error", nonce: Date.now() });
            return;
          }
          await api(`/collections/${col.id}/items`, {
            method: "POST",
            body: { teamId: p.teamId, assetId: asset.id },
          });
          setFlash({ text: `已把「${asset.name}」加入集合「${col.name}」`, tone: "ok", nonce: Date.now() });
        } catch (err) {
          setFlash({
            text: `加入集合失败：${err instanceof ApiError ? err.message : "网络错误"}`,
            tone: "error",
            nonce: Date.now(),
          });
        }
      })();
      return true;
    }
    return true;
  }, [project]);

  async function logout() {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* 会话可能已失效 */
    }
    onLoggedOut();
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="icon-btn" aria-label="切换导航抽屉" title="导航抽屉（项目 / Session）" onClick={() => setDrawerOpen(!drawerOpen)}>
          <IconMenu size={17} />
        </button>
        <span className="title">
          <IconBox size={16} />
          工作集
        </span>
        <select
          aria-label="选择项目"
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setAssetId("");
            setWsView("overview");
          }}
        >
          {projects?.map((p) => (
            <option key={p.projectId} value={p.projectId}>
              {p.name}
            </option>
          )) ?? <option>加载中…</option>}
        </select>
        <span className="status session-locator">
          {sessions.find((s) => s.sessionId === sessionId)?.title ?? "未选择会话"}
        </span>
        <span className="spacer" />
        <span className={`conn-pill${agentRunning ? " running" : ""}`} title="Agent 运行状态（实时）">
          <span className="conn-dot" aria-hidden="true" />
          {agentRunning ? "运行中" : "空闲"}
        </span>
        <button
          className="icon-btn"
          aria-label={`主题：${THEME_LABEL[theme]}（点击切换）`}
          title={`主题：${THEME_LABEL[theme]}`}
          onClick={cycleTheme}
        >
          {theme === "auto" ? <IconMonitor size={16} /> : theme === "light" ? <IconSun size={16} /> : <IconMoon size={16} />}
        </button>
        <span className="status user-name">{me.displayName}</span>
        <button className="logout-btn" onClick={logout}>退出</button>
      </header>

      <div className="body">
        <nav className="rail" aria-label="主导航">
          {RAIL_PAGES.map((p) => (
            <button
              key={p.key}
              className={`rail-item${page === p.key ? " active" : ""}`}
              title={p.key === "approvals" && badges.approvals > 0 ? `${p.label}（${badges.approvals} 个待处理）` : p.label}
              aria-label={p.key === "approvals" && badges.approvals > 0 ? `${p.label}，${badges.approvals} 个待处理` : p.label}
              onClick={() => setPage(p.key)}
            >
              <span className="rail-icon" aria-hidden="true">{p.icon}</span>
              <span className="rail-label">{p.label}</span>
              {p.key === "approvals" && badges.approvals > 0 && (
                <span className="rail-badge" aria-hidden="true">{badges.approvals > 99 ? "99+" : badges.approvals}</span>
              )}
            </button>
          ))}
          <button className="rail-item" title="命令栏（Ctrl/⌘+K）" aria-label="打开命令栏" onClick={() => setCmdOpen(true)}>
            <span className="rail-icon" aria-hidden="true"><IconSearch size={17} /></span>
            <span className="rail-label">搜索</span>
          </button>
        </nav>

        {page === "dashboard" ? (
          <main className="page-main" aria-label="总览仪表盘">
            <DashboardPage
              project={project}
              me={me}
              onNavigate={(p) => setPage(p)}
            />
          </main>
        ) : page === "activity" ? (
          <main className="page-main" aria-label="团队动态">
            <ActivityPage project={project} projects={projects ?? []} onOpenAsset={openAssetFromSearch} presetAction={activityPreset} />
          </main>
        ) : page === "approvals" ? (
          <main className="page-main" aria-label="审批队列">
            <ApprovalsPage project={project} onOpenRelease={() => { setPage("workbench"); setWsView("release"); setAssetId(""); }} />
          </main>
        ) : page === "graph" ? (
          <main className="page-main" aria-label="关系图谱">
            <RelationGraph project={project} onOpenAsset={openAssetFromSearch} initialFocusId={graphFocus?.id} initialPath={graphPathReq} />
          </main>
        ) : page === "ontology" ? (
          <main className="page-main" aria-label="本体治理">
            <OntologyPage project={project} me={me} onOpenAsset={openAssetFromSearch} />
          </main>
        ) : (
        <>
        <nav className={`drawer${drawerOpen ? "" : " closed"}`} aria-label="项目与会话导航">
          <h3>项目 → SESSION</h3>
          <button
            className="new-btn"
            onClick={async () => {
              const name = window.prompt("新项目名称：");
              const code = name ? window.prompt("项目代号（小写字母/数字/连字符）：") : null;
              if (name && code && me.teams[0]) {
                try {
                  // 与「新建会话」同款：创建后立即选中，避免 projectId 仍为空串导致
                  // select 视觉回落第一项而工作区实际未选中（实测走查 M32 修复）
                  const created = await api<{ projectId: string }>("/projects", { method: "POST", body: { teamId: me.teams[0].teamId, name, code } });
                  setProjectId(created.projectId);
                  reloadProjects();
                } catch (err) {
                  window.alert(err instanceof ApiError ? err.message : "创建失败");
                }
              }
            }}
          >
            <IconPlus size={13} /> 新建项目
          </button>
          {projectsError && <div className="empty">{projectsError}</div>}
          {projects?.length === 0 && <div className="empty">还没有项目。先新建一个项目。</div>}
          {projects?.map((p) => (
            <div className={`project${p.projectId === projectId ? " active" : ""}`} key={p.projectId}>
              <button
                className="project-name"
                title={p.projectId === projectId ? "当前项目" : "切换到此项目"}
                onClick={() => {
                  setProjectId(p.projectId);
                  setAssetId("");
                  setWsView("overview");
                }}
              >
                <IconBox size={13} />
                <span className="ellipsis">{p.name}</span>
              </button>
              {p.projectId === projectId && (
                <button
                  className="new-btn small"
                  onClick={async () => {
                    const title = window.prompt("新会话标题：");
                    if (!title) return;
                    try {
                      const created = await api<{ sessionId: string }>(
                        `/projects/${p.projectId}/sessions`,
                        { method: "POST", body: { teamId: p.teamId, title, visibility: "project" } }
                      );
                      const fresh = await api<SessionInfo[]>(
                        `/projects/${p.projectId}/sessions`,
                        { query: { teamId: p.teamId } }
                      );
                      setSessions(fresh);
                      setSessionId(created.sessionId);
                    } catch (err) {
                      window.alert(err instanceof ApiError ? err.message : "创建会话失败");
                    }
                  }}
                >
                  <IconPlus size={12} /> 新建会话
                </button>
              )}
              {p.projectId === projectId && sessions.filter((s) => !s.archived).length === 0 && <div className="empty">暂无会话</div>}
              {p.projectId === projectId &&
                sessions.filter((s) => !s.archived).map((s) => (
                  <div key={s.sessionId} className={`session-row${s.sessionId === sessionId ? " active" : ""}`}>
                    <button
                      className="session"
                      onClick={() => {
                        setSessionId(s.sessionId);
                        setMobileView("chat");
                      }}
                    >
                      <span className="session-ico" aria-hidden="true">
                        {s.visibility === "private" ? <IconLock size={12} /> : <IconMessage size={12} />}
                      </span>
                      <span className="ellipsis">{s.title}</span>
                    </button>
                    {(s.mine || isTeamAdmin) && (
                      <span className="session-actions">
                        <button
                          aria-label={`重命名会话 ${s.title}`}
                          title="重命名"
                          onClick={() => {
                            const title = window.prompt("新会话标题：", s.title);
                            if (title && title.trim() && title.trim() !== s.title) {
                              void patchSession(s, { title: title.trim() });
                            }
                          }}
                        >
                          <IconPencil size={12} />
                        </button>
                        <button
                          aria-label={`归档会话 ${s.title}`}
                          title="归档（不删除数据）"
                          onClick={() => {
                            if (window.confirm(`归档会话「${s.title}」？归档后移出默认列表，可随时恢复。`)) {
                              void patchSession(s, { archived: true });
                            }
                          }}
                        >
                          <IconArchive size={12} />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              {p.projectId === projectId && sessions.some((s) => s.archived) && (
                <div className="archived-block">
                  <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)}>
                    <IconChevronRight size={12} className={showArchived ? "open" : undefined} />
                    已归档（{sessions.filter((s) => s.archived).length}）
                  </button>
                  {showArchived &&
                    sessions.filter((s) => s.archived).map((s) => (
                      <div key={s.sessionId} className="session-row archived">
                        <button className="session" onClick={() => setSessionId(s.sessionId)}>
                          <span className="session-ico" aria-hidden="true"><IconArchive size={12} /></span>
                          <span className="ellipsis">{s.title}</span>
                        </button>
                        {(s.mine || isTeamAdmin) && (
                          <span className="session-actions">
                            <button
                              aria-label={`恢复会话 ${s.title}`}
                              title="恢复到列表"
                              onClick={() => void patchSession(s, { archived: false })}
                            >
                              <IconRefresh size={12} />
                            </button>
                          </span>
                        )}
                      </div>
                    ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div
          ref={mainRef}
          className={`main${mobileView === "workspace" ? " show-workspace" : ""}`}
          style={{ "--pane-w": `${panePct}%` } as React.CSSProperties}
        >
          <div className="mobile-switch" role="tablist" aria-label="窄屏视图切换">
            <button
              className={mobileView === "chat" ? "active" : ""}
              onClick={() => setMobileView("chat")}
            >
              对话
            </button>
            <button
              className={mobileView === "workspace" ? "active" : ""}
              onClick={() => setMobileView("workspace")}
            >
              工作区
            </button>
          </div>
          <AgentPane
            project={project}
            sessionId={sessionId}
            sessionTitle={sessions.find((s) => s.sessionId === sessionId)?.title}
            onOpenAsset={openAssetFromSearch}
            onRunStateChange={handleRunState}
            collapsed={agentCollapsed}
            onToggleCollapse={() => setAgentCollapsed((v) => !v)}
          />
          <div
            className="pane-divider"
            style={agentCollapsed ? { display: "none" } : undefined}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整对话区宽度"
            title="拖动调整对话区宽度 · ←→ 微调 · 双击复位"
            tabIndex={0}
            onMouseDown={startPaneDrag}
            onDoubleClick={() => setPanePct(DEFAULT_PANE_PCT)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") { e.preventDefault(); setPanePct((p) => Math.max(22, p - 2)); }
              if (e.key === "ArrowRight") { e.preventDefault(); setPanePct((p) => Math.min(65, p + 2)); }
            }}
          />
          <section className="workspace" aria-label="工作区">
            <div className="ws-tabs">
              {(
                [
                  ["overview", "项目概况"],
                  ["assets", "资产目录"],
                  ["collections", "集合"],
                  ["register", "登记资产"],
                  ["semantic", "语义候选"],
                  ["proposals", "Agent 提案"],
                  ["release", "发布与通道"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={wsView === key ? "active" : ""}
                  onClick={() => {
                    setWsView(key);
                    if (key !== "assets") setAssetId("");
                  }}
                >
                  {label}
                  {key === "semantic" && badges.semantic > 0 && (
                    <span className="tab-badge" title={`${badges.semantic} 条候选待审核`}>{badges.semantic > 99 ? "99+" : badges.semantic}</span>
                  )}
                  {key === "proposals" && badges.proposals > 0 && (
                    <span className="tab-badge" title={`${badges.proposals} 条提案待审`}>{badges.proposals > 99 ? "99+" : badges.proposals}</span>
                  )}
                </button>
              ))}
              {assetId && (
                <button className="active" onClick={() => setAssetId("")}>
                  ← 返回列表
                </button>
              )}
            </div>
            {assetId && project ? (
              <AssetDetailPanel
                teamId={project.teamId}
                projectId={project.projectId}
                assetId={assetId}
                role={me.teams.find((t) => t.teamId === project.teamId)?.role ?? "member"}
                onOpenAsset={openAssetFromSearch}
                onOpenGraph={(id) => {
                  setGraphFocus({ id, nonce: Date.now() });
                  setPage("graph");
                }}
              />
            ) : wsView === "overview" ? (
              <ProjectOverview project={project} me={me} />
            ) : wsView === "assets" ? (
              <AssetList
                project={project}
                onOpen={(id) => {
                  setAssetId(id);
                  setMobileView("workspace");
                }}
                onRegister={() => setWsView("register")}
              />
            ) : wsView === "semantic" ? (
              <SemanticPanel project={project} onOpenAsset={openAssetFromSearch} />
            ) : wsView === "proposals" ? (
              <AgentProposals
                project={project}
                onPrefillRegister={(hint) => {
                  setRegisterHint({ ...hint, nonce: Date.now() });
                  setWsView("register");
                  setMobileView("workspace");
                }}
              />
            ) : wsView === "release" ? (
              <ReleasePanel project={project} me={me} />
            ) : wsView === "collections" ? (
              <CollectionsPanel
                project={project}
                userId={me.userId}
                role={me.teams.find((t) => t.teamId === project?.teamId)?.role ?? "member"}
                onOpenAsset={openAssetFromSearch}
              />
            ) : (
              <AssetRegister
                project={project}
                hint={registerHint}
                onDone={() => {
                  setWsView("assets");
                  setMobileView("workspace");
                }}
              />
            )}
          </section>
        </div>
        </>
        )}
      </div>

      {flash && (
        <div className={`flash flash-${flash.tone}`} role="status">
          {flash.text}
        </div>
      )}
      <CommandBar
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        pages={RAIL_PAGES}
        onNavigate={(p) => setPage(p)}
        teamId={project?.teamId ?? ""}
        onOpenAsset={openAssetFromSearch}
        page={page}
        seedQuery={cmdSeed}
        onExecuteNl={executeNlIntent}
      />
      <ShortcutsOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// 集合（M56，HF Collections 思想）：人工策展的跨类型资产组——权威榜单、新人入门包、
// 评审材料包。管理权（改名/删除）=创建者或管理员（服务端强制），条目增删改备注=全员协作。
interface CollectionRow { id: string; name: string; description: string; item_count: number; contains_asset: boolean | null }
interface CollectionItem {
  asset_id: string; asset_name: string; type_key: string; type_version: string;
  lifecycle: string; note: string; added_at: string; added_by_name: string;
}
interface CollectionDetail {
  id: string; name: string; description: string; created_by: string; created_by_name: string; created_at: string;
  items: CollectionItem[];
}

function CollectionsPanel({ project, userId, role, onOpenAsset }: { project?: ProjectInfo; userId: string; role: string; onOpenAsset: (id: string) => void }) {
  const [cols, setCols] = useState<CollectionRow[] | null>(null);
  const [selId, setSelId] = useState("");
  const [detail, setDetail] = useState<CollectionDetail | null>(null);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [msg, setMsg] = useState("");
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({});
  // 只读分享快照（M67⑤）：冻结当前内容 + 免登录查看链接；M68① 吊销；M69① 有效期
  const [snapshots, setSnapshots] = useState<{ snapshotId: string; token: string; shareUrl: string; itemCount: number; createdAt: string; revokedAt?: string | null; expiresAt?: string | null; expired?: boolean }[]>([]);
  const [shareMsg, setShareMsg] = useState("");
  const isAdmin = role === "admin";
  const canManage = (d: CollectionDetail) => isAdmin || d.created_by === userId;

  const loadCols = useCallback(async (teamId: string) => {
    try {
      const rows = await api<CollectionRow[]>("/collections", { query: { teamId } });
      setCols(rows);
      setSelId((cur) => (cur && rows.some((r) => r.id === cur) ? cur : rows[0]?.id ?? ""));
    } catch (e) {
      setCols([]);
      setMsg(e instanceof ApiError ? e.message : "加载集合失败");
    }
  }, []);

  useEffect(() => {
    setCols(null);
    setDetail(null);
    setSelId("");
    setMsg("");
    if (project) void loadCols(project.teamId);
  }, [project?.teamId, loadCols, project]);

  useEffect(() => {
    setDetail(null);
    setNoteDraft({});
    setSnapshots([]);
    setShareMsg("");
    if (!project || !selId) return;
    void api<CollectionDetail>(`/collections/${selId}`, { query: { teamId: project.teamId } })
      .then(setDetail)
      .catch((e) => setMsg(e instanceof ApiError ? e.message : "加载集合详情失败"));
    void api<{ snapshotId: string; token: string; shareUrl: string; itemCount: number; createdAt: string; revokedAt?: string | null }[]>(
      `/collections/${selId}/snapshots`, { query: { teamId: project.teamId } }
    ).then(setSnapshots).catch(() => setSnapshots([]));
  }, [selId, project?.teamId, project]);

  async function createCollection() {
    if (!project || !newName.trim()) return;
    try {
      const res = await api<{ collectionId: string }>("/collections", {
        method: "POST",
        body: { teamId: project.teamId, name: newName.trim(), description: newDesc.trim() },
      });
      setNewName("");
      setNewDesc("");
      setMsg("");
      await loadCols(project.teamId);
      setSelId(res.collectionId);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "创建失败");
    }
  }

  async function renameCollection() {
    if (!project || !detail) return;
    const name = window.prompt("新的集合名称：", detail.name);
    if (!name || !name.trim() || name.trim() === detail.name) return;
    try {
      await api(`/collections/${detail.id}`, { method: "PATCH", body: { teamId: project.teamId, name: name.trim() } });
      setMsg("");
      await loadCols(project.teamId);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "改名失败");
    }
  }

  async function deleteCollection() {
    if (!project || !detail) return;
    if (!window.confirm(`删除集合「${detail.name}」？条目随集合删除，资产本身不受影响。`)) return;
    try {
      await api(`/collections/${detail.id}`, { method: "DELETE", query: { teamId: project.teamId } });
      setDetail(null);
      setSelId("");
      await loadCols(project.teamId);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "删除失败");
    }
  }

  async function removeItem(assetId: string) {
    if (!project || !detail) return;
    try {
      await api(`/collections/${detail.id}/items/${assetId}`, { method: "DELETE", query: { teamId: project.teamId } });
      setMsg("");
      await Promise.all([loadCols(project.teamId), reloadDetail()]);
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "移除失败");
    }
  }

  async function saveNote(assetId: string) {
    if (!project || !detail) return;
    const note = (noteDraft[assetId] ?? "").trim();
    try {
      await api(`/collections/${detail.id}/items/${assetId}`, { method: "PATCH", body: { teamId: project.teamId, note } });
      setMsg("");
      setNoteDraft((d) => { const n = { ...d }; delete n[assetId]; return n; });
      await reloadDetail();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "备注保存失败");
    }
  }

  async function reloadDetail() {
    if (!project || !selId) return;
    setDetail(await api<CollectionDetail>(`/collections/${selId}`, { query: { teamId: project.teamId } }));
  }

  // 创建只读分享快照（M67⑤）：冻结当前内容签发 token；集合后续增删不影响已分享快照。
  // M69①：可选有效期（天）——到期公开链接自动失效（GitHub PAT 过期锚点），留空=永久
  async function createSnapshot() {
    if (!project || !detail) return;
    const daysRaw = window.prompt(`创建「${detail.name}」的只读分享快照。\n有效期（天，留空 = 永久有效；到期后公开链接自动失效）：`, "30");
    if (daysRaw === null) return;
    const days = daysRaw.trim() === "" ? null : Number(daysRaw.trim());
    if (days !== null && (!Number.isFinite(days) || days <= 0)) {
      setShareMsg("有效期必须是正数天数（或留空表示永久）。");
      return;
    }
    if (!window.confirm(`当前 ${detail.items.length} 项内容将被冻结，生成免登录查看链接（集合后续变化不影响快照${days ? `；有效期 ${days} 天` : "；永久有效"}）。`)) return;
    const expiresAt = days ? new Date(Date.now() + days * 86400_000).toISOString() : undefined;
    try {
      const res = await api<{ snapshotId: string; token: string; shareUrl: string; itemCount: number }>(
        `/collections/${detail.id}/snapshots`, { method: "POST", body: { teamId: project.teamId, expiresAt } }
      );
      setShareMsg(`快照已创建：${res.itemCount} 项，链接 ${window.location.origin}${res.shareUrl}${days ? `（有效期 ${days} 天）` : "（永久有效）"}`);
      await reloadSnapshots();
    } catch (e) {
      setShareMsg(e instanceof ApiError ? e.message : "创建快照失败");
    }
  }

  async function reloadSnapshots() {
    if (!project || !selId) return;
    try {
      setSnapshots(await api<{ snapshotId: string; token: string; shareUrl: string; itemCount: number; createdAt: string; revokedAt?: string | null; expiresAt?: string | null; expired?: boolean }[]>(
        `/collections/${selId}/snapshots`, { query: { teamId: project.teamId } }
      ));
    } catch {
      setSnapshots([]);
    }
  }

  // 吊销分享快照（M68①）：链接泄漏后的治理出口——公开端点随即 410
  async function revokeSnapshot(snapshotId: string) {
    if (!project || !detail) return;
    if (!window.confirm("吊销该分享快照？链接立即失效（公开访问将返回「已吊销」），快照内容保留在团队内可查。")) return;
    try {
      await api(`/collections/${detail.id}/snapshots/${snapshotId}/revoke`, { method: "POST", body: { teamId: project.teamId } });
      setShareMsg("快照已吊销，链接不再有效。");
      await reloadSnapshots();
    } catch (e) {
      setShareMsg(e instanceof ApiError ? e.message : "吊销失败");
    }
  }

  if (!project) return <div className="state">选择或创建一个项目开始。</div>;
  return (
    <>
      <div className="card">
        <h3>新建集合</h3>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) { e.preventDefault(); void createCollection(); } }}
            placeholder="集合名称（如：新人入门包）"
            aria-label="集合名称"
            style={{ width: 220 }}
          />
          <input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="用途说明（可选）"
            aria-label="集合说明"
            style={{ width: 280 }}
          />
          <button className="primary" onClick={() => void createCollection()} disabled={!newName.trim()}>创建</button>
        </div>
        {msg && <div className="error-text" style={{ marginTop: 6 }}>{msg}</div>}
      </div>
      {cols === null ? (
        <div className="state">加载中…</div>
      ) : cols.length === 0 ? (
        <div className="state">还没有集合。集合是人工策展的跨类型资产组（权威榜单、入门包、评审材料包）——先把上面的表填好创建一个。</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 12, alignItems: "start" }}>
          <div className="card" style={{ padding: 8 }}>
            {cols.map((c) => (
              <button
                key={c.id}
                className="link-btn"
                style={{
                  display: "block", width: "100%", textAlign: "left", padding: "6px 8px", borderRadius: 6,
                  background: c.id === selId ? "color-mix(in srgb, var(--accent, #4a7dff) 14%, transparent)" : "transparent",
                  fontWeight: c.id === selId ? 600 : 400,
                }}
                onClick={() => setSelId(c.id)}
              >
                {c.name}
                <span className="chip-dim" style={{ marginLeft: 6 }}>{c.item_count} 项</span>
                {c.description && <div style={{ fontSize: 12, opacity: 0.7, fontWeight: 400 }}>{c.description}</div>}
              </button>
            ))}
          </div>
          {detail ? (
            <div className="card">
              <h3>
                {detail.name}
                <span className="chip-dim" style={{ marginLeft: 8, fontSize: 12 }}>
                  {detail.items.length} 项 · 由 {detail.created_by_name} 创建
                </span>
                <span style={{ float: "right", display: "flex", gap: 6 }}>
                  {detail.items.length > 0 && (
                    <a
                      className="ref-chip"
                      href={`/api/v1/collections/${detail.id}/bundle?teamId=${project!.teamId}`}
                      download
                      title="把集合内全部资产（各取当前修订）连制品打包成一个 ZIP（manifest + 校验和清单）"
                    >
                      ⬇ 下载集合包
                    </a>
                  )}
                  {canManage(detail) && (
                    <>
                      <button onClick={() => void createSnapshot()} title="冻结当前内容生成免登录只读链接（Zenodo 快照语义；集合后续变化不影响已分享快照）">分享快照…</button>
                      <button onClick={() => void renameCollection()} title="改名（创建者或管理员）">改名…</button>
                      <button style={{ color: "var(--red)" }} onClick={() => void deleteCollection()} title="删除集合（创建者或管理员）">删除集合</button>
                    </>
                  )}
                </span>
              </h3>
              {shareMsg && <div className="ok-text" style={{ margin: "4px 0 6px", fontSize: 12.5 }}>{shareMsg}</div>}
              {snapshots.length > 0 && (
                <div style={{ fontSize: 12.5, margin: "4px 0 8px", color: "var(--muted, #666)" }}>
                  分享快照（{snapshots.length}）：
                  {snapshots.map((s) => {
                    const expired = s.expired || (s.expiresAt ? new Date(s.expiresAt).getTime() <= Date.now() : false);
                    return (
                    <span key={s.snapshotId} style={{ marginRight: 12 }}>
                      {s.revokedAt ? (
                        <span className="chip-dim" title={`已吊销于 ${new Date(s.revokedAt).toLocaleString()}——链接不再有效，内容仅团队内可查`}>
                          🚫 {new Date(s.createdAt).toLocaleDateString()}（{s.itemCount} 项 · 已吊销）
                        </span>
                      ) : expired ? (
                        <span className="chip-dim" title={`已过期（有效期至 ${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : ""}）——公开链接自动失效，内容仅团队内可查`}>
                          ⏰ {new Date(s.createdAt).toLocaleDateString()}（{s.itemCount} 项 · 已过期）
                        </span>
                      ) : (
                        <>
                          <a className="ref-chip" href={s.shareUrl} target="_blank" rel="noreferrer"
                            title={`只读快照 · ${s.itemCount} 项 · ${new Date(s.createdAt).toLocaleString()}${s.expiresAt ? ` · 有效期至 ${new Date(s.expiresAt).toLocaleString()}` : " · 永久有效"}`}>
                            🔗 {new Date(s.createdAt).toLocaleDateString()}（{s.itemCount} 项{s.expiresAt ? ` · ${new Date(s.expiresAt).toLocaleDateString()} 到期` : ""}）
                          </a>
                          {canManage(detail) && (
                            <button className="secondary" style={{ marginLeft: 4, padding: "0 6px", fontSize: 11.5 }}
                              onClick={() => void revokeSnapshot(s.snapshotId)}
                              title="吊销该分享链接（泄漏治理出口；公开访问随即返回「已吊销」）">
                              吊销
                            </button>
                          )}
                        </>
                      )}
                    </span>
                    );
                  })}
                </div>
              )}
              {detail.description && <p style={{ margin: "4px 0 10px", opacity: 0.8 }}>{detail.description}</p>}
              {detail.items.length === 0 ? (
                <div className="state">集合为空——在资产详情页点「加入集合」，或对 Agent 说「把 X 加入集合 {detail.name}」。</div>
              ) : (
                <table className="list">
                  <thead>
                    <tr><th>资产</th><th>类型</th><th>生命周期</th><th>收录备注</th><th>收录人</th><th>操作</th></tr>
                  </thead>
                  <tbody>
                    {detail.items.map((it) => (
                      <tr key={it.asset_id}>
                        <td>
                          <button className="link-btn" onClick={() => onOpenAsset(it.asset_id)}>{it.asset_name}</button>
                        </td>
                        <td><span className="badge">{it.type_key}</span>v{it.type_version}</td>
                        <td>{it.lifecycle === "archived" ? "已归档" : it.lifecycle === "deprecated" ? "已弃用" : "进行中"}</td>
                        <td>
                          {noteDraft[it.asset_id] !== undefined ? (
                            <span style={{ display: "inline-flex", gap: 4 }}>
                              <input
                                value={noteDraft[it.asset_id] ?? ""}
                                onChange={(e) => setNoteDraft((d) => ({ ...d, [it.asset_id]: e.target.value }))}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void saveNote(it.asset_id); } }}
                                aria-label="编辑收录备注"
                                style={{ width: 180, padding: "1px 6px", fontSize: 12.5 }}
                              />
                              <button onClick={() => void saveNote(it.asset_id)}>存</button>
                              <button onClick={() => setNoteDraft((d) => { const n = { ...d }; delete n[it.asset_id]; return n; })}>×</button>
                            </span>
                          ) : (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              {it.note || <span style={{ opacity: 0.5 }}>—</span>}
                              <button
                                className="link-btn"
                                title="编辑备注"
                                onClick={() => setNoteDraft((d) => ({ ...d, [it.asset_id]: it.note }))}
                              >
                                改
                              </button>
                            </span>
                          )}
                        </td>
                        <td>{it.added_by_name}</td>
                        <td><button className="link-btn" onClick={() => void removeItem(it.asset_id)}>移除</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : (
            <div className="state">左侧选择一个集合。</div>
          )}
        </div>
      )}
    </>
  );
}

function ProjectOverview({ project, me }: { project?: ProjectInfo; me: Me }) {
  const [memberMsg, setMemberMsg] = useState("");
  if (!project) return <div className="state">选择或创建一个项目开始。</div>;
  const isAdmin = me.teams.find((t) => t.teamId === project.teamId)?.role === "admin";
  const addMember = async () => {
    const email = window.prompt("添加项目成员（填写其在本团队的注册邮箱）：");
    if (!email) return;
    try {
      await api(`/projects/${project.projectId}/members`, {
        method: "POST",
        body: { teamId: project.teamId, email },
      });
      setMemberMsg(`已添加 ${email} 为项目成员。`);
    } catch (err) {
      setMemberMsg(err instanceof ApiError ? err.message : "添加失败");
    }
  };
  return (
    <>
      <div className="card">
        <h3>{project.name}</h3>
        <div className="kv">
          <span className="k">项目代号</span><span>{project.code}</span>
          <span className="k">状态</span><span>{project.status === "active" ? "进行中" : project.status === "completed" ? "已结题" : "已归档"}</span>
          <span className="k">我的团队角色</span><span>{isAdmin ? "团队管理员" : "成员"}</span>
        </div>
        {isAdmin && (
          <div className="btn-row">
            <button onClick={addMember}>添加项目成员…</button>
          </div>
        )}
        {memberMsg && <div className="state">{memberMsg}</div>}
      </div>
      <div className="card">
        <h3>下一步</h3>
        <ul>
          <li>在「资产目录」查看团队正式资产；在「登记资产」上传并登记新资产。</li>
          <li>左侧对话区可以给 Agent 派任务（真实模型 + 工具）；Agent 仅有草稿写入权限，发布等高权动作由人类执行。</li>
        </ul>
      </div>
    </>
  );
}

function AssetList({ project, onOpen, onRegister }: { project?: ProjectInfo; onOpen: (id: string) => void; onRegister: () => void }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState("");
  // 刷新中标记（M71⑥ stale-while-revalidate）：筛选变更不清空旧结果，表格半透明指示
  // 正在刷新——消除「每键击整表卸载闪『加载中…』再重挂载」的抖动；仅首次加载（或切换
  // 项目）显示整块加载态。
  const [refreshing, setRefreshing] = useState(false);
  // 筛选条件 URL 化（M54）：初始从查询串恢复（可收藏可分享），变更写回 replaceState
  const initialParams = useMemo(() => new URLSearchParams(window.location.search), []);
  // 输入防抖（M71⑥）：关键词/属性筛选即时回显、300ms 后才提交到查询与 URL——
  // 之前每键击一次请求 + 一次 replaceState，结果行来回跳动（抖动根因之一）。
  const [keywordInput, setKeywordInput] = useState(initialParams.get("q") ?? "");
  const [keyword, setKeyword] = useState(initialParams.get("q") ?? "");
  useEffect(() => {
    const t = window.setTimeout(() => setKeyword(keywordInput), 300);
    return () => window.clearTimeout(t);
  }, [keywordInput]);
  // 生命周期过滤（M70 语义分层）：active 默认= 进行中+已弃用（弃用可见带警示）；可单看 deprecated
  const initialLifecycle = ["deprecated", "archived", "all"].includes(initialParams.get("lifecycle") ?? "") ? initialParams.get("lifecycle")! : "active";
  const [lifecycle, setLifecycle] = useState(initialLifecycle);
  const [facets, setFacets] = useState<AssetFacets | null>(null);
  // 本体类型树（M71②，/ontology/tree）：层次化类型下拉 + 类闭包展开提示的数据源
  const [typeTree, setTypeTree] = useState<OntologyTreeNode[] | null>(null);
  const [type, setType] = useState(initialParams.get("type") ?? "");
  const [family, setFamily] = useState(initialParams.get("family") ?? "");
  const [label, setLabel] = useState(initialParams.get("label") ?? "");
  const [sort, setSort] = useState(initialParams.get("sort") === "refs" ? "refs" : "newest");
  // 属性自定义筛选（M67②，OpenMetadata 任意属性过滤）：输入框空格分隔多项 key=value；
  // 随其余筛选参数一并 URL 化（?view=assets&prop=owner=alice）；M71④ 属性键 datalist
  // 由 facets.propertyKeys（观测键）补全——跨门类公共键可发现，不必记忆。
  const [propFilterInput, setPropFilterInput] = useState(() => formatPropFilters(parsePropFilters(initialParams.getAll("prop")).filters));
  const [propFilter, setPropFilter] = useState(propFilterInput);
  useEffect(() => {
    const t = window.setTimeout(() => setPropFilter(propFilterInput), 300);
    return () => window.clearTimeout(t);
  }, [propFilterInput]);
  const propFilters = useMemo(() => parsePropFilters(propFilter).filters, [propFilter]);
  // 个人收藏（M69③）：只看收藏开关随 URL 化（pinned=1）
  const [pinnedOnly, setPinnedOnly] = useState(initialParams.get("pinned") === "1");

  useEffect(() => {
    const sp = new URLSearchParams();
    sp.set("view", "assets");
    if (keyword) sp.set("q", keyword);
    if (type) sp.set("type", type);
    if (family) sp.set("family", family);
    if (label) sp.set("label", label);
    for (const f of propFilters) sp.append("prop", `${f.key}${f.op}${f.value}`);
    if (pinnedOnly) sp.set("pinned", "1");
    if (lifecycle !== "active") sp.set("lifecycle", lifecycle);
    if (sort !== "newest") sp.set("sort", sort);
    window.history.replaceState(null, "", `?${sp.toString()}`);
  }, [keyword, type, family, label, lifecycle, sort, propFilters, pinnedOnly]);

  // 分面清单（M53）：类型/标签下拉与家族 chips 的真实数据源
  useEffect(() => {
    setFacets(null);
    if (!project) return;
    void api<AssetFacets>("/assets/facets", { query: { teamId: project.teamId } })
      .then(setFacets)
      .catch(() => setFacets({ typeKeys: [], labels: [], categories: [] }));
    // 本体树与分面并行拉取（M71②）：层次化类型下拉 + 闭包计数
    void api<{ tree: OntologyTreeNode[] }>("/ontology/tree", { query: { teamId: project.teamId } })
      .then((r) => setTypeTree(r.tree))
      .catch(() => setTypeTree(null));
  }, [project]);

  // 切换项目时旧团队的数据不得残留（此时才清空、允许整块加载态）
  useEffect(() => {
    setAssets(null);
    setError("");
  }, [project?.teamId, project?.projectId]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    setRefreshing(true);
    const query: Record<string, string | string[]> = {
      teamId: project.teamId, q: keyword, lifecycle, type, label, typePrefix: family, sort,
    };
    if (propFilters.length > 0) query.prop = propFilters.map((f) => `${f.key}${f.op}${f.value}`);
    if (pinnedOnly) query.pinned = "true";
    void api<AssetRow[]>("/assets/search", { query })
      .then((rows) => {
        if (cancelled) return;
        setAssets(rows);
        setError("");
        setRefreshing(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : "加载失败");
        setRefreshing(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, keyword, lifecycle, type, family, label, sort, propFilters, pinnedOnly]);

  // 层次化类型选项（M71②）：只列「本类或其子类下有资产」的类型（闭包命中数 > 0），
  // 子类按深度缩进展示；本体树不可用时回退平铺 facets.typeKeys（与旧行为一致）
  const typeFlat = useMemo(() => {
    if (!typeTree) return null;
    const out: { node: OntologyTreeNode; depth: number }[] = [];
    const walk = (n: OntologyTreeNode, depth: number) => {
      if (n.closureAssetCount > 0) out.push({ node: n, depth });
      for (const c of n.children) walk(c, depth + 1);
    };
    for (const r of typeTree) walk(r, 0);
    return out;
  }, [typeTree]);
  const selectedTypeNode = type ? typeFlat?.find((f) => f.node.key === type)?.node ?? null : null;

  // 收藏切换（M69③）：局部更新行，不整页重载
  async function togglePin(a: AssetRow) {
    if (!project) return;
    try {
      if (a.pinned) {
        await api(`/assets/${a.id}/pin`, { method: "DELETE", query: { teamId: project.teamId } });
      } else {
        await api(`/assets/${a.id}/pin`, { method: "POST", body: { teamId: project.teamId } });
      }
      setAssets((prev) => (prev ? prev.map((r) => (r.id === a.id ? { ...r, pinned: !r.pinned } : r)) : prev));
    } catch {
      /* 切换失败保持原状 */
    }
  }

  // 清单导出（M69②）：与目录同一套过滤参数直连导出端点（导出动作进团队动态）
  const exportHref = (format: "csv" | "json") => {
    const sp = new URLSearchParams({ teamId: project!.teamId, format, lifecycle });
    if (keyword) sp.set("q", keyword);
    if (type) sp.set("type", type);
    if (family) sp.set("typePrefix", family);
    if (label) sp.set("label", label);
    for (const f of propFilters) sp.append("prop", `${f.key}${f.op}${f.value}`);
    if (pinnedOnly) sp.set("pinned", "true");
    if (sort !== "newest") sp.set("sort", sort);
    return `/api/v1/assets/export?${sp.toString()}`;
  };

  if (!project) return <div className="state">先选择项目。</div>;
  if (error) return <div className="state error">{error}</div>;
  const familyActive = (prefix: string) => family === prefix && !type;
  const clearAll = () => { setType(""); setFamily(""); setLabel(""); };
  const hasFilter = !!(type || family || label || propFilters.length > 0 || pinnedOnly);
  return (
    <div className="card">
      <h3>
        团队资产目录{" "}
        <button className="secondary" style={{ marginLeft: 12 }} onClick={onRegister}>
          登记新资产
        </button>
        <span style={{ float: "right", display: "flex", gap: 6 }}>
          <a className="ref-chip" href={exportHref("csv")} download
            title="把当前筛选结果导出为 CSV（RFC 4180 + BOM；导出动作进团队动态；属性明细不下发，与目录同可见面）">
            ⬇ 导出 CSV
          </a>
          <a className="ref-chip" href={exportHref("json")} download
            title="把当前筛选结果导出为 JSON（结构化清单；导出动作进团队动态）">
            ⬇ 导出 JSON
          </a>
        </span>
      </h3>
      <CompletenessWatermark teamId={project.teamId} onOpen={onOpen} />
      <div className="facet-row" role="group" aria-label="按类别快筛">
        <button
          className={`facet-chip${!hasFilter ? " active" : ""}`}
          onClick={clearAll}
        >
          全部
        </button>
        {TYPE_FAMILIES.map((f) => (
          <button
            key={f.key}
            className={`facet-chip${familyActive(f.prefix) ? " active" : ""}`}
            title={`type_key 前缀 ${f.prefix}*`}
            onClick={() => {
              setFamily(familyActive(f.prefix) ? "" : f.prefix);
              setType("");
            }}
          >
            {f.icon} {f.label}
          </button>
        ))}
      </div>
      <div className="field field-row">
        <input
          placeholder="按名称搜索…"
          aria-label="按名称搜索"
          value={keywordInput}
          onChange={(e) => setKeywordInput(e.target.value)}
          title="关键词即时输入、停顿 300ms 后才发起检索（防抖，结果不再逐键跳动）"
        />
        <input
          placeholder="属性筛选，如 owner=alice score>=0.9（空格分隔）"
          aria-label="按属性筛选"
          title="按 head 修订属性过滤（OpenMetadata 口径）：key=value 文本等值 / key>=v、key<=v 数值范围；点号嵌套路径（metrics.accuracy）；多项空格分隔，随 URL 可分享。输入时可从下拉选观测到的属性键（仅一级键）"
          value={propFilterInput}
          onChange={(e) => setPropFilterInput(e.target.value)}
          style={{ maxWidth: 280 }}
          list="asset-prop-key-suggestions"
        />
        <datalist id="asset-prop-key-suggestions" aria-hidden="true">
          {(facets?.propertyKeys ?? []).map((p) => (
            <option key={p.key} value={p.key}>{p.key}（{p.count} 项在用）</option>
          ))}
        </datalist>
        <select
          aria-label="按类型过滤"
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            if (e.target.value) setFamily("");
          }}
          title="类闭包过滤（M71）：选父类型自动命中其全部子类资产（Wikidata 子类口径），与 Agent 检索同一语义；子类缩进展示，括号内为闭包命中数"
        >
          <option value="">全部类型</option>
          {typeFlat && typeFlat.length > 0
            ? typeFlat.map(({ node, depth }) => (
                <option key={node.key} value={node.key}>
                  {depth > 0 ? `${"　".repeat(depth)}└ ` : ""}{node.key}（{node.closureAssetCount}
                  {node.subclassKeys.length > 0 ? `，含 ${node.subclassKeys.length} 子类` : ""}）
                </option>
              ))
            : (facets?.typeKeys ?? []).map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <select aria-label="按标签过滤" value={label} onChange={(e) => setLabel(e.target.value)}>
          <option value="">全部标签</option>
          {(facets?.labels ?? []).map((l) => (
            <option key={l.label} value={l.label}>{l.label}（{l.count}）</option>
          ))}
        </select>
        <select aria-label="生命周期过滤" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)} title="进行中 = 默认视图，含已弃用（弃用资产仍可见、带警示，HF deprecated models 口径）；归档 = 隐藏的终态资产">
          <option value="active">进行中（含已弃用）</option>
          <option value="deprecated">仅已弃用</option>
          <option value="archived">已归档</option>
          <option value="all">全部</option>
        </select>
        <select aria-label="排序方式" value={sort} onChange={(e) => setSort(e.target.value)} title="按关联数排序找核心资产，按使用热度找高频资产；完整度升序把最该补元数据的排前面（候选集 ≤200 内计算）">
          <option value="newest">最新登记</option>
          <option value="refs">关联最多</option>
          <option value="usage">最常使用</option>
          <option value="completeness">完整度（低分优先）</option>
        </select>
        <button
          className={`facet-chip${pinnedOnly ? " active" : ""}`}
          style={{ flex: "none" }}
          onClick={() => setPinnedOnly((v) => !v)}
          title="只看我收藏（★）的资产——收藏随个人账号，他人不可见（GitHub stars 思想）"
        >
          ★ 只看收藏
        </button>
      </div>
      {selectedTypeNode && selectedTypeNode.subclassKeys.length > 0 && (
        <div style={{ margin: "0 0 6px", fontSize: 12, color: "var(--faint, #999)" }}>
          类闭包已展开：<code>{selectedTypeNode.key}</code> 含 {selectedTypeNode.subclassKeys.length} 个子类
          （{selectedTypeNode.subclassKeys.join("、")}），命中共 {selectedTypeNode.closureAssetCount} 项——行上类型为各自实际类型。
        </div>
      )}
      {assets === null ? (
        <div className="state">加载中…</div>
      ) : assets.length === 0 ? (
        <div className="state">
          {hasFilter
            ? "当前筛选条件下没有资产。"
            : lifecycle === "archived" ? "没有已归档资产。"
            : lifecycle === "deprecated" ? "没有已弃用资产（弃用 = 仍可见带警示 + 继任者指引，与归档分层）。"
            : "暂无资产。上传文件并登记后出现在这里。"}
        </div>
      ) : (
        <div className="list-wrap" data-refreshing={refreshing ? "true" : "false"} aria-busy={refreshing}
          title={refreshing ? "正在按新筛选条件刷新…" : undefined}>
          <table className="list">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>类型版本</th>
              <th>状态</th>
              <th>关联</th>
              <th title="元数据完整度（M65 六项加权：必填/负责人/关联/制品/别名/标签）">完整度</th>
              <th>修订摘要</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} onClick={() => onOpen(a.id)}>
                <td>
                  <button
                    aria-label={a.pinned ? `取消收藏 ${a.name}` : `收藏 ${a.name}`}
                    title={a.pinned ? "取消收藏（个人视角，他人不可见）" : "收藏：常用资产一键可达（个人视角，他人不可见）"}
                    style={{ border: "none", background: "transparent", cursor: "pointer", padding: "0 4px 0 0", color: a.pinned ? "#d9a62e" : "var(--faint, #999)", fontSize: 14 }}
                    onClick={(e) => { e.stopPropagation(); void togglePin(a); }}
                  >
                    {a.pinned ? "★" : "☆"}
                  </button>
                  {a.name}{a.has_artifacts && <span title="当前修订含制品文件，点开详情可下载" style={{ marginLeft: 6 }}>📎</span>}
                </td>
                <td><span className="badge">{a.type_key}</span></td>
                <td>{a.type_version}</td>
                <td>
                  {a.lifecycle === "archived"
                    ? <span className="badge" style={{ background: "#6b5b3e", color: "#fff" }}>已归档</span>
                    : a.lifecycle === "deprecated"
                      ? <span className="badge" style={{ background: "#5a5a66", color: "#fff" }}>已弃用</span>
                      : <span className="badge" style={{ background: "#2e6b4f", color: "#fff" }}>进行中</span>}
                </td>
                <td title="未撤回关系断言数（被引用与引用他人合计）">{a.relation_count ?? 0}</td>
                <td>
                  <span
                    title="元数据完整度（点开详情看逐项检查与补全建议）"
                    style={{ fontWeight: 700, color: (a.completenessScore ?? 100) >= 80 ? "#3e7d4e" : (a.completenessScore ?? 100) >= 50 ? "#8a6d3b" : "#a44646" }}
                  >
                    {a.completenessScore ?? "—"}
                  </span>
                </td>
                <td><code>{a.content_digest.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

interface BranchRow { id: string; name: string; status: string; created_at: string; created_by_name: string; changed_assets: number }
interface CRRow { id: string; title: string; status: string; created_at: string; created_by_name: string; branch_name: string; item_count: number }
interface CRSnap { id: string; candidate_digest: string; review_digest: string; channel: string; superseded: boolean; created_at: string }
interface CRDetail {
  id: string; title: string; status: string; branch_name: string; created_by_name: string;
  motivation: string; items: { asset_id: string; asset_name: string; base_seq: number; candidate_seq: number; diff?: CRItemDiff }[];
  snapshots: CRSnap[];
  comments: CRComment[];
}
interface ChannelHead { asset_id: string; asset_name: string; revision_id: string; revision_seq: number; version_label: string | null; updated_at: string }

/** 详情页「派生血缘」卡（M67①，HF model card base_model）：属性里声明的血缘引用展示为
 *  可物化提示——一键把 base_model 等引用物化为 derivedFrom 断言（保守解析：名称/别名精确命中；
 *  未命中如实展示，不自动模糊建边）。 */
function LineageCard({ teamId, assetId, refs, onDone }: {
  teamId: string; assetId: string; refs: { field: string; refs: string[] }[]; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ created: number; results: { field: string; ref: string; status: string; targetName?: string; message: string }[] } | null>(null);
  async function materialize() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await api<{ created: number; results: { field: string; ref: string; status: string; targetName?: string; message: string }[] }>(
        `/assets/${assetId}/lineage/materialize`, { method: "POST", body: { teamId } }
      );
      setResult(res);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "物化失败");
    } finally {
      setBusy(false);
    }
  }
  const statusIcon: Record<string, string> = { linked: "✅", already: "ℹ️", unresolved: "⚠️", self: "ℹ️" };
  return (
    <div className="card" style={{ marginTop: 10, padding: "10px 14px" }}>
      <h4 style={{ margin: 0 }}>
        派生血缘（属性声明）
        <button className="secondary" style={{ marginLeft: 10, padding: "2px 10px" }} disabled={busy} onClick={() => void materialize()}
          title="把属性中声明的血缘引用物化为 derivedFrom 关联断言（名称/别名精确命中才建边；建边走既有 domain/range 与禁环校验）">
          {busy ? "物化中…" : "物化为 derivedFrom 关联"}
        </button>
        {error && <span className="error-text" style={{ marginLeft: 8 }}>{error}</span>}
      </h4>
      <div style={{ fontSize: 12.5, marginTop: 6, color: "var(--muted, #666)" }}>
        {refs.map((g) => (
          <span key={g.field} style={{ marginRight: 14 }}>
            <code>{g.field}</code>：{g.refs.map((r) => `「${r}」`).join(" ")}
          </span>
        ))}
      </div>
      {result && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
          {result.results.map((r, i) => (
            <li key={`${r.field}-${r.ref}-${i}`}>
              {statusIcon[r.status] ?? "·"} <code>{r.field}</code>=「{r.ref}」{r.targetName ? ` → ${r.targetName}` : ""} — {r.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 「沿血缘传播标签」按钮（M67③，Atlas 分类传播 + 治理确认流）：预览（planDigest）→
 *  弹窗确认下游与将新增标签 → 确认执行；预览与执行之间拓扑变化会被服务端 409 拦下。 */
function PropagateLabelsBtn({ teamId, assetId, onDone }: { teamId: string; assetId: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function run() {
    setBusy(true);
    setMsg("");
    try {
      const preview = await api<{
        planDigest: string; sourceLabels: string[];
        targets: { assetId: string; name: string; labelsToAdd: string[] }[];
        notes: string[];
      }>(`/assets/${assetId}/propagate-labels`, { query: { teamId } });
      if (preview.targets.length === 0) {
        setMsg(preview.notes[0] ?? "无可传播对象");
        return;
      }
      const lines = preview.targets.map((t) => `「${t.name}」+ ${t.labelsToAdd.join(" / ")}`).join("\n");
      if (!window.confirm(`将沿 derivedFrom 血缘把本资产标签（${preview.sourceLabels.join(" / ")}）传播到 ${preview.targets.length} 个下游资产：\n\n${lines}\n\n确认执行？（中间节点自己加的标签不级联；执行后各资产标签可在其详情页管理）`)) {
        return;
      }
      const res = await api<{ appliedAssets: number; appliedLabels: number }>(
        `/assets/${assetId}/propagate-labels`,
        { method: "POST", body: { teamId, confirmPlanDigest: preview.planDigest } }
      );
      setMsg(`已传播 ${res.appliedLabels} 项标签到 ${res.appliedAssets} 个下游资产`);
      onDone();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "传播失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button onClick={() => void run()} disabled={busy} title="把本资产当前标签沿 derivedFrom 血缘传播到全部下游（Atlas 分类传播思想；两步确认，预览摘要不符会被服务端拒绝）">
        {busy ? "传播中…" : "沿血缘传播标签…"}
      </button>
      {msg && <span className="ok-text" style={{ alignSelf: "center" }}>{msg}</span>}
    </>
  );
}

/** 详情页收藏按钮（M69③）：乐观切换，失败回滚如实提示 */
function PinDetailBtn({ teamId, assetId, initialPinned }: { teamId: string; assetId: string; initialPinned: boolean }) {
  const [pinned, setPinned] = useState(initialPinned);
  const [error, setError] = useState("");
  async function toggle() {
    const next = !pinned;
    setPinned(next);
    setError("");
    try {
      if (next) await api(`/assets/${assetId}/pin`, { method: "POST", body: { teamId } });
      else await api(`/assets/${assetId}/pin`, { method: "DELETE", query: { teamId } });
    } catch (e) {
      setPinned(!next);
      setError(e instanceof ApiError ? e.message : "操作失败");
    }
  }
  return (
    <>
      <button
        onClick={() => void toggle()}
        title={pinned ? "取消收藏（个人视角，他人不可见）" : "收藏：常用资产一键可达（个人视角，他人不可见）"}
        style={{ color: pinned ? "#d9a62e" : "inherit" }}
      >
        {pinned ? "★ 已收藏" : `☆ 收藏`}
      </button>
      {error && <span className="error-text" style={{ alignSelf: "center" }}>{error}</span>}
    </>
  );
}

function AssetDetailPanel({ teamId, projectId, assetId, role, onOpenGraph, onOpenAsset }: { teamId: string; projectId: string; assetId: string; role: string; onOpenGraph?: (assetId: string) => void; onOpenAsset?: (assetId: string) => void }) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [rels, setRels] = useState<Relations | null>(null);
  const [error, setError] = useState("");
  const [lifecycleMsg, setLifecycleMsg] = useState("");
  const [newAlias, setNewAlias] = useState("");
  const [aliasMsg, setAliasMsg] = useState("");
  // 集合（M56）：本资产所在的集合 + 可加入集合下拉（列表端点带 assetId 时返回 contains_asset）
  const [cols, setCols] = useState<CollectionRow[] | null>(null);
  const [addToId, setAddToId] = useState("");
  const [colNote, setColNote] = useState("");
  const [colMsg, setColMsg] = useState("");

  async function reload() {
    try {
      setDetail(await api<AssetDetail>(`/assets/${assetId}`, { query: { teamId } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }

  async function reloadCols() {
    try {
      setCols(await api<CollectionRow[]>("/collections", { query: { teamId, assetId } }));
    } catch {
      setCols(null);
    }
  }

  useEffect(() => {
    setDetail(null);
    setError("");
    setLifecycleMsg("");
    setAliasMsg("");
    setNewAlias("");
    setCols(null);
    setAddToId("");
    setColNote("");
    setColMsg("");
    void reload();
    void reloadCols();
    void api<Relations>("/relations", { query: { teamId, assetId } })
      .then(setRels)
      .catch(() => setRels(undefined as unknown as Relations));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, assetId]);

  async function addToCollection() {
    if (!addToId) return;
    try {
      await api(`/collections/${addToId}/items`, { method: "POST", body: { teamId, assetId, note: colNote.trim() } });
      setAddToId("");
      setColNote("");
      setColMsg("");
      await reloadCols();
    } catch (err) {
      setColMsg(err instanceof ApiError ? err.message : "加入失败");
    }
  }

  async function removeFromCollection(collectionId: string) {
    try {
      await api(`/collections/${collectionId}/items/${assetId}`, { method: "DELETE", query: { teamId } });
      setColMsg("");
      await reloadCols();
    } catch (err) {
      setColMsg(err instanceof ApiError ? err.message : "移除失败");
    }
  }

  async function addAlias() {
    const alias = newAlias.trim().toLowerCase();
    if (!alias) return;
    try {
      await api(`/assets/${assetId}/aliases`, { method: "POST", body: { teamId, alias } });
      setNewAlias("");
      setAliasMsg("");
      await reload();
    } catch (err) {
      setAliasMsg(err instanceof ApiError ? err.message : "添加失败");
    }
  }

  async function removeAlias(alias: string) {
    try {
      await api(`/assets/${assetId}/aliases/${encodeURIComponent(alias)}`, { method: "DELETE", query: { teamId } });
      setAliasMsg("");
      await reload();
    } catch (err) {
      setAliasMsg(err instanceof ApiError ? err.message : "移除失败");
    }
  }

  async function changeLifecycle(action: "archive" | "restore") {
    const reason = window.prompt(action === "archive" ? "归档原因（必填，将写入审计日志）：" : "恢复原因（必填，将写入审计日志）：");
    if (!reason || reason.trim().length < 4) {
      if (reason !== null) window.alert("原因至少 4 个字符。");
      return;
    }
    try {
      await api(`/assets/${assetId}/${action}`, { method: "POST", body: { teamId, reason: reason.trim() } });
      setLifecycleMsg(action === "archive" ? "已归档（可随时恢复）。" : "已恢复为进行中。");
      await reload();
    } catch (err) {
      window.alert(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "操作失败");
    }
  }

  // 弃用（M70，MLflow Archived/Docker Hub deprecated/HF deprecated models 锚点）：
  // 弃用 = 仍可见仍可取用但带警示 + 继任者指引，可逆；与归档（隐藏+终态）分层。
  async function deprecate() {
    const note = window.prompt("弃用原因（必填，将写入审计日志并展示在详情页横幅）：");
    if (!note || note.trim().length < 4) {
      if (note !== null) window.alert("原因至少 4 个字符。");
      return;
    }
    const ref = window.prompt("继任者资产（可选，填资产名或别名，精确匹配；留空表示暂无继任者）：");
    if (ref === null) return;
    try {
      const res = await api<{ repeated: boolean; successor: { id: string; name: string } | null }>(
        `/assets/${assetId}/deprecate`,
        { method: "POST", body: { teamId, note: note.trim(), successorRef: ref.trim() ? ref.trim() : undefined } }
      );
      setLifecycleMsg(res.repeated ? "弃用信息已更新（原因/继任者）。" : "已标记弃用：目录仍可见并带警示，下载/引用不受阻。");
      await reload();
    } catch (err) {
      window.alert(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "操作失败");
    }
  }

  async function undeprecate() {
    const reason = window.prompt("取消弃用的原因（必填，将写入审计日志）：");
    if (!reason || reason.trim().length < 4) {
      if (reason !== null) window.alert("原因至少 4 个字符。");
      return;
    }
    try {
      await api(`/assets/${assetId}/undeprecate`, { method: "POST", body: { teamId, reason: reason.trim() } });
      setLifecycleMsg("已取消弃用，资产回到进行中。");
      await reload();
    } catch (err) {
      window.alert(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "操作失败");
    }
  }

  if (error) return <div className="state error">{error}</div>;
  if (!detail) return <div className="state">加载中…</div>;
  const head = detail.revisions[0];
  const archived = detail.lifecycle === "archived";
  const deprecated = detail.lifecycle === "deprecated";
  const headArtifacts = head?.artifacts ?? [];
  // 上游/下游健康提示（M54，Atlas「分类沿血缘传播」的读侧诚实形态）：
  // 依赖链上有非进行中资产时警示——只提示不自动改状态，治理动作仍由人执行；
  // M70 起区分文案：已弃用（可循继任者迁移）与已归档（终态）
  const badUpstream = rels?.incoming.filter((r) => r.source_lifecycle && r.source_lifecycle !== "active") ?? [];
  const badDownstream = rels?.outgoing.filter((r) => r.target_lifecycle && r.target_lifecycle !== "active") ?? [];
  const depAlert = [...badUpstream, ...badDownstream];
  return (
    <>
      {deprecated && (
        <div
          className="card"
          style={{ padding: "10px 14px", marginBottom: 10, borderLeft: "4px solid #b3541e", background: "var(--card, #fff)" }}
          role="alert"
        >
          <strong style={{ color: "#b3541e" }}>⚠ 此资产已被标记弃用{detail.deprecatedAt ? `（${new Date(detail.deprecatedAt).toLocaleDateString("zh-CN")}）` : ""}</strong>
          {detail.deprecationNote && <span>：{detail.deprecationNote}</span>}
          {detail.successor && (
            <span>
              　请改用继任者：
              <a
                href={`?view=assets&asset=${detail.successor.id}`}
                onClick={(e) => { if (onOpenAsset) { e.preventDefault(); onOpenAsset(detail.successor!.id); } }}
                style={{ fontWeight: 600 }}
              >
                {detail.successor.name}
              </a>
              {detail.successor.lifecycle === "deprecated" && (
                <span className="badge" style={{ background: "#5a5a66", color: "#fff", marginLeft: 6, fontSize: 11 }}>注意：继任者自身也已弃用</span>
              )}
            </span>
          )}
          {!detail.successor && <span style={{ color: "var(--muted, #666)" }}>（未指定继任者）</span>}
          <div style={{ fontSize: 12.5, color: "var(--muted, #666)", marginTop: 4 }}>
            弃用不隐藏：目录仍可见、下载与引用不受阻；修复后可「取消弃用」回到进行中。
          </div>
        </div>
      )}
      <div className="card">
        <h3>
          {detail.name}
          {archived && (
            <span className="badge" style={{ background: "#6b5b3e", color: "#fff", marginLeft: 8 }}>已归档</span>
          )}
          {deprecated && (
            <span className="badge" style={{ background: "#5a5a66", color: "#fff", marginLeft: 8 }}>已弃用</span>
          )}
        </h3>
        <div className="kv">
          <span className="k">类型</span><span><span className="badge">{detail.type_key}</span>v{detail.type_version}</span>
          <span className="k">生命周期</span><span>{archived ? "已归档（目录默认视图隐藏，禁止新草稿）" : deprecated ? "已弃用（目录可见带警示，仍可取用，可取消）" : "进行中"}</span>
          <span className="k">分类</span><span>{detail.categories.map((c) => c.category_path).join(" · ") || "—"}</span>
          <span className="k">标签</span><span>{detail.labels.join(" · ") || "—"}</span>
          <span className="k">别名</span>
          <span>
            {(detail.aliases ?? []).length === 0 ? "—" : ""}
            {(detail.aliases ?? []).map((a) => (
              <span key={a} className="picked-ref" style={{ display: "inline-flex", marginRight: 6 }}>
                {a}
                <button aria-label={`移除别名 ${a}`} title="移除别名" onClick={() => void removeAlias(a)}>×</button>
              </span>
            ))}
            <input
              value={newAlias}
              onChange={(e) => { setNewAlias(e.target.value); setAliasMsg(""); }}
              onKeyDown={(e) => { if (e.key === "Enter" && newAlias.trim()) { e.preventDefault(); void addAlias(); } }}
              placeholder="添加别名（如 prod）"
              aria-label="新别名"
              style={{ width: 150, padding: "1px 6px", fontSize: 12.5 }}
            />
            <button style={{ marginLeft: 6 }} onClick={() => void addAlias()} disabled={!newAlias.trim()}>添加</button>
          </span>
          {detail.usage && (
            <>
              <span className="k" title="近 90 天真实使用行为计数（npm/HF 使用度信号）">使用热度</span>
              <span>
                近 90 天 {detail.usage.download + detail.usage.copy_ref + detail.usage.agent_read} 次
                （下载 {detail.usage.download} · 引用复制 {detail.usage.copy_ref} · Agent 读取 {detail.usage.agent_read}）
              </span>
            </>
          )}
          {head && (
            <>
              <span className="k">当前修订</span><span>r{head.seq} · 摘要 <code>{head.content_digest.slice(0, 16)}…</code></span>
            </>
          )}
          {head && Object.entries(head.properties as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
            .slice(0, 12)
            .map(([k, v]) => (
              <Fragment key={k}>
                <span className="k" title="当前修订属性">{k}</span>
                <span>
                  {isHttpUrl(String(v))
                    ? <a href={String(v)} target="_blank" rel="noreferrer" title="打开外部链接">{String(v)}</a>
                    : String(v)}
                </span>
              </Fragment>
            ))}
        </div>
        {detail.completeness && <CompletenessCard report={detail.completeness} />}
        {(detail.lineageRefs ?? []).length > 0 && (
          <LineageCard teamId={teamId} assetId={detail.id} refs={detail.lineageRefs!} onDone={() => void reload()} />
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {archived ? (
            <button onClick={() => void changeLifecycle("restore")}>恢复资产</button>
          ) : (
            <>
              <button onClick={() => void deprecate()} title="标记弃用：目录仍可见带警示 + 继任者指引，可随时取消（与归档分层）">
                弃用资产…
              </button>
              {deprecated && (
                <button onClick={() => void undeprecate()} title="取消弃用，资产回到进行中">取消弃用</button>
              )}
              <button onClick={() => void changeLifecycle("archive")}>归档资产…</button>
            </>
          )}
          {!archived && detail.labels.length > 0 && (
            <PropagateLabelsBtn teamId={teamId} assetId={detail.id} onDone={() => void reload()} />
          )}
          {onOpenGraph && (
            <button onClick={() => onOpenGraph(detail.id)} title="在关系图谱中以该资产为中心查看">
              在图谱中查看
            </button>
          )}
          <a
            className="ref-chip"
            href={`/api/v1/assets/${detail.id}/sbom?teamId=${teamId}`}
            download
            title="导出 CycloneDX 1.5 SBOM：主体 + 关系闭包（直接依赖）的机器可读物料清单，供应链工具可消费；导出计一次下载热度并进团队动态"
          >
            导出 SBOM
          </a>
          <CopyRefBtn text={`资产「${detail.name}」(id: ${detail.id}, 类型 ${detail.type_key} v${detail.type_version})`} teamId={teamId} assetId={detail.id} />
          <BibTeXBtn teamId={teamId} assetId={detail.id} />
          <PinDetailBtn teamId={teamId} assetId={detail.id} initialPinned={detail.pinned === true} />
          {aliasMsg && <span className="error-text" style={{ alignSelf: "center" }}>{aliasMsg}</span>}
          {lifecycleMsg && <span className="ok-text" style={{ alignSelf: "center" }}>{lifecycleMsg}</span>}
        </div>
        {depAlert.length > 0 && (
          <div className="dep-alert" role="alert" style={{ marginTop: 10 }}>
            <IconAlert size={14} />
            <span>
              依赖链上存在非进行中资产：
              {badUpstream.map((r) => `上游「${r.source_name}」（${LIFECYCLE_LABEL[r.source_lifecycle!] ?? r.source_lifecycle}${r.source_lifecycle === "deprecated" ? "，请查继任者" : ""}）`).join("、")}
              {badUpstream.length > 0 && badDownstream.length > 0 ? "；" : ""}
              {badDownstream.map((r) => `下游「${r.target_name}」（${LIFECYCLE_LABEL[r.target_lifecycle!] ?? r.target_lifecycle}${r.target_lifecycle === "deprecated" ? "，请查继任者" : ""}）`).join("、")}
              ——本资产可能受影响，请核查（血缘传播提示；归档/弃用等治理动作仍由人执行）。
            </span>
          </div>
        )}
      </div>
      <SnippetCard teamId={teamId} assetId={assetId} />
      <BundleCard teamId={teamId} assetId={assetId} directRelCount={(rels?.outgoing.length ?? 0) + (rels?.incoming.length ?? 0)} />
      <div className="card">
        <h3>集合</h3>
        {cols === null ? (
          <div className="state" style={{ padding: 0 }}>加载中…</div>
        ) : (
          <>
            {cols.filter((c) => c.contains_asset).length === 0 ? (
              <div style={{ opacity: 0.75, marginBottom: 8 }}>尚未加入任何集合。</div>
            ) : (
              <div style={{ marginBottom: 8 }}>
                {cols.filter((c) => c.contains_asset).map((c) => (
                  <span key={c.id} className="picked-ref" style={{ display: "inline-flex", marginRight: 6 }}>
                    {c.name}
                    <button aria-label={`从集合 ${c.name} 移除`} title={`从集合「${c.name}」移除`} onClick={() => void removeFromCollection(c.id)}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={addToId}
                onChange={(e) => { setAddToId(e.target.value); setColMsg(""); }}
                aria-label="选择要加入的集合"
                style={{ maxWidth: 240 }}
              >
                <option value="">选择集合…</option>
                {cols.filter((c) => !c.contains_asset).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <input
                value={colNote}
                onChange={(e) => setColNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && addToId) { e.preventDefault(); void addToCollection(); } }}
                placeholder="收录备注（可选，如「权威起点」）"
                aria-label="收录备注"
                style={{ width: 200, padding: "1px 6px", fontSize: 12.5 }}
              />
              <button onClick={() => void addToCollection()} disabled={!addToId}>加入</button>
            </div>
            {colMsg && <div className="error-text" style={{ marginTop: 6 }}>{colMsg}</div>}
          </>
        )}
      </div>
      {headArtifacts.length > 0 && (
        <div className="card">
          <h3>制品（当前修订 r{head!.seq}）</h3>
          <table className="list">
            <thead>
              <tr><th>文件</th><th>角色</th><th>大小</th><th>操作</th></tr>
            </thead>
            <tbody>
              {headArtifacts.map((a) => (
                <tr key={a.blob_digest}>
                  <td title={`${a.original_name} · ${a.blob_digest.slice(0, 16)}…`}>{a.original_name}</td>
                  <td><span className="badge">{a.artifact_role}</span></td>
                  <td>{fmtBytes(a.size)}</td>
                  <td>
                    <a className="ref-chip" href={`/api/v1/blobs/${a.blob_digest}?teamId=${teamId}`} download={a.original_name} title="下载制品文件">
                      ⬇ 下载
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!archived && <DraftPanel teamId={teamId} projectId={projectId} asset={detail} role={role} onSaved={reload} />}
      <div className="card">
        <h3>修订历史（不可变）</h3>
        <table className="list">
          <thead>
            <tr><th>修订</th><th>创建时间</th><th>内容摘要</th></tr>
          </thead>
          <tbody>
            {detail.revisions.map((r) => (
              <tr key={r.id}>
                <td>r{r.seq}</td>
                <td>{new Date(r.created_at).toLocaleString()}</td>
                <td><code>{r.content_digest.slice(0, 24)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rels && (
        <div className="card">
          <h3>关系</h3>
          <div className="kv">
            <span className="k">指出去（{rels.outgoing.length}）</span>
            <span>
              {rels.outgoing.length === 0 ? "无" : rels.outgoing.map((r, i) => (
                <Fragment key={r.id}>
                  {i > 0 && "；"}
                  <code>{r.type_key}</code>{" → "}
                  {onOpenAsset && r.target_asset_id ? (
                    <button className="link-btn" title={`打开 ${r.target_name}`} onClick={() => onOpenAsset(r.target_asset_id!)}>{r.target_name}</button>
                  ) : r.target_name}
                </Fragment>
              ))}
            </span>
            <span className="k">被指向（{rels.incoming.length}）</span>
            <span>
              {rels.incoming.length === 0 ? "无" : rels.incoming.map((r, i) => (
                <Fragment key={r.id}>
                  {i > 0 && "；"}
                  {onOpenAsset && r.source_asset_id ? (
                    <button className="link-btn" title={`打开 ${r.source_name}`} onClick={() => onOpenAsset(r.source_asset_id!)}>{r.source_name}</button>
                  ) : r.source_name}
                  {" —"}
                  <code>{r.type_key}</code>
                  {"→ 本资产"}
                </Fragment>
              ))}
            </span>
          </div>
        </div>
      )}
      <NeighborhoodCard teamId={teamId} assetId={assetId} onOpenAsset={onOpenAsset} />
    </>
  );
}

/** 完整度 scorecard 卡（M65，Backstage TechInsights 思想）：分数 + 逐项检查；未通过项给可执行下一步。 */
function CompletenessCard({ report }: { report: NonNullable<AssetDetail["completeness"]> }) {
  const tone = report.score >= 80 ? "#3e7d4e" : report.score >= 50 ? "#8a6d3b" : "#a44646";
  return (
    <div className="card" style={{ marginTop: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <strong style={{ fontSize: 14 }}>完整度</strong>
        <span style={{ fontSize: 22, fontWeight: 700, color: tone }}>{report.score}</span>
        <span className="hint" style={{ margin: 0, fontSize: 11.5 }}>/ 100 · 治理参考（引导不阻断：schema 必填仍由登记关卡强制）</span>
      </div>
      <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
        {report.checks.map((c) => (
          <div key={c.key} style={{ fontSize: 12.5 }}>
            <span style={{ color: c.passed ? "#3e7d4e" : "#a44646", fontWeight: 700 }}>{c.passed ? "✓" : "✗"}</span>{" "}
            <strong>{c.title}</strong>
            <span style={{ color: "var(--muted)" }}>（{c.weight} 分）— {c.detail}</span>
            {!c.passed && (
              <div className="hint" style={{ margin: "2px 0 0 16px", fontSize: 11.5 }}>→ {c.hint}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 目录完整度水位卡（M67⑦，Backstage TechInsights 团队视图）：
 *  平均分 + 三档分桶（与详情卡同阈值），低分清单（<60 升序）可点开直达补元数据。 */
interface CompletenessSummaryView {
  count: number; average: number;
  buckets: { green: number; yellow: number; red: number };
  low: { id: string; name: string; score: number; missingTitles: string[] }[];
  lowThreshold: number; sampled: number; note: string;
}
function CompletenessWatermark({ teamId, onOpen }: { teamId: string; onOpen: (id: string) => void }) {
  const [summary, setSummary] = useState<CompletenessSummaryView | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setSummary(null);
    void api<CompletenessSummaryView>("/assets/completeness-summary", { query: { teamId } })
      .then(setSummary)
      .catch(() => setSummary(null));
  }, [teamId]);
  if (!summary || summary.count === 0) return null;
  const scoreColor = (n: number) => (n >= 80 ? "#2e6b4f" : n >= 50 ? "#8a6d1a" : "#a33a3a");
  return (
    <div style={{ margin: "8px 0 4px", fontSize: 12.5, color: "var(--muted, #666)" }}>
      <span style={{ fontWeight: 650, color: "var(--ink, inherit)" }}>完整度水位</span>{" "}
      平均 <strong style={{ color: scoreColor(summary.average) }}>{summary.average}</strong> 分 ·{" "}
      <span title="80+ 分">🟢 {summary.buckets.green}</span>{" "}
      <span title="50-79 分">🟡 {summary.buckets.yellow}</span>{" "}
      <span title="<50 分">🔴 {summary.buckets.red}</span>{" "}
      （共 {summary.count} 项）
      {summary.low.length > 0 && (
        <button
          className="secondary"
          style={{ marginLeft: 8, padding: "1px 8px", fontSize: 12 }}
          onClick={() => setOpen((v) => !v)}
          title={`${summary.lowThreshold} 分以下的资产，按分数升序——点名称直达详情补元数据`}
        >
          {open ? "收起低分清单" : `低分清单（${summary.low.length}）`}
        </button>
      )}
      {summary.note && <span style={{ marginLeft: 8, opacity: 0.75 }}>({summary.note})</span>}
      {open && (
        <ul style={{ margin: "6px 0 0", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 4 }}>
          {summary.low.map((e) => (
            <li key={e.id} style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
              <span className="badge" style={{ background: scoreColor(e.score), color: "#fff", minWidth: 34, textAlign: "center" }}>{e.score}</span>
              <button className="md-asset-link" onClick={() => onOpen(e.id)}>{e.name}</button>
              <span style={{ opacity: 0.75 }}>缺：{e.missingTitles.join("、") || "—"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 工作分支草稿：选/建分支 → 修改属性（schema 表单/JSON 双模式，M64）→ 保存候选修订 → 创建 CR。 */
function DraftPanel({
  teamId, projectId, asset, role, onSaved,
}: { teamId: string; projectId: string; asset: AssetDetail; role: string; onSaved: () => void }) {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState("");
  const [types, setTypes] = useState<TypeRow[]>([]);
  const [mode, setMode] = useState<"form" | "json">("form");
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [extraJson, setExtraJson] = useState("{}");
  const [prefillNotes, setPrefillNotes] = useState<string[]>([]);
  const [propsJson, setPropsJson] = useState("{}");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    void api<BranchRow[]>(`/projects/${projectId}/branches`, { query: { teamId } })
      .then((rows) => {
        const open = rows.filter((b) => b.status === "open" && b.name !== "main");
        setBranches(open);
        setBranchId((prev) => (open.some((b) => b.id === prev) ? prev : open[0]?.id ?? ""));
      })
      .catch(() => setBranches([]));
  }, [teamId, projectId]);

  useEffect(() => {
    void api<TypeRow[]>("/types", { query: { teamId } }).then(setTypes).catch(() => undefined);
  }, [teamId]);

  const typeRow = types.find((t) => t.type_key === asset.type_key && t.version === asset.type_version);
  const chain = useMemo(() => (typeRow ? chainFromTypes(types, typeRow) : []), [types, typeRow]);
  const spec = useMemo(() => (chain.length > 0 ? schemaToFormSpec(chain) : null), [chain]);
  const gated = chainRequiresTestEvidence(chain);

  // 预填：head 属性 → 表单字符串（spec 就绪后执行；schema 外属性分离到额外属性区）
  useEffect(() => {
    if (!spec) return;
    const head = asset.revisions[0];
    const { values, extra, notes } = propertiesToFormValues(spec.fields, (head?.properties ?? {}) as Record<string, unknown>);
    setFormValues(values);
    setExtraJson(Object.keys(extra).length > 0 ? JSON.stringify(extra, null, 2) : "{}");
    setPrefillNotes(notes);
  }, [spec, asset]);

  useEffect(() => {
    const head = asset.revisions[0];
    setPropsJson(head ? JSON.stringify(head.properties, null, 2) : "{}");
  }, [asset]);

  async function createBranch() {
    const name = window.prompt("新分支名（小写字母/数字/连字符，如 fix-orbit-v2）：");
    if (!name) return;
    try {
      const created = await api<{ branchId: string }>(`/projects/${projectId}/branches`, {
        method: "POST", body: { teamId, name },
      });
      const rows = await api<BranchRow[]>(`/projects/${projectId}/branches`, { query: { teamId } });
      setBranches(rows.filter((b) => b.status === "open" && b.name !== "main"));
      setBranchId(created.branchId);
      setMsg(`分支 ${name} 已创建。`);
    } catch (err) {
      window.alert(err instanceof ApiError ? err.message : "创建分支失败");
    }
  }

  /** 双模式互转不丢内容：表单 → 全量 JSON；JSON → 表单字符串 + 额外属性区。 */
  function switchMode(next: "form" | "json") {
    if (next === mode) return;
    if (next === "json") {
      let extra: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(extraJson || "{}") as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) extra = parsed;
      } catch { /* 坏 extra：按空处理，进 JSON 后由用户修 */ }
      const typed = spec ? formValuesToProperties(spec.fields, formValues).properties : {};
      setPropsJson(JSON.stringify({ ...typed, ...extra }, null, 2));
      setMode("json");
      return;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(propsJson || "{}") as Record<string, unknown>;
    } catch {
      setError("JSON 无法解析，先修正再切换到表单模式。");
      return;
    }
    if (spec) {
      const { values, extra } = propertiesToFormValues(spec.fields, parsed);
      setFormValues(values);
      setExtraJson(Object.keys(extra).length > 0 ? JSON.stringify(extra, null, 2) : "{}");
    }
    setMode("form");
    setError("");
  }

  async function saveDraft() {
    if (!branchId) { window.alert("先选择或创建工作分支。"); return; }
    let properties: Record<string, unknown>;
    if (mode === "form") {
      if (!spec) { window.alert("类型定义未加载，无法用表单模式保存。"); return; }
      const { properties: typed, problems } = formValuesToProperties(spec.fields, formValues);
      let extra: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(extraJson || "{}") as unknown;
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          setError("额外属性区必须是 JSON 对象。"); return;
        }
        extra = parsed;
      } catch {
        setError("额外属性区 JSON 无法解析。"); return;
      }
      // 本地预检（咨询性）：草稿保存是补丁语义（服务端 {...head, ...body} 合并后
      // 校验存储），预检按同一合并视图查——清空的字段沿用 head 值，不会误报缺必填。
      const headProps = (asset.revisions[0]?.properties ?? {}) as Record<string, unknown>;
      const mergedForCheck = { ...headProps, ...typed, ...extra };
      const local = problems.length > 0 ? problems : checkFormValues(spec.fields, mergedForCheck);
      if (local.length > 0) { setError(local.join("；")); return; }
      properties = { ...typed, ...extra };
    } else {
      try { properties = JSON.parse(propsJson || "{}") as Record<string, unknown>; } catch {
        window.alert("属性 JSON 无法解析。"); return;
      }
    }
    setBusy(true); setError(""); setMsg("");
    try {
      let artifacts: unknown[] = [];
      if (file) {
        const up = await uploadFile(teamId, file);
        artifacts = [{ digest: up.digest, role: "implementation", originalName: up.originalName, mediaType: up.mediaType || "application/octet-stream", size: up.size }];
      }
      // 制品字段缺省=沿用 head（M66①）：未选文件时省略 artifacts，服务端继承 head
      // 制品行；只在有新文件时显式提供（替换语义）。
      const bodyPayload: Record<string, unknown> = { teamId, assetId: asset.id, properties };
      if (artifacts.length > 0) bodyPayload.artifacts = artifacts;
      const res = await api<{ revisionId: string; seq: number; contentDigest: string }>(`/branches/${branchId}/revisions`, {
        method: "POST", body: bodyPayload,
      });
      // 与修订历史「内容摘要」同口径展示 contentDigest，而非每次都变的修订 UUID
      setMsg(`草稿已保存：r${res.seq}（摘要 ${res.contentDigest.slice(0, 8)}…）。可用该分支创建 CR。`);
      setFile(null);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function createCR() {
    const title = window.prompt("CR 标题：");
    if (!title) return;
    const motivation = window.prompt("变更动机（为什么改）：");
    if (!motivation) return;
    try {
      const res = await api<{ changeRequestId: string }>("/change-requests", {
        method: "POST",
        body: { teamId, branchId, title, motivation, changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
      });
      setMsg(`CR 已创建（${res.changeRequestId.slice(0, 8)}…）。请到「发布与通道」标签准备审核并发布。`);
    } catch (err) {
      window.alert(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "创建 CR 失败");
    }
  }

  return (
    <div className="card">
      <h3>修改资产（工作分支草稿）</h3>
      <div className="field" style={{ display: "flex", gap: 8 }}>
        <label style={{ alignSelf: "center" }}>工作分支</label>
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)} style={{ flex: 1 }}>
          {branches.length === 0 && <option value="">（无开放分支）</option>}
          {branches.map((b) => (
            <option key={b.id} value={b.id}>{b.name}</option>
          ))}
        </select>
        <button onClick={() => void createBranch()}>新建分支…</button>
      </div>
      <div className="field" style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label style={{ margin: 0 }}>属性编辑</label>
        <button onClick={() => switchMode("form")} disabled={mode === "form"} title="schema 驱动表单（与登记同一套链合并/部件/预检）">表单模式</button>
        <button onClick={() => switchMode("json")} disabled={mode === "json"} title="原始 JSON 文本域（高级编辑兜底）">JSON 模式</button>
        {gated && <span className="hint" style={{ fontSize: 11, margin: 0 }}>🔒 此类型链需测试证据：发布前须有 pass 测试运行</span>}
      </div>
      {mode === "form" ? (
        <>
          {spec ? (
            <SchemaFields
              spec={spec}
              values={formValues}
              onChange={(k, v) => setFormValues({ ...formValues, [k]: v })}
              legendExtra="，保存为新的不可变候选修订"
            />
          ) : (
            <div className="state">类型定义加载中（schema 表单不可用前可切 JSON 模式）。</div>
          )}
          <div className="field">
            <label>额外属性（schema 未声明；JSON 对象，保存时合并）</label>
            <textarea rows={3} value={extraJson} onChange={(e) => setExtraJson(e.target.value)}
              style={{ fontFamily: "var(--mono, monospace)", fontSize: 12, width: "100%" }} />
          </div>
          {prefillNotes.map((n, i) => (
            <div key={i} className="hint" style={{ fontSize: 11 }}>{n}</div>
          ))}
        </>
      ) : (
        <div className="field">
          <label>属性（完整 JSON，保存为新的不可变候选修订）</label>
          <textarea rows={6} value={propsJson} onChange={(e) => setPropsJson(e.target.value)}
            style={{ fontFamily: "var(--mono, monospace)", width: "100%" }} />
        </div>
      )}
      <div className="field">
        <label>替换制品文件（可选）</label>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {msg && <div className="ok-text">{msg}</div>}
      {error && <div className="error-text">{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button className="primary" disabled={busy || !branchId} onClick={() => void saveDraft()}>{busy ? "保存中…" : "保存草稿修订"}</button>
        <button disabled={!branchId} onClick={() => void createCR()}>用当前分支创建 CR…</button>
      </div>
      <div className="hint" style={{ padding: 0 }}>main 为受保护分支：草稿只进工作分支，发布事务才会更新 main 与通道。</div>
    </div>
  );
}

/** 发布与通道：CR 列表 → prepare-review（stable/preview）→ 审核并发布；双通道当前头视图。 */
function ReleasePanel({ project, me }: { project?: ProjectInfo; me: Me }) {
  const [crs, setCrs] = useState<CRRow[] | null>(null);
  const [selected, setSelected] = useState<CRDetail | null>(null);
  const [channel, setChannel] = useState<"stable" | "preview">("stable");
  const [prepResult, setPrepResult] = useState<{ reviewDigest: string; channel: string } | null>(null);
  const [stableHeads, setStableHeads] = useState<ChannelHead[] | null>(null);
  const [previewHeads, setPreviewHeads] = useState<ChannelHead[] | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");

  const isAdmin = me.teams.find((t) => t.teamId === project?.teamId)?.role === "admin";

  const reloadChannels = useCallback(() => {
    if (!project) return;
    void api<ChannelHead[]>(`/projects/${project.projectId}/channel`, { query: { teamId: project.teamId, channel: "stable" } })
      .then(setStableHeads).catch(() => setStableHeads([]));
    void api<ChannelHead[]>(`/projects/${project.projectId}/channel`, { query: { teamId: project.teamId, channel: "preview" } })
      .then(setPreviewHeads).catch(() => setPreviewHeads([]));
  }, [project]);

  const reloadCrs = useCallback(() => {
    if (!project) return;
    void api<CRRow[]>(`/projects/${project.projectId}/change-requests`, { query: { teamId: project.teamId } })
      .then((rows) => {
        setCrs(rows);
        // CR 列表即审批徽标数据源：每次载入同步待办计数（发布/退回后即时生效）
        refreshBadges();
      })
      .catch(() => setCrs([]));
  }, [project]);

  // 通道回滚（M32 补 UI：端点早已存在但界面无入口）。列出该通道经历过的发布集
  // （不含当前头），管理员选序号 + 填原因；服务端在同一事务内移动通道头并盖章。
  async function rollbackChannel(targetChannel: "stable" | "preview") {
    if (!project || !isAdmin) return;
    setError(""); setMsg("");
    try {
      const hist = await api<{ channelId: string; sets: { id: string; kind: string; created_at: string; item_count: number; is_current: boolean }[] }>(
        `/projects/${project.projectId}/release-sets`, { query: { teamId: project.teamId, channel: targetChannel } });
      const usable = hist.sets.filter((s) => !s.is_current);
      if (usable.length === 0) { setError("该通道没有可回滚到的历史发布集。"); return; }
      const list = usable.map((s, i) =>
        `${i + 1}) ${s.kind === "rollback" ? "回滚集" : "发布集"} ${new Date(s.created_at).toLocaleString()}（${s.item_count} 项）`
      ).join("\n");
      const pick = window.prompt(`回滚 ${targetChannel} 通道到哪个发布集？输入序号：\n${list}\n（当前通道头不在此列）`);
      if (!pick) return;
      const target = usable[Number(pick.trim()) - 1];
      if (!target) { setError("序号无效，未执行回滚。"); return; }
      const reason = window.prompt("回滚原因（必填，写入审计与发布事件）：");
      if (!reason) return;
      await api(`/channels/${hist.channelId}/rollback`, {
        method: "POST",
        body: { teamId: project.teamId, toReleaseSetId: target.id, reason },
      });
      setMsg("已回滚：通道头指向目标发布集，同一事务写入发布事件与 release_rollback 审计。");
      reloadChannels();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "回滚失败");
    }
  }

  useEffect(() => {
    setSelected(null);
    setPrepResult(null);
    setMsg("");
    setError("");
    reloadCrs();
    reloadChannels();
  }, [project, reloadCrs, reloadChannels]);

  async function openCr(cr: CRRow) {
    setMsg(""); setError(""); setPrepResult(null);
    try {
      const detail = await api<CRDetail>(`/change-requests/${cr.id}`, { query: { teamId: project!.teamId } });
      setSelected(detail);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "加载 CR 失败");
    }
  }

  async function prepare() {
    if (!project || !selected) return;
    setError(""); setMsg("");
    try {
      const res = await api<{ snapshotId: string; reviewDigest: string; channel: string }>(
        `/change-requests/${selected.id}/prepare-review`,
        { method: "POST", body: { teamId: project.teamId, channel, audience: "team" } }
      );
      setPrepResult({ reviewDigest: res.reviewDigest, channel: res.channel });
      setMsg(`审核快照已生成（${res.channel} 通道）。摘要与内容绑定：内容一变即失效。`);
      const fresh = await api<CRDetail>(`/change-requests/${selected.id}`, { query: { teamId: project.teamId } });
      setSelected(fresh);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "准备审核失败");
    }
  }

  async function publish() {
    // 发布目标与按钮渲染同口径（本地准备结果优先，否则回落服务端有效快照）——
    // 否则审核他人准备的快照时按钮可点却静默无操作（实测走查 M32 修复）
    if (!project || !selected || !publishTarget) return;
    setError(""); setMsg("");
    try {
      await api(`/change-requests/${selected.id}/review-and-publish`, {
        method: "POST", body: { teamId: project.teamId, expectedReviewDigest: publishTarget.reviewDigest, note: "界面发布" },
      });
      setMsg("已发布：批准、发布集、通道头与审计在同一事务写入。");
      setSelected(null);
      setPrepResult(null);
      reloadCrs();
      reloadChannels();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "发布失败");
    }
  }

  async function reject() {
    if (!project || !selected) return;
    const comment = window.prompt("退回原因（将记录为 CR 评论）：");
    if (!comment) return;
    setError(""); setMsg("");
    try {
      await api(`/change-requests/${selected.id}/changes-requested`, {
        method: "POST", body: { teamId: project.teamId, comment },
      });
      setMsg("已退回修改。修改后可重新准备审核。");
      const fresh = await api<CRDetail>(`/change-requests/${selected.id}`, { query: { teamId: project.teamId } });
      setSelected(fresh);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "退回失败");
    }
  }

  if (!project) return <div className="state">先选择项目。</div>;
  const statusLabel: Record<string, string> = {
    draft: "草稿", open: "待提交", awaiting_review: "待审核", changes_requested: "已退回",
    merged: "已发布", withdrawn: "已撤回",
  };
  const activeSnap = selected?.snapshots.find((s) => !s.superseded) ?? null;
  const publishTarget = prepResult ?? (activeSnap ? { reviewDigest: activeSnap.review_digest, channel: activeSnap.channel } : null);
  return (
    <>
      <div className="card">
        <h3>通道当前视图（审批绑定内容摘要，不绑定分支名）</h3>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kv" style={{ marginBottom: 6 }}><span className="k"><strong>stable 稳定通道</strong></span><span>{stableHeads === null ? "…" : `${stableHeads.length} 项`}</span></div>
            {stableHeads?.length === 0 && <div className="state">尚无发布。</div>}
            {stableHeads?.map((h) => (
              <div key={h.asset_id} className="kv" style={{ fontSize: 13 }}>
                <span className="k">{h.asset_name}</span>
                {/* 修订 id 而非内容摘要：明确标注，避免被误读为绑定的内容摘要 */}
                <span>r{h.revision_seq} · {h.version_label ?? "—"} · 修订 <code>{h.revision_id.slice(0, 8)}…</code></span>
              </div>
            ))}
            {isAdmin && stableHeads && stableHeads.length > 0 && (
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button onClick={() => void rollbackChannel("stable")}>回滚 stable…</button>
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kv" style={{ marginBottom: 6 }}><span className="k"><strong>preview 预览通道</strong></span><span>{previewHeads === null ? "…" : `${previewHeads.length} 项`}</span></div>
            {previewHeads?.length === 0 && <div className="state">预览通道为空。发布时选择 preview 可先验证再上稳定通道。</div>}
            {previewHeads?.map((h) => (
              <div key={h.asset_id} className="kv" style={{ fontSize: 13 }}>
                <span className="k">{h.asset_name}</span>
                <span>r{h.revision_seq} · {h.version_label ?? "—"} · 修订 <code>{h.revision_id.slice(0, 8)}…</code></span>
              </div>
            ))}
            {isAdmin && previewHeads && previewHeads.length > 0 && (
              <div className="btn-row" style={{ marginTop: 6 }}>
                <button onClick={() => void rollbackChannel("preview")}>回滚 preview…</button>
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="card">
        <h3>变更请求（CR）</h3>
        {crs === null ? (
          <div className="state">加载中…</div>
        ) : crs.length === 0 ? (
          <div className="state">还没有 CR。在「资产目录」打开资产 → 修改草稿 → 创建 CR。</div>
        ) : (
          <table className="list">
            <thead>
              <tr><th>标题</th><th>分支</th><th>变更项</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>
              {crs.map((c) => (
                <tr key={c.id}>
                  <td>{c.title}</td>
                  <td><code>{c.branch_name}</code></td>
                  <td>{c.item_count}</td>
                  <td><span className="badge">{statusLabel[c.status] ?? c.status}</span></td>
                  <td><button onClick={() => void openCr(c)}>打开</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {selected && (
        <div className="card">
          <h3>{selected.title}</h3>
          <div className="kv">
            <span className="k">状态</span><span>{statusLabel[selected.status] ?? selected.status}</span>
            <span className="k">分支</span><span><code>{selected.branch_name}</code> · 作者 {selected.created_by_name}</span>
            <span className="k">动机</span><span>{selected.motivation}</span>
          </div>
          <div className="cr-items">
            {selected.items.map((i) => <CrItemCard key={i.asset_id} item={i} />)}
          </div>
          {selected.snapshots.length > 0 && (
            <div className="kv" style={{ marginTop: 8 }}>
              <span className="k">审核快照</span>
              <span>
                {selected.snapshots.map((s) => (
                  <div key={s.id} style={{ fontSize: 12.5 }}>
                    {s.channel} · <code>{s.review_digest.slice(0, 16)}…</code> · {s.superseded ? "已失效" : "有效"}
                  </div>
                ))}
              </span>
            </div>
          )}
          {selected.comments.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="cr-diff-label">评审留痕（{selected.comments.length}）</div>
              <CrComments comments={selected.comments} />
            </div>
          )}
          {msg && <div className="ok-text">{msg}</div>}
          {error && <div className="error-text">{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
            {selected.status === "open" || selected.status === "changes_requested" ? (
              <>
                <select aria-label="发布目标通道" value={channel} onChange={(e) => setChannel(e.target.value as "stable" | "preview")}>
                  <option value="stable">stable 稳定通道</option>
                  <option value="preview">preview 预览通道</option>
                </select>
                <button className="primary" onClick={() => void prepare()}>准备审核快照</button>
              </>
            ) : null}
            {publishTarget && selected.status === "awaiting_review" && (
              <>
                <button className="primary" disabled={!isAdmin} title={isAdmin ? "" : "需要团队管理员身份；Agent 也不能代为确认"} onClick={() => void publish()}>
                  审核并发布到 {publishTarget.channel}
                </button>
                <button onClick={() => void reject()}>退回修改</button>
                <code style={{ fontSize: 11 }}>{publishTarget.reviewDigest.slice(0, 24)}…</code>
              </>
            )}
          </div>
          {!isAdmin && <div className="hint">普通成员不能发布；发布前服务端会再次校验身份、作者分离与摘要一致性。</div>}
        </div>
      )}
    </>
  );
}

function AssetRegister({ project, hint, onDone }: { project?: ProjectInfo; hint?: { name?: string; typeKeyHint?: string; nonce: number }; onDone: () => void }) {
  const [types, setTypes] = useState<TypeInfo[]>([]);
  const [typeKey, setTypeKey] = useState("");
  const [name, setName] = useState("");
  const [props, setProps] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ok, setOk] = useState("");
  const [checkResult, setCheckResult] = useState<{ valid: boolean; errors: string[] } | null>(null);

  useEffect(() => {
    if (!project) return;
    void api<TypeInfo[]>("/types", { query: { teamId: project.teamId } }).then(setTypes).catch(() => undefined);
  }, [project]);

  // NL 意图预填（来自 ⌘K AI 解析）：按 typeKeyHint 模糊匹配类型、填名称；只填表单，不自动保存。
  // types 可能晚于 hint 到位（类型表异步加载），故依赖中包含 types 以便就绪后重放匹配。
  const hintNonce = hint?.nonce ?? 0;
  useEffect(() => {
    if (!hintNonce || !hint) return;
    if (hint.typeKeyHint) {
      const kw = hint.typeKeyHint.toLowerCase();
      const hit =
        types.find((t) => t.type_key.toLowerCase() === kw) ??
        types.find((t) => t.type_key.toLowerCase().includes(kw)) ??
        types.find((t) => t.title.includes(hint.typeKeyHint!));
      if (hit) setTypeKey(hit.type_key);
    }
    if (hint.name) setName(hint.name);
  }, [hintNonce, types]);

  const type = types.find((t) => t.type_key === typeKey);

  // 类型链重建与字段规格（M64 抽取到共享 SchemaForm；登记与草稿编辑同源）。
  // 门禁提示前移：链上任一环声明 requires_test_evidence 即提示（发布关卡强制）。
  const chain = useMemo(() => (type ? chainFromTypes(types, type) : []), [types, type]);
  const spec = useMemo(() => (chain.length > 0 ? schemaToFormSpec(chain) : null), [chain]);
  const gated = chainRequiresTestEvidence(chain);

  if (!project) return <div className="state">先选择项目。</div>;

  // 表单字符串 → 类型化属性：与 spec 同源换算（布尔/整数/数值数组/JSON），
  // 解析失败收集为 problems 就地展示，不抛异常；提交与「校验」共用，口径不可能分叉。
  function coerce(): { properties: Record<string, unknown>; problems: string[] } {
    if (!spec) return { properties: {}, problems: [] };
    return formValuesToProperties(spec.fields, props);
  }

  /** 本地预检（M62，咨询性）：换算问题优先，否则按字段规格查确定性约束；服务端 ajv 仍是权威关卡。 */
  function precheck(): string[] {
    if (!spec) return [];
    const { properties, problems } = coerce();
    return problems.length > 0 ? problems : checkFormValues(spec.fields, properties);
  }

  return (
    <div className="card">
      <h3>登记资产</h3>
      <div className="field">
        <label>资产类型（同一套版本与审批机制覆盖所有类型；↳ 表示继承父类型）</label>
        <select value={typeKey} onChange={(e) => { setTypeKey(e.target.value); setProps({}); }}>
          <option value="">选择类型…</option>
          {types.map((t) => {
            const parentKey = t.parent_type_key ? `${t.parent_type_key} v${t.parent_version}` : null;
            return (
              <option key={t.id} value={t.type_key}>
                {parentKey ? "↳ " : ""}{t.title}（{t.type_key} v{t.version}{parentKey ? ` ← ${parentKey}` : ""}）
              </option>
            );
          })}
        </select>
      </div>
      <div className="field">
        <label>资产名称</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {type && gated && (
        <div className="hint" style={{ fontSize: 12 }}>
          🔒 此类型链声明「需测试证据」：发布前必须有绑定候选修订内容的 pass 测试运行（登记与草稿不受阻，发布关卡强制）。
        </div>
      )}
      {type && spec && (
        <SchemaFields
          spec={spec}
          values={props}
          onChange={(k, v) => setProps({ ...props, [k]: v })}
          legendExtra={`，登记时按 v${type.version} 及全部祖先定义校验`}
        />
      )}
      <div className="field">
        <label>制品文件（可选；内容寻址存储，重复文件自动去重）</label>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {error && <div className="error-text">{error}</div>}
      {ok && <div className="ok-text">{ok}</div>}
      {checkResult && (checkResult.valid ? (
        <div className="ok-text">✓ 属性满足当前类型链的全部定义（含祖先），可以登记</div>
      ) : (
        <div className="error-text">
          {checkResult.errors.map((e, i) => <div key={i}>⚠ {e}</div>)}
        </div>
      ))}
      <div className="form-actions">
        <button
          disabled={busy || !typeKey}
          title="先本地预检（字段规格：必填/枚举/词表/范围/长度/格式），通过后按类型链做服务端全链 dry-run（与登记同一关卡，零副作用；M59/M62）"
          onClick={() => {
            if (!type || !project || !spec) return;
            setError(""); setOk(""); setCheckResult(null);
            const local = precheck();
            if (local.length > 0) {
              setCheckResult({ valid: false, errors: local.map((e) => `本地预检：${e}`) });
              return;
            }
            const { properties } = coerce();
            void api<{ valid: boolean; errors: string[] }>("/assets/validate", {
              method: "POST",
              body: { teamId: project.teamId, typeVersionId: type.id, properties },
            })
              .then(setCheckResult)
              .catch((err) => setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "校验失败"));
          }}
        >
          校验
        </button>
        <button
          className="primary"
          disabled={busy || !typeKey || !name}
          onClick={async () => {
            if (!type || !project || !spec) return;
            setBusy(true);
            setError("");
            setOk("");
            try {
              // 本地预检拦截（M62）：换算失败或确定性约束不过，就地报错，不做必然失败的网络往返
              const local = precheck();
              if (local.length > 0) {
                setError(local.join("；"));
                return;
              }
              const cleaned = coerce().properties;
              let artifacts: unknown[] = [];
              if (file) {
                const up = await uploadFile(project.teamId, file);
                artifacts = [{
                  digest: up.digest,
                  role: "implementation",
                  originalName: up.originalName,
                  mediaType: up.mediaType || "application/octet-stream",
                  size: up.size,
                }];
              }
              const res = await api<{ assetId: string }>("/assets", {
                method: "POST",
                body: { teamId: project.teamId, name, typeVersionId: type.id, properties: cleaned, artifacts },
              });
              setOk(`已登记：${res.assetId}`);
              onDone();
            } catch (err) {
              setError(err instanceof ApiError ? `${err.message}${err.details ? `：${JSON.stringify(err.details)}` : ""}` : "登记失败");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "提交中…" : "登记"}
        </button>
      </div>
    </div>
  );
}
