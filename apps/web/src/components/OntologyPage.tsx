// 本体治理台：把 M8 的本体治理能力（类型层次 / 关系类型 / 迁移预演 / 质量门 / 导出）
// 从 API 提供给人类管理员。数据全部来自真实端点（GET /types、GET /relation-types、
// POST /types、POST /relation-types、POST /types|relation-types/migration-preview）。
// 登记与预演仅管理员可用（服务端二次校验角色，界面隐藏只是第一道门）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../App";
import { Empty } from "./Empty";

interface ProjectInfo { teamId: string; projectId: string; name: string; code: string; status: string }

interface PropSchema { type?: string; enum?: string[]; title?: string }
interface TypeInfo {
  id: string; type_key: string; version: string; title: string; status: string;
  parent_type_version_id?: string | null;
  parent_type_key?: string | null; parent_version?: string | null;
  json_schema: { required?: string[]; properties?: Record<string, PropSchema> };
}
interface RelTypeInfo {
  id: string; type_key: string; version: string; title: string;
  source_kinds: string[]; target_kinds: string[];
  source_type_keys: string[]; target_type_keys: string[];
  cyclic: boolean; is_symmetric: boolean; requires_revision: boolean;
  assertion_count?: number;
}

// 与 packages/domain ENTITY_KINDS 一致（前端只读副本）
const ENTITY_KINDS = ["asset", "project", "requirement", "test_run", "evidence", "issue", "work_item"];

const DEFAULT_SCHEMA = `{
  "required": [],
  "properties": {}
}`;

