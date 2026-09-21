import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, uploadFile } from "../api";
import type { Me } from "../App";
import { DashboardPage, ActivityPage, ApprovalsPage } from "../components/ProjectPages";
import { RelationGraph } from "../components/RelationGraph";
import { OntologyPage } from "../components/OntologyPage";
import { SemanticPanel } from "../components/SemanticPanel";
import { AgentProposals } from "../components/AgentProposals";
import { CommandBar, type NlIntentPayload } from "../components/CommandBar";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay";
import { createGoPrefixHandler, isTypingTarget, type PageKey } from "../lib/shortcuts";

const RAIL_PAGES: { key: PageKey; label: string; icon: string }[] = [
  { key: "dashboard", label: "总览", icon: "◈" },
  { key: "workbench", label: "工作台", icon: "▤" },
  { key: "activity", label: "动态", icon: "≡" },
  { key: "approvals", label: "审批", icon: "✓" },
  { key: "graph", label: "图谱", icon: "⚭" },
  { key: "ontology", label: "本体", icon: "⌗" },
];

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface SessionInfo { sessionId: string; title: string; visibility: string; mine: boolean; archived: boolean }
interface Msg { id: string; role: string; content: string; seq: number }
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string; head_revision_id: string; content_digest: string }
interface TypeInfo { id: string; type_key: string; version: string; title: string; parent_type_key?: string | null; parent_version?: string | null; json_schema: { required?: string[]; properties?: Record<string, { type?: string; enum?: string[]; title?: string }> } }
interface AssetDetail {
  id: string; name: string; lifecycle: string; type_key: string; type_version: string;
  revisions: { id: string; seq: number; content_digest: string; properties: object; created_at: string }[];
  labels: string[]; categories: { category_path: string; is_primary: boolean }[];
}
interface Relations { outgoing: RelRow[]; incoming: RelRow[] }
interface RelRow { id: string; type_key: string; status: string; source_name: string; target_name: string }

