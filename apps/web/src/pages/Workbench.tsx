import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, uploadFile } from "../api";
import type { Me } from "../App";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }
interface SessionInfo { sessionId: string; title: string; visibility: string; mine: boolean; archived: boolean }
interface Msg { id: string; role: string; content: string; seq: number }
interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string; head_revision_id: string; content_digest: string }
interface TypeInfo { id: string; type_key: string; version: string; title: string; json_schema: { required?: string[]; properties?: Record<string, { type?: string; enum?: string[]; title?: string }> } }
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
  const [wsView, setWsView] = useState<"overview" | "assets" | "register">("overview");
  const [assetId, setAssetId] = useState("");

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
              <AssetDetailPanel teamId={project.teamId} assetId={assetId} />
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
            ) : (
              <AssetRegister
                project={project}
                onDone={() => {
                  setWsView("assets");
                  setMobileView("workspace");
                }}
              />
            )}
          </section>
        </div>
      </div>
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
          <li>左侧对话区可以继续会话；Agent 智能助手将在 M4 接入，所有基础操作无需等待模型。</li>
        </ul>
      </div>
    </>
  );
}

function AgentPane({ project, sessionId }: { project?: ProjectInfo; sessionId: string }) {
  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [error, setError] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setMsgs(null);
    setError("");
    if (!project || !sessionId) return;
    void api<Msg[]>(`/sessions/${sessionId}/messages`, { query: { teamId: project.teamId } })
      .then(setMsgs)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载会话失败"));
  }, [project, sessionId]);

  async function send() {
    if (!project || !sessionId || !text.trim()) return;
    setSending(true);
    setError("");
    const content = text.trim();
    try {
      await api(`/sessions/${sessionId}/messages`, {
        method: "POST",
        body: { teamId: project.teamId, role: "user", content },
      });
      setText("");
      const updated = await api<Msg[]>(`/sessions/${sessionId}/messages`, { query: { teamId: project.teamId } });
      setMsgs(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "发送失败");
    } finally {
      setSending(false);
    }
  }

  return (
    <aside className="agent-pane" aria-label="Agent 对话区">
      <div className="pane-label">AGENT · {project?.name ?? "未选择项目"}</div>
      <div className="messages">
        {msgs === null && !error && <div className="state">{sessionId ? "加载会话…" : "从左侧选择一个会话。"}</div>}
        {error && <div className="state error">{error}</div>}
        {msgs?.length === 0 && (
          <div className="state">开始这段会话。你可以先在右侧「登记资产」完成上传与登记；Agent 助手稍后接入。</div>
        )}
        {msgs?.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            <div className="who">{m.role === "user" ? "我" : m.role === "assistant" ? "Agent" : "系统"}</div>
            <div className="bubble">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          placeholder="输入消息…（Agent 将在后续里程碑接入；上传、登记、检索等操作不依赖模型）"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void send();
          }}
        />
        <button onClick={() => void send()} disabled={sending || !text.trim() || !sessionId}>
          {sending ? "发送中" : "发送"}
        </button>
      </div>
      <div className="hint">Ctrl+Enter 发送 · 会话内容持久化保存</div>
    </aside>
  );
}

function AssetList({ project, onOpen, onRegister }: { project?: ProjectInfo; onOpen: (id: string) => void; onRegister: () => void }) {
  const [assets, setAssets] = useState<AssetRow[] | null>(null);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");

  useEffect(() => {
    setAssets(null);
    if (!project) return;
    void api<AssetRow[]>("/assets/search", { query: { teamId: project.teamId, q: keyword } })
      .then(setAssets)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
  }, [project, keyword]);

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
      <div className="field">
        <input placeholder="按名称搜索…" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      </div>
      {assets === null ? (
        <div className="state">加载中…</div>
      ) : assets.length === 0 ? (
        <div className="state">暂无资产。上传文件并登记后出现在这里。</div>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>类型版本</th>
              <th>修订摘要</th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id} onClick={() => onOpen(a.id)}>
                <td>{a.name}</td>
                <td><span className="badge">{a.type_key}</span></td>
                <td>{a.type_version}</td>
                <td><code>{a.content_digest.slice(0, 12)}…</code></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AssetDetailPanel({ teamId, assetId }: { teamId: string; assetId: string }) {
  const [detail, setDetail] = useState<AssetDetail | null>(null);
  const [rels, setRels] = useState<Relations | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setDetail(null);
    setError("");
    void api<AssetDetail>(`/assets/${assetId}`, { query: { teamId } })
      .then(setDetail)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载失败"));
    void api<Relations>("/relations", { query: { teamId, assetId } })
      .then(setRels)
      .catch(() => setRels(undefined as unknown as Relations));
  }, [teamId, assetId]);

  if (error) return <div className="state error">{error}</div>;
  if (!detail) return <div className="state">加载中…</div>;
  const head = detail.revisions[0];
  return (
    <>
      <div className="card">
        <h3>{detail.name}</h3>
        <div className="kv">
          <span className="k">类型</span><span><span className="badge">{detail.type_key}</span>v{detail.type_version}</span>
          <span className="k">生命周期</span><span>{detail.lifecycle}</span>
          <span className="k">分类</span><span>{detail.categories.map((c) => c.category_path).join(" · ") || "—"}</span>
          <span className="k">标签</span><span>{detail.labels.join(" · ") || "—"}</span>
          {head && (
            <>
              <span className="k">当前修订</span><span>r{head.seq} · 摘要 <code>{head.content_digest.slice(0, 16)}…</code></span>
            </>
          )}
        </div>
      </div>
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

function AssetRegister({ project, onDone }: { project?: ProjectInfo; onDone: () => void }) {
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

  const type = types.find((t) => t.type_key === typeKey);
  const fields = useMemo(() => Object.entries(type?.json_schema.properties ?? {}), [type]);

  if (!project) return <div className="state">先选择项目。</div>;

  return (
    <div className="card">
      <h3>登记资产</h3>
      <div className="field">
        <label>资产类型（同一套版本与审批机制覆盖所有类型）</label>
        <select value={typeKey} onChange={(e) => { setTypeKey(e.target.value); setProps({}); }}>
          <option value="">选择类型…</option>
          {types.map((t) => (
            <option key={t.id} value={t.type_key}>
              {t.title}（{t.type_key} v{t.version}）
            </option>
          ))}
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