/** 下载本体工件（taw-ontology/1 JSON 或确定性 Turtle 序列化）。 */
async function downloadOntology(project: ProjectInfo, format: "turtle" | "json"): Promise<void> {
  const qs = new URLSearchParams({ teamId: project.teamId });
  if (format === "turtle") qs.set("format", "turtle");
  const res = await fetch(`/api/v1/ontology/export?${qs}`, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`导出失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ontology-${project.code}.${format === "turtle" ? "ttl" : "json"}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function OntologyPage({ project, me }: { project?: ProjectInfo; me: Me }) {
  const [types, setTypes] = useState<TypeInfo[] | null>(null);
  const [relTypes, setRelTypes] = useState<RelTypeInfo[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const isAdmin = me.teams.find((t) => t.teamId === project?.teamId)?.role === "admin";

  const reload = useCallback(() => {
    if (!project) return;
    setError("");
    void api<TypeInfo[]>("/types", { query: { teamId: project.teamId } })
      .then(setTypes)
      .catch((e) => setError(e instanceof ApiError ? e.message : "加载类型失败"));
    void api<RelTypeInfo[]>("/relation-types", { query: { teamId: project.teamId } })
      .then(setRelTypes)
      .catch(() => setRelTypes([]));
  }, [project]);

  useEffect(reload, [reload]);

  const childrenOf = useMemo(() => {
    const m = new Map<string, TypeInfo[]>();
    for (const t of types ?? []) {
      const p = t.parent_type_version_id ?? "";
      const list = m.get(p) ?? [];
      list.push(t);
      m.set(p, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.type_key.localeCompare(b.type_key));
    return m;
  }, [types]);

  const roots = useMemo(
    () => (types ?? []).filter((t) => !t.parent_type_version_id).sort((a, b) => a.type_key.localeCompare(b.type_key)),
    [types]
  );

  if (!project) return <Empty icon="🗂" title="选择一个项目" hint="本体按团队治理：类型层次、关系类型与迁移预演。" />;
  if (error) return <div className="state error">{error}</div>;

  return (
    <div className="page">
      <div className="page-head">
        <h2>本体治理</h2>
        <span className="chip chip-dim">{types?.length ?? "…"} 类版本 · {relTypes?.length ?? "…"} 关系类型</span>
        {!isAdmin && <span className="chip chip-dim">只读（管理员可变更）</span>}
        <button onClick={() => void downloadOntology(project, "turtle")} title="下载本体（RDF Turtle，确定性序列化）">导出 Turtle</button>
        <button onClick={() => void downloadOntology(project, "json")} title="下载本体（taw-ontology/1 JSON）">导出 JSON</button>
        <button onClick={reload}>刷新</button>
      </div>
      {notice && <div className="ok-text">{notice}</div>}

      <ClassTree roots={roots} childrenOf={childrenOf} />

      <RelationTypes relTypes={relTypes} />

      <UnitVocabCard teamId={project.teamId} />

      {isAdmin && (
        <>
          <RegisterType project={project} types={types ?? []} onDone={(msg) => { setNotice(msg); reload(); }} />
          <RegisterRelationType project={project} existing={relTypes ?? []} onDone={(msg) => { setNotice(msg); reload(); }} />
          <TypeMigrationPreview project={project} types={types ?? []} />
          <RelationMigrationPreview project={project} relTypes={relTypes ?? []} />
        </>
      )}
      {!types && !error && <div className="state">正在加载本体…</div>}
    </div>
  );
}

/** 类层次树：subClassOf 收窄继承的可视化；节点可展开查看属性定义。 */
function ClassTree({ roots, childrenOf }: { roots: TypeInfo[]; childrenOf: Map<string, TypeInfo[]> }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>类层次（资产类型 · subClassOf 收窄继承）</h3>
      </div>
      {roots.length === 0 && <Empty icon="⌗" title="还没有注册类型" hint="登记资产时会自动播种默认类型；管理员可注册自定义类型。" />}
      <ul className="onto-tree">
        {roots.map((t) => (
          <TreeNode key={t.id} t={t} depth={0} childrenOf={childrenOf} />
        ))}
      </ul>
    </section>
  );
}

function TreeNode({ t, depth, childrenOf }: { t: TypeInfo; depth: number; childrenOf: Map<string, TypeInfo[]> }) {
  const [open, setOpen] = useState(depth === 0);
  const children = childrenOf.get(t.id) ?? [];
  const props = Object.entries(t.json_schema.properties ?? {});
  const required = t.json_schema.required ?? [];
  return (
    <li className="onto-node" style={{ marginLeft: depth * 18 }}>
      <div className="onto-row">
        <button className="onto-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "▾" : "▸"}
        </button>
        <span className="onto-title">{t.title}</span>
        <span className="badge">{t.type_key}</span>
        <span className="onto-version">v{t.version}</span>
        {t.parent_type_key && (
          <span className="onto-parent">← {t.parent_type_key} v{t.parent_version}</span>
        )}
        <span className={`chip ${t.status === "active" ? "chip-ok" : "chip-dim"}`}>{t.status === "active" ? "active" : t.status}</span>
      </div>
      {open && (
        <>
          {props.length > 0 && (
            <table className="list onto-props">
              <thead><tr><th>属性</th><th>类型</th><th>必填</th><th>枚举</th></tr></thead>
              <tbody>
                {props.map(([name, s]) => (
                  <tr key={name}>
                    <td><code>{name}</code></td>
                    <td>{s.type ?? "—"}</td>
                    <td>{required.includes(name) ? "*" : ""}</td>
                    <td>{s.enum ? s.enum.join(" / ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {children.length > 0 && (
            <ul className="onto-tree">
              {children.map((c) => <TreeNode key={c.id} t={c} depth={depth + 1} childrenOf={childrenOf} />)}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

function RelationTypes({ relTypes }: { relTypes: RelTypeInfo[] | null }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>关系类型（ObjectProperty · domain/range 强制执行）</h3>
      </div>
      {relTypes === null && <div className="state">加载中…</div>}
      {relTypes !== null && relTypes.length === 0 && (
        <Empty icon="⚭" title="还没有关系类型" hint="语义候选确认或手动断言关系前，需要先注册关系类型。" />
      )}
      {relTypes !== null && relTypes.length > 0 && (
        <table className="list">
          <thead>
            <tr>
              <th>类型</th><th>版本</th><th>说明</th><th>domain</th><th>range</th><th>约束</th><th>断言</th>
            </tr>
          </thead>
          <tbody>
            {relTypes.map((r) => (
              <tr key={r.id}>
                <td><code>{r.type_key}</code></td>
                <td>v{r.version}</td>
                <td>{r.title}</td>
                <td>{renderSide(r.source_kinds, r.source_type_keys)}</td>
                <td>{renderSide(r.target_kinds, r.target_type_keys)}</td>
                <td className="onto-constraints">
                  {r.cyclic && <span className="chip chip-dim">可成环</span>}
                  {r.is_symmetric && <span className="chip chip-dim">对称</span>}
                  {r.requires_revision && <span className="chip chip-dim">需绑定修订</span>}
                  {!r.cyclic && !r.is_symmetric && !r.requires_revision && "—"}
                </td>
                <td>{r.assertion_count ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function renderSide(kinds: string[], typeKeys: string[]): React.ReactNode {
  if (typeKeys.length > 0) return typeKeys.map((k) => <span key={k} className="badge" style={{ marginRight: 4 }}>{k}</span>);
  return <span className="onto-parent">kind:{kinds.join("|")}</span>;
}

/** 受控单位词表：来自语义 worker GET /units（与候选结构校验同一定义点）。
 *  worker 不可达时如实提示降级，不伪造词表。 */
function UnitVocabCard({ teamId }: { teamId: string }) {
  const [units, setUnits] = useState<Record<string, string[]> | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    setUnits(null);
    setError("");
    api<{ units: Record<string, string[]> }>("/semantic/units", { query: { teamId } })
      .then((r) => { if (alive) setUnits(r.units); })
      .catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [teamId]);

  return (
    <section className="card">
      <div className="card-head">
        <h3>受控单位词表（语义结构校验同源）</h3>
        {units !== null && <span className="chip chip-dim">{Object.keys(units).length} 属性键</span>}
      </div>
      <p className="hint" style={{ padding: 0 }}>
        语义候选结构校验（validate_candidates）使用的受控词表；登记类型时按此填写单位型属性，越表值会被如实标出。
      </p>
      {error && <div className="error-text">单位词表暂不可用（语义 worker 降级，不影响本体治理）：{error}</div>}
      {units !== null && Object.keys(units).length === 0 && (
        <Empty icon="🧮" title="词表为空" hint="worker 未定义任何受控单位。" />
      )}
      {units !== null && Object.entries(units).map(([key, values]) => (
        <div key={key} className="onto-units-row">
          <code>{key}</code>
          <span>{values.map((v) => <span key={v} className="badge" style={{ marginRight: 4 }}>{v}</span>)}</span>
        </div>
      ))}
      {units === null && !error && <div className="state">加载词表…</div>}
    </section>
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.message}${err.details ? `：${JSON.stringify(err.details).slice(0, 300)}` : ""}`;
  }
  return err instanceof Error ? err.message : "操作失败";
}