export function Workbench({ me, onLoggedOut }: { me: Me; onLoggedOut: () => void }) {
  const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
  const [projectsError, setProjectsError] = useState("");
  const [projectId, setProjectId] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [mobileView, setMobileView] = useState<"chat" | "workspace">("chat");
  const [wsView, setWsView] = useState<"overview" | "assets" | "register" | "semantic" | "proposals" | "release">("overview");
  const [assetId, setAssetId] = useState("");
  const [page, setPage] = useState<PageKey>("dashboard");
  const [cmdOpen, setCmdOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [cmdSeed, setCmdSeed] = useState<{ query: string; nonce: number }>({ query: "", nonce: 0 });
  const [registerHint, setRegisterHint] = useState<{ name?: string; typeKeyHint?: string; nonce: number }>({ nonce: 0 });
  // 轻量操作反馈（NL 建工单等异步结果）；6 秒自动消失
  const [flash, setFlash] = useState<{ text: string; tone: "ok" | "error"; nonce: number } | null>(null);
  // NL「聚焦 X 的图谱」解析出的聚焦资产（已聚焦同一资产时无需重复注入）
  const [graphFocus, setGraphFocus] = useState<{ id: string; nonce: number } | null>(null);
  // NL「看归档记录」等意图预置的动态 action 过滤（M26）；nonce 变化即重复应用
  const [activityPreset, setActivityPreset] = useState<{ action: string; nonce: number } | null>(null);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(t);
  }, [flash]);

  useEffect(() => {
    void api<ProjectInfo[]>("/projects")
      .then((p) => {
        setProjects(p);
        if (p[0]) setProjectId(p[0].projectId);
      })
      .catch((e) => setProjectsError(e instanceof ApiError ? e.message : "无法连接服务"));
  }, []);

  const project = useMemo(() => projects?.find((p) => p.projectId === projectId), [projects, projectId]);

  useEffect(() => {
    if (!project) return;
    void api<SessionInfo[]>(`/projects/${project.projectId}/sessions`, { query: { teamId: project.teamId } })
      .then(setSessions)
      .catch(() => setSessions([]));
  }, [project]);

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
        <button aria-label="切换导航抽屉" title="导航抽屉（项目 / Session）" onClick={() => setDrawerOpen(!drawerOpen)}>
          ☰
        </button>
        <span className="title">工作集</span>
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
        <span className="status">{sessions.find((s) => s.sessionId === sessionId)?.title ?? "未选择会话"}</span>
        <span className="spacer" />
        <span className="status">已连接</span>
        <span className="status">{me.displayName}</span>
        <button onClick={logout}>退出</button>
      </header>

      <div className="body">
        <nav className="rail" aria-label="主导航">
          {RAIL_PAGES.map((p) => (
            <button
              key={p.key}
              className={`rail-item${page === p.key ? " active" : ""}`}
              title={p.label}
              aria-label={p.label}
              onClick={() => setPage(p.key)}
            >
              <span className="rail-icon" aria-hidden="true">{p.icon}</span>
              <span className="rail-label">{p.label}</span>
            </button>
          ))}
          <button className="rail-item" title="命令栏（Ctrl/⌘+K）" aria-label="打开命令栏" onClick={() => setCmdOpen(true)}>
            <span className="rail-icon" aria-hidden="true">⌘</span>
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
            <RelationGraph project={project} onOpenAsset={openAssetFromSearch} initialFocusId={graphFocus?.id} />
          </main>
        ) : page === "ontology" ? (
          <main className="page-main" aria-label="本体治理">
            <OntologyPage project={project} me={me} />
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
                  await api("/projects", { method: "POST", body: { teamId: me.teams[0].teamId, name, code } });
                  reloadProjects();
                } catch (err) {
                  window.alert(err instanceof ApiError ? err.message : "创建失败");
                }
              }
            }}
          >
            ＋ 新建项目
          </button>
          {projectsError && <div className="empty">{projectsError}</div>}
          {projects?.length === 0 && <div className="empty">还没有项目。先新建一个项目。</div>}
          {projects?.map((p) => (
            <div className="project" key={p.projectId}>
              <div className="project-name">{p.name}</div>
              {p.projectId === projectId && (
                <button
                  className="new-btn"
                  style={{ margin: "2px 4px 6px", padding: "2px" }}
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
                  ＋ 新建会话
                </button>
              )}
              {p.projectId === projectId && sessions.length === 0 && <div className="empty">暂无会话</div>}
              {p.projectId === projectId &&
                sessions.map((s) => (
                  <button
                    key={s.sessionId}
                    className={`session${s.sessionId === sessionId ? " active" : ""}`}
                    onClick={() => {
                      setSessionId(s.sessionId);
                      setMobileView("chat");
                    }}
                  >
                    {s.visibility === "private" ? "🔒 " : ""}
                    {s.title}
                  </button>
                ))}
            </div>
          ))}
        </nav>

        <div className={`main${mobileView === "workspace" ? " show-workspace" : ""}`}>
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
          />
          <section className="workspace" aria-label="工作区">
            <div className="ws-tabs">
              {(
                [
                  ["overview", "项目概况"],
                  ["assets", "资产目录"],
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

function ProjectOverview({ project, me }: { project?: ProjectInfo; me: Me }) {
  if (!project) return <div className="state">选择或创建一个项目开始。</div>;
  return (
    <>
      <div className="card">
        <h3>{project.name}</h3>
        <div className="kv">
          <span className="k">项目代号</span><span>{project.code}</span>
          <span className="k">状态</span><span>{project.status === "active" ? "进行中" : project.status === "completed" ? "已结题" : "已归档"}</span>
          <span className="k">我的团队角色</span><span>{me.teams.find((t) => t.teamId === project.teamId)?.role === "admin" ? "团队管理员" : "成员"}</span>
        </div>
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

interface ToolInvocation { call_id: string; name: string; args: unknown; result: unknown; status: string; error: string }
interface RunRecord { id: string; status: string; prompt: string; result: unknown; error: string; created_at: string; invocations: ToolInvocation[] }
interface RunToolBlock { callId: string; name: string; args: unknown; state: "running" | "ok" | "denied" | "error"; result?: unknown; error?: string }
/** 界面侧的运行视图：事件流实时更新；历史运行从 /sessions/:id/runs 重建。 */
interface RunView { id: string; status: string; text: string; note: string; streaming: boolean; tools: RunToolBlock[] }

const displayToolName = (wire: string) => wire.replace(/__/g, ".");

function AgentPane({ project, sessionId }: { project?: ProjectInfo; sessionId: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [runs, setRuns] = useState<RunView[]>([]);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  const loadHistory = useCallback((teamId: string, sid: string) => {
    void api<Msg[]>(`/sessions/${sid}/messages`, { query: { teamId } })
      .then(setMsgs)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载会话失败"));
    void api<RunRecord[]>(`/sessions/${sid}/runs`, { query: { teamId } })
      .then((rows) =>
        setRuns(
          rows.map((r) => ({
            id: r.id,
            status: r.status,
            text: typeof r.result === "object" && r.result !== null && "finalText" in (r.result as object)
              ? String((r.result as { finalText?: string }).finalText ?? "")
              : "",
            note: r.error,
            streaming: false,
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
    esRef.current?.close();
    esRef.current = null;
    if (!project || !sessionId) return;
    loadHistory(project.teamId, sessionId);
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, [project, sessionId, loadHistory]);

  function openEventStream(teamId: string, runId: string) {
    const es = new EventSource(`/api/v1/runs/${runId}/events?teamId=${teamId}`);
    esRef.current = es;
    const patch = (fn: (r: RunView) => RunView) =>
      setRuns((prev) => prev.map((r) => (r.id === runId ? fn(r) : r)));
    es.addEventListener("tool_call", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { callId: string; name: string; args: unknown };
      patch((r) => ({ ...r, tools: [...r.tools, { callId: p.callId, name: displayToolName(p.name), args: p.args, state: "running" }] }));
    });
    es.addEventListener("tool_result", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { callId: string; status: string; result: unknown; error: string };
      patch((r) => ({
        ...r,
        tools: r.tools.map((t) =>
          t.callId === p.callId
            ? { ...t, state: p.status === "ok" ? "ok" : p.status === "denied" ? "denied" : "error", result: p.result, error: p.error }
            : t
        ),
      }));
    });
    es.addEventListener("message", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { role: string; text: string };
      if (p.role === "assistant") patch((r) => ({ ...r, text: p.text }));
    });
    es.addEventListener("completed", (e) => {
      const p = JSON.parse((e as MessageEvent).data) as { finalText: string };
      patch((r) => ({ ...r, text: p.finalText, status: "completed", streaming: false }));
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
      if (esRef.current === es) esRef.current = null;
    });
    es.onerror = () => { /* EventSource 自动按 Last-Event-ID 重连续传 */ };
  }

  async function send() {
    if (!project || !sessionId || !text.trim()) return;
    setSending(true);
    setError("");
    const content = text.trim();
    setText("");
    try {
      // 真实 LLM 运行：创建运行（同时持久化用户消息），SSE 流式接工具事件与回复
      const created = await api<{ runId: string }>(`/sessions/${sessionId}/runs`, {
        method: "POST",
        body: { teamId: project.teamId, prompt: content },
      });
      setRuns((prev) => [...prev, { id: created.runId, status: "running", text: "", note: "", streaming: true, tools: [] }]);
      openEventStream(project.teamId, created.runId);
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

  const anyStreaming = runs.some((r) => r.streaming);
  return (
    <aside className="agent-pane" aria-label="Agent 对话区">
      <div className="pane-label">AGENT · {project?.name ?? "未选择项目"}</div>
      <div className="messages">
        {msgs === null && !error && <div className="state">{sessionId ? "加载会话…" : "从左侧选择一个会话。"}</div>}
        {error && <div className="state error">{error}</div>}
        {msgs?.length === 0 && runs.length === 0 && (
          <div className="state">开始这段会话。发送任务给 Agent（真实模型执行，工具调用全程可见），或先在右侧登记资产。</div>
        )}
        {msgs?.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="who">{m.role === "user" ? "我" : m.role === "assistant" ? "Agent" : "系统"}</div>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
        {runs.map((r) => (
          <div key={r.id} className="msg assistant" data-run-status={r.status}>
            <div className="who">
              Agent 运行
              <span className="badge" style={{ marginLeft: 6 }}>{
                r.status === "running" ? "运行中" : r.status === "completed" ? "已完成"
                : r.status === "blocked" ? "已暂停" : r.status === "cancelled" ? "已取消"
                : r.status === "failed" ? "失败" : "对账中"
              }</span>
            </div>
            {r.tools.length > 0 && (
              <div className="run-tools">
                {r.tools.map((t) => (
                  <details key={t.callId} className="run-tool">
                    <summary>
                      <span className={`tool-state ${t.state}`}>
                        {t.state === "running" ? "…" : t.state === "ok" ? "✓" : t.state === "denied" ? "⛔" : "✗"}
                      </span>
                      <code>{t.name}</code>
                      <span className="tool-summary">
                        {t.state === "running" ? "执行中" : t.state === "denied" ? "权限网关拒绝" : t.state === "error" ? `出错：${t.error}` : "完成"}
                      </span>
                    </summary>
                    <pre className="run-tool-detail">{JSON.stringify(t.args, null, 2)}</pre>
                    {t.state === "ok" && t.result != null && (
                      <pre className="run-tool-detail">{JSON.stringify(t.result, null, 2).slice(0, 800)}</pre>
                    )}
                  </details>
                ))}
              </div>
            )}
            {r.text && <div className="bubble">{r.text}</div>}
            {r.streaming && !r.text && <div className="bubble">正在思考并调用工具…</div>}
            {r.note && <div className="bubble" style={{ color: "var(--muted)" }}>{r.note}</div>}
            {r.streaming && (
              <button style={{ marginTop: 6 }} onClick={() => void cancelRun(r.id)}>取消运行</button>
            )}
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          placeholder="给 Agent 派任务（真实模型 + 工具：资产检索 / 建提案 / 建 Issue）…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <button onClick={() => void send()} disabled={sending || anyStreaming || !text.trim() || !sessionId}>
          {sending ? "发送中" : anyStreaming ? "运行中" : "发送"}
        </button>
      </div>
      <div className="hint">Ctrl+Enter 发送 · Agent 仅草稿写入权限，发布等高权动作必须由人类执行</div>
    </aside>
  );
}

function AssetList({ project, onOpen, onRegister }: { project?: ProjectInfo; onOpen: (id: string) => void; onRegister: () => void }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  const [lifecycle, setLifecycle] = useState("active");

  useEffect(() => {
    setAssets(null);
    if (!project) return;
    void api<AssetRow[]>("/assets/search", { query: { teamId: project.teamId, q: keyword, lifecycle } })
      .then(setAssets)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [project, keyword, lifecycle]);

  if (!project) return <div className="state">先选择项目。</div>;
  if (error) return <div className="state error">{error}</div>;
  return (
    <div className="card">
      <h3>
        团队资产目录{" "}
        <button className="secondary" style={{ marginLeft: 12 }} onClick={onRegister}>
          登记新资产
        </button>
      </h3>
      <div className="field" style={{ display: "flex", gap: 8 }}>
        <input placeholder="按名称搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} style={{ flex: 1 }} />
        <select aria-label="生命周期过滤" value={lifecycle} onChange={(e) => setLifecycle(e.target.value)}>
          <option value="active">进行中</option>
          <option value="archived">已归档</option>
          <option value="all">全部</option>
        </select>
      </div>
      {assets === null ? (
        <div className="state">加载中…</div>
      ) : assets.length === 0 ? (
        <div className="state">
          {lifecycle === "archived" ? "没有已归档资产。" : "暂无资产。上传文件并登记后出现在这里。"}
        </div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>类型版本</th>
              <th>状态</th>
              <th>修订摘要</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} onClick={() => onOpen(a.id)}>
                <td>{a.name}</td>
                <td><span className="badge">{a.type_key}</span></td>
                <td>{a.type_version}</td>
                <td>
                  {a.lifecycle === "archived"
                    ? <span className="badge" style={{ background: "#6b5b3e", color: "#fff" }}>已归档</span>
                    : a.lifecycle === "deprecated"
                      ? <span className="badge" style={{ background: "#5a5a66", color: "#fff" }}>已弃用</span>
                      : <span className="badge" style={{ background: "#2e6b4f", color: "#fff" }}>进行中</span>}
                </td>
                <td><code>{a.content_digest.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface BranchRow { id: string; name: string; status: string; created_at: string; created_by_name: string; changed_assets: number }
interface CRRow { id: string; title: string; status: string; created_at: string; created_by_name: string; branch_name: string; item_count: number }
interface CRSnap { id: string; candidate_digest: string; review_digest: string; channel: string; superseded: boolean; created_at: string }
interface CRDetail {
  id: string; title: string; status: string; branch_name: string; created_by_name: string;
  motivation: string; items: { asset_id: string; asset_name: string; base_seq: number; candidate_seq: number }[];
  snapshots: CRSnap[];
}
interface ChannelHead { asset_id: string; asset_name: string; revision_id: string; revision_seq: number; version_label: string | null; updated_at: string }

function AssetDetailPanel({ teamId, projectId, assetId, role }: { teamId: string; projectId: string; assetId: string; role: string }) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [rels, setRels] = useState<Relations | null>(null);
  const [error, setError] = useState("");
  const [lifecycleMsg, setLifecycleMsg] = useState("");

  async function reload() {
    try {
      setDetail(await api<AssetDetail>(`/assets/${assetId}`, { query: { teamId } }));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "加载失败");
    }
  }

  useEffect(() => {
    setDetail(null);
    setError("");
    setLifecycleMsg("");
    void reload();
    void api<Relations>("/relations", { query: { teamId, assetId } })
      .then(setRels)
      .catch(() => setRels(undefined as unknown as Relations));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, assetId]);

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

  if (error) return <div className="state error">{error}</div>;
  if (!detail) return <div className="state">加载中…</div>;
  const head = detail.revisions[0];
  const archived = detail.lifecycle === "archived";
  return (
    <>
      <div className="card">
        <h3>
          {detail.name}
          {archived && (
            <span className="badge" style={{ background: "#6b5b3e", color: "#fff", marginLeft: 8 }}>已归档</span>
          )}
        </h3>
        <div className="kv">
          <span className="k">类型</span><span><span className="badge">{detail.type_key}</span>v{detail.type_version}</span>
          <span className="k">生命周期</span><span>{archived ? "已归档（目录默认视图隐藏，禁止新草稿）" : detail.lifecycle === "deprecated" ? "已弃用" : "进行中"}</span>
          <span className="k">分类</span><span>{detail.categories.map((c) => c.category_path).join(" · ") || "—"}</span>
          <span className="k">标签</span><span>{detail.labels.join(" · ") || "—"}</span>
          {head && (
            <>
              <span className="k">当前修订</span><span>r{head.seq} · 摘要 <code>{head.content_digest.slice(0, 16)}…</code></span>
            </>
          )}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
          {archived ? (
            <button onClick={() => void changeLifecycle("restore")}>恢复资产</button>
          ) : (
            <button onClick={() => void changeLifecycle("archive")}>归档资产…</button>
          )}
          {lifecycleMsg && <span className="ok-text" style={{ alignSelf: "center" }}>{lifecycleMsg}</span>}
        </div>
      </div>
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
            <span>{rels.outgoing.map((r) => `${r.type_key} → ${r.target_name}`).join("；") || "无"}</span>
            <span className="k">被指向（{rels.incoming.length}）</span>
            <span>{rels.incoming.map((r) => `${r.source_name} —${r.type_key}→ 本资产`).join("；") || "无"}</span>
          </div>
        </div>
      )}
    </>
  );
}

/** 工作分支草稿：选/建分支 → 修改属性（可选附文件）→ 保存候选修订 → 创建 CR。 */
function DraftPanel({
  teamId, projectId, asset, role, onSaved,
}: { teamId: string; projectId: string; asset: AssetDetail; role: string; onSaved: () => void }) {
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [branchId, setBranchId] = useState("");
  const [propsJson, setPropsJson] = useState("");
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

  async function saveDraft() {
    if (!branchId) { window.alert("先选择或创建工作分支。"); return; }
    let properties: unknown;
    try { properties = JSON.parse(propsJson || "{}"); } catch {
      window.alert("属性 JSON 无法解析。"); return;
    }
    setBusy(true); setError(""); setMsg("");
    try {
      let artifacts: unknown[] = [];
      if (file) {
        const up = await uploadFile(teamId, file);
        artifacts = [{ digest: up.digest, role: "implementation", originalName: up.originalName, mediaType: up.mediaType || "application/octet-stream", size: up.size }];
      }
      const res = await api<{ revisionId: string; seq: number }>(`/branches/${branchId}/revisions`, {
        method: "POST", body: { teamId, assetId: asset.id, properties, artifacts },
      });
      setMsg(`草稿已保存：r${res.seq}（${res.revisionId.slice(0, 8)}…）。可用该分支创建 CR。`);
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
      <div className="field">
        <label>属性（完整 JSON，保存为新的不可变候选修订）</label>
        <textarea rows={6} value={propsJson} onChange={(e) => setPropsJson(e.target.value)}
          style={{ fontFamily: "monospace", width: "100%" }} />
      </div>
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
      .then(setCrs).catch(() => setCrs([]));
  }, [project]);

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
    if (!project || !selected || !prepResult) return;
    setError(""); setMsg("");
    try {
      await api(`/change-requests/${selected.id}/review-and-publish`, {
        method: "POST", body: { teamId: project.teamId, expectedReviewDigest: prepResult.reviewDigest, note: "界面发布" },
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
                <span>r{h.revision_seq} · {h.version_label ?? "—"} · <code>{h.revision_id.slice(0, 8)}…</code></span>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 260 }}>
            <div className="kv" style={{ marginBottom: 6 }}><span className="k"><strong>preview 预览通道</strong></span><span>{previewHeads === null ? "…" : `${previewHeads.length} 项`}</span></div>
            {previewHeads?.length === 0 && <div className="state">预览通道为空。发布时选择 preview 可先验证再上稳定通道。</div>}
            {previewHeads?.map((h) => (
              <div key={h.asset_id} className="kv" style={{ fontSize: 13 }}>
                <span className="k">{h.asset_name}</span>
                <span>r{h.revision_seq} · {h.version_label ?? "—"} · <code>{h.revision_id.slice(0, 8)}…</code></span>
              </div>
            ))}
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
          <table className="list" style={{ marginTop: 8 }}>
            <thead><tr><th>资产</th><th>基线</th><th>候选</th></tr></thead>
            <tbody>
              {selected.items.map((i) => (
                <tr key={i.asset_id}>
                  <td>{i.asset_name}</td>
                  <td>r{i.base_seq}</td>
                  <td>r{i.candidate_seq}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const fields = useMemo(() => Object.entries(type?.json_schema.properties ?? {}), [type]);

  if (!project) return <div className="state">先选择项目。</div>;

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
      {type && fields.length > 0 && (
        <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
          <legend style={{ fontSize: 13, color: "var(--muted)" }}>
            类型属性（* 必填，由类型定义 v{type.version} 校验）
          </legend>
          {fields.map(([key, schema]) => (
            <div className="field" key={key}>
              <label>
                {key}
                {type.json_schema.required?.includes(key) ? " *" : ""}
                {schema.enum ? `（${schema.enum.join(" / ")}）` : ""}
              </label>
              {schema.enum ? (
                <select value={props[key] ?? ""} onChange={(e) => setProps({ ...props, [key]: e.target.value })}>
                  <option value="">—</option>
                  {schema.enum.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              ) : (
                <input
                  value={props[key] ?? ""}
                  onChange={(e) => setProps({ ...props, [key]: e.target.value })}
                  placeholder={schema.type === "number" ? "数字" : schema.type === "object" ? "JSON 对象" : "文本"}
                />
              )}
            </div>
          ))}
        </fieldset>
      )}
      <div className="field">
        <label>制品文件（可选；内容寻址存储，重复文件自动去重）</label>
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      {error && <div className="error-text">{error}</div>}
      {ok && <div className="ok-text">{ok}</div>}
      <div className="form-actions">
        <button
          className="primary"
          disabled={busy || !typeKey || !name}
          onClick={async () => {
            if (!type || !project) return;
            setBusy(true);
            setError("");
            setOk("");
            try {
              // 属性类型修正：数字与对象
              const cleaned: Record<string, unknown> = {};
              for (const [key, schema] of Object.entries(type.json_schema.properties ?? {})) {
                const raw = props[key];
                if (raw === undefined || raw === "") continue;
                if (schema.type === "number") cleaned[key] = Number(raw);
                else if (schema.type === "integer") cleaned[key] = parseInt(raw, 10);
                else if (schema.type === "object") cleaned[key] = JSON.parse(raw);
                else if (schema.type === "array") cleaned[key] = raw.split(/[,，]/).map((s) => s.trim());
                else cleaned[key] = raw;
              }
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