/** 登记类型（admin）：typeKey/版本/标题/父类型/JSON Schema；质量门错误如实展示。 */
function RegisterType({ project, types, onDone }: { project: ProjectInfo; types: TypeInfo[]; onDone: (msg: string) => void }) {
  const [typeKey, setTypeKey] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");
  const [schemaText, setSchemaText] = useState(DEFAULT_SCHEMA);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    setBusy(true); setError("");
    try {
      const jsonSchema = JSON.parse(schemaText);
      const res = await api<{ typeVersionId: string }>("/types", {
        method: "POST",
        body: {
          teamId: project.teamId, typeKey, version, title, jsonSchema,
          ...(parentId ? { parentTypeVersionId: parentId } : {}),
        },
      });
      onDone(`类型已登记：${typeKey} v${version}（${res.typeVersionId.slice(0, 8)}…）`);
      setTypeKey(""); setTitle(""); setParentId(""); setSchemaText(DEFAULT_SCHEMA);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card onto-form">
      <summary><h3>登记新类型（管理员）</h3></summary>
      <div className="onto-grid">
        <label>类型键 type_key<input value={typeKey} onChange={(e) => setTypeKey(e.target.value)} placeholder="如 simulation.report" /></label>
        <label>版本<input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.0.0" /></label>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="仿真报告" /></label>
        <label>父类型（subClassOf，子定义必须是父定义的收窄）
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">无父类型</option>
            {types.filter((t) => t.status === "active").map((t) => (
              <option key={t.id} value={t.id}>{t.title}（{t.type_key} v{t.version}）</option>
            ))}
          </select>
        </label>
      </div>
      <label>JSON Schema（必填属性放 required；单位词表对应 &lt;name&gt; 或 &lt;name&gt;Unit 属性）
        <textarea rows={6} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} style={{ fontFamily: "monospace", width: "100%" }} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="btn-row">
        <button className="primary" disabled={busy || !typeKey || !title} onClick={() => void submit()}>{busy ? "提交中…" : "登记类型"}</button>
      </div>
    </details>
  );
}

/** 登记关系类型（admin）：kind 级 + 类级 domain/range。 */
function RegisterRelationType({ project, existing, onDone }: { project: ProjectInfo; existing: RelTypeInfo[]; onDone: (msg: string) => void }) {
  const [typeKey, setTypeKey] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [title, setTitle] = useState("");
  const [sourceKinds, setSourceKinds] = useState<string[]>(["asset"]);
  const [targetKinds, setTargetKinds] = useState<string[]>(["asset"]);
  const [sourceTypeKeys, setSourceTypeKeys] = useState("");
  const [targetTypeKeys, setTargetTypeKeys] = useState("");
  const [cyclic, setCyclic] = useState(false);
  const [isSymmetric, setIsSymmetric] = useState(false);
  const [requiresRevision, setRequiresRevision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const splitKeys = (s: string): string[] => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

  async function submit() {
    setBusy(true); setError("");
    try {
      await api("/relation-types", {
        method: "POST",
        body: {
          teamId: project.teamId, typeKey, version, title,
          sourceKinds, targetKinds,
          sourceTypeKeys: splitKeys(sourceTypeKeys), targetTypeKeys: splitKeys(targetTypeKeys),
          cyclic, isSymmetric, requiresRevision,
        },
      });
      onDone(`关系类型已登记：${typeKey} v${version}`);
      setTypeKey(""); setTitle(""); setSourceTypeKeys(""); setTargetTypeKeys("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const knownKeys = [...new Set(existing.map((r) => r.type_key))];
  return (
    <details className="card onto-form">
      <summary><h3>登记关系类型（管理员）</h3></summary>
      <div className="onto-grid">
        <label>类型键<input value={typeKey} onChange={(e) => setTypeKey(e.target.value)} placeholder="如 verifies" /></label>
        <label>版本<input value={version} onChange={(e) => setVersion(e.target.value)} /></label>
        <label>标题<input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label>domain type_keys（逗号分隔，空 = 不限类型）
          <input value={sourceTypeKeys} onChange={(e) => setSourceTypeKeys(e.target.value)} placeholder={knownKeys.slice(0, 3).join(", ") || "document, software"} />
        </label>
        <label>range type_keys（逗号分隔，空 = 不限类型）
          <input value={targetTypeKeys} onChange={(e) => setTargetTypeKeys(e.target.value)} />
        </label>
      </div>
      <div className="onto-kinds">
        <fieldset>
          <legend>domain kinds</legend>
          {ENTITY_KINDS.map((k) => (
            <label key={k} className="onto-kind">
              <input
                type="checkbox"
                checked={sourceKinds.includes(k)}
                onChange={(e) => setSourceKinds(e.target.checked ? [...sourceKinds, k] : sourceKinds.filter((x) => x !== k))}
              />
              {k}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>range kinds</legend>
          {ENTITY_KINDS.map((k) => (
            <label key={k} className="onto-kind">
              <input
                type="checkbox"
                checked={targetKinds.includes(k)}
                onChange={(e) => setTargetKinds(e.target.checked ? [...targetKinds, k] : targetKinds.filter((x) => x !== k))}
              />
              {k}
            </label>
          ))}
        </fieldset>
        <fieldset>
          <legend>约束</legend>
          <label className="onto-kind"><input type="checkbox" checked={cyclic} onChange={(e) => setCyclic(e.target.checked)} />允许成环</label>
          <label className="onto-kind"><input type="checkbox" checked={isSymmetric} onChange={(e) => setIsSymmetric(e.target.checked)} />对称</label>
          <label className="onto-kind"><input type="checkbox" checked={requiresRevision} onChange={(e) => setRequiresRevision(e.target.checked)} />断言需绑定修订</label>
        </fieldset>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="btn-row">
        <button className="primary" disabled={busy || !typeKey || !title} onClick={() => void submit()}>{busy ? "提交中…" : "登记关系类型"}</button>
      </div>
    </details>
  );
}

interface PreviewResult { safe: boolean; [k: string]: unknown }

/** 类型迁移预演（admin，只读）：影响资产数 / 头修订失败样例 / 结构变化 / 层次波及。 */
function TypeMigrationPreview({ project, types }: { project: ProjectInfo; types: TypeInfo[] }) {
  const activeKeys = [...new Set(types.filter((t) => t.status === "active").map((t) => t.type_key))].sort();
  const [typeKey, setTypeKey] = useState("");
  const current = types.find((t) => t.type_key === typeKey && t.status === "active");
  const [schemaText, setSchemaText] = useState("");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function pick(key: string) {
    setTypeKey(key);
    setResult(null);
    setError("");
    const t = types.find((x) => x.type_key === key && x.status === "active");
    if (t) setSchemaText(JSON.stringify(t.json_schema, null, 2));
  }

  async function preview() {
    setBusy(true); setError(""); setResult(null);
    try {
      const r = await api<PreviewResult>("/types/migration-preview", {
        method: "POST",
        body: { teamId: project.teamId, typeKey, jsonSchema: JSON.parse(schemaText) },
      });
      setResult(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="card onto-form">
      <summary><h3>类型迁移预演（管理员 · 只读，不写入）</h3></summary>
      <div className="onto-grid">
        <label>目标类型（当前 active 版本）
          <select value={typeKey} onChange={(e) => pick(e.target.value)}>
            <option value="">选择类型…</option>
            {activeKeys.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>
      <label>新版本 JSON Schema（在此编辑后预演）
        <textarea rows={6} value={schemaText} onChange={(e) => setSchemaText(e.target.value)} style={{ fontFamily: "monospace", width: "100%" }} disabled={!typeKey} />
      </label>
      {error && <div className="error-text">{error}</div>}
      <div className="btn-row">
        <button className="primary" disabled={busy || !typeKey || !schemaText.trim()} onClick={() => void preview()}>{busy ? "预演中…" : "预演影响"}</button>
      </div>
      {result && <PreviewReport r={result} />}
    </details>
  );
}

/** 关系类型迁移预演（admin，只读）：domain/range 违规 / 存量成环 / 结构变化。 */
function RelationMigrationPreview({ project, relTypes }: { project: ProjectInfo; relTypes: RelTypeInfo[] }) {
  const [typeKey, setTypeKey] = useState("");
  const current = relTypes.find((r) => r.type_key === typeKey);
  const [sourceTypeKeys, setSourceTypeKeys] = useState("");
  const [targetTypeKeys, setTargetTypeKeys] = useState("");
  const [cyclic, setCyclic] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function pick(key: string) {
    setTypeKey(key);
    setResult(null);
    setError("");
    const r = relTypes.find((x) => x.type_key === key);
    if (r) {
      setSourceTypeKeys(r.source_type_keys.join(", "));
      setTargetTypeKeys(r.target_type_keys.join(", "));
      setCyclic(r.cyclic);
    }
  }

  async function preview() {
    if (!current) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const split = (s: string) => s.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      const r = await api<PreviewResult>("/relation-types/migration-preview", {
        method: "POST",
        body: {
          teamId: project.teamId, typeKey,
          sourceTypeKeys: split(sourceTypeKeys), targetTypeKeys: split(targetTypeKeys), cyclic,
        },
      });
      setResult(r);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const knownKeys = [...new Set(relTypes.flatMap((r) => [...r.source_type_keys, ...r.target_type_keys]))];
  return (
    <details className="card onto-form">
      <summary><h3>关系类型迁移预演（管理员 · 只读，不写入）</h3></summary>
      <div className="onto-grid">
        <label>关系类型
          <select value={typeKey} onChange={(e) => pick(e.target.value)}>
            <option value="">选择关系类型…</option>
            {[...new Set(relTypes.map((r) => r.type_key))].sort().map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
        <label>新 domain type_keys（逗号分隔）
          <input value={sourceTypeKeys} onChange={(e) => setSourceTypeKeys(e.target.value)} placeholder={knownKeys.slice(0, 3).join(", ")} disabled={!typeKey} />
        </label>
        <label>新 range type_keys（逗号分隔）
          <input value={targetTypeKeys} onChange={(e) => setTargetTypeKeys(e.target.value)} disabled={!typeKey} />
        </label>
        <label className="onto-kind" style={{ alignSelf: "end" }}>
          <input type="checkbox" checked={cyclic} onChange={(e) => setCyclic(e.target.checked)} disabled={!typeKey} />允许成环
        </label>
      </div>
      {error && <div className="error-text">{error}</div>}
      <div className="btn-row">
        <button className="primary" disabled={busy || !typeKey} onClick={() => void preview()}>{busy ? "预演中…" : "预演影响"}</button>
      </div>
      {result && <PreviewReport r={result} />}
    </details>
  );
}

/** 预演结果渲染：safe 绿 / 否则红，列表字段逐条展示。 */
function PreviewReport({ r }: { r: PreviewResult }) {
  const listFields = Object.entries(r).filter(([, v]) => Array.isArray(v)) as [string, unknown[]][];
  const plainFields = Object.entries(r).filter(([, v]) => !Array.isArray(v) && typeof v !== "object");
  return (
    <div className={`onto-preview ${r.safe ? "preview-ok" : "preview-warn"}`}>
      <div className="onto-preview-head">
        {r.safe ? "✅ 预演通过：可安全迁移" : "⚠️ 预演发现阻塞项：直接迁移会破坏存量数据"}
      </div>
      <table className="list">
        <tbody>
          {plainFields.map(([k, v]) => (
            <tr key={k}><td><code>{k}</code></td><td>{String(v)}</td></tr>
          ))}
          {listFields.map(([k, list]) => (
            <tr key={k}>
              <td><code>{k}</code>（{list.length}）</td>
              <td>{list.length === 0 ? "—" : <ul className="onto-preview-list">{list.map((item, i) => <li key={i}>{typeof item === "string" ? item : JSON.stringify(item)}</li>)}</ul>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
