// ⌘K 命令栏（吸收 AgentPM CommandBar 双模）：页面跳转 + 资产搜索 + 自然语言意图（真实 LLM）。
// 键盘优先，Esc 关闭。NL 意图由后端 /nl/parse 解析（规则 L1 / DeepSeek L2，带溯源），
// 执行只映射到既有界面动作：跳转 / 搜索 / 预填登记表单——不产生新的服务端写权限。
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { PageKey } from "../lib/shortcuts";

interface AssetRow { id: string; name: string; lifecycle: string; type_key: string; type_version: string }

interface Command {
  id: string;
  icon: string;
  title: string;
  sub: string;
  run: () => void;
}

export interface NlIntentPayload {
  intent: "navigate" | "search_assets" | "fill_register_form" | "create_issue";
  params: { page?: PageKey; query?: string; typeKeyHint?: string; name?: string; title?: string; body?: string };
  parser: { kind: "rules" | "llm"; model?: string; tokens?: number; note?: string };
}

export function describeIntent(i: NlIntentPayload): string {
  if (i.intent === "navigate") {
    const names: Record<string, string> = {
      dashboard: "总览", workbench: "工作台", activity: "团队动态", approvals: "审批队列", graph: "关系图谱",
      ontology: "本体治理", proposals: "Agent 提案",
    };
    return `跳转到「${names[i.params.page ?? "dashboard"]}」`;
  }
  if (i.intent === "search_assets") return `搜索资产：${i.params.query ?? ""}`;
  if (i.intent === "create_issue") return `起草问题工单（确认后才创建）`;
  return `预填登记表单${i.params.typeKeyHint ? `（类型含 "${i.params.typeKeyHint}"）` : ""}${i.params.name ? `，名称 "${i.params.name}"` : ""}`;
}

export function CommandBar({
  open,
  onClose,
  pages,
  onNavigate,
  teamId,
  onOpenAsset,
  page,
  seedQuery,
  onExecuteNl,
}: {
  open: boolean;
  onClose: () => void;
  pages: { key: PageKey; label: string; icon: string }[];
  onNavigate: (page: PageKey) => void;
  teamId: string;
  onOpenAsset: (assetId: string) => void;
  page: PageKey;
  seedQuery?: { query: string; nonce: number };
  onExecuteNl: (payload: NlIntentPayload) => boolean;  // 返回 true = 执行后关闭；false = 保持打开（如回填搜索）
}) {
  const [query, setQuery] = useState("");
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const [nl, setNl] = useState<NlIntentPayload | null>(null);
  const [nlBusy, setNlBusy] = useState(false);
  const [nlError, setNlError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const seedRef = useRef(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setAssets([]);
      setNl(null);
      setNlError("");
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // NL 执行后回填搜索词（如 search_assets 意图）
  useEffect(() => {
    if (seedQuery && seedQuery.nonce !== seedRef.current) {
      seedRef.current = seedQuery.nonce;
      setQuery(seedQuery.query);
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [seedQuery]);

  // 资产搜索防抖 250ms；空查询不出资产结果
  useEffect(() => {
    if (!open || !teamId) return;
    const q = query.trim();
    if (!q) {
      setAssets([]);
      return;
    }
    const t = window.setTimeout(() => {
      void api<AssetRow[]>("/assets/search", { query: { teamId, q, limit: "8" } })
        .then(setAssets)
        .catch(() => setAssets([]));
    }, 250);
    return () => window.clearTimeout(t);
  }, [query, open, teamId]);

  const commands = useMemo<Command[]>(() => {
    const pageCmds: Command[] = pages.map((p) => ({
      id: `page:${p.key}`,
      icon: p.icon,
      title: p.label,
      sub: "跳转页面",
      run: () => {
        onNavigate(p.key);
        onClose();
      },
    }));
    const assetCmds: Command[] = assets.map((a) => ({
      id: `asset:${a.id}`,
      icon: a.lifecycle === "archived" ? "🗄" : "📦",
      title: a.name,
      sub: `${a.type_key} v${a.type_version}${a.lifecycle === "archived" ? " · 已归档" : ""}`,
      run: () => {
        onOpenAsset(a.id);
        onClose();
      },
    }));
    return query.trim() ? [...assetCmds, ...pageCmds] : pageCmds;
  }, [pages, assets, query, onNavigate, onClose, onOpenAsset]);

  if (!open) return null;

  const execute = (i: number) => {
    const cmd = commands[i];
    if (cmd) cmd.run();
  };

  async function parseNl() {
    const text = query.trim();
    if (!text || !teamId) return;
    setNlBusy(true);
    setNlError("");
    setNl(null);
    try {
      const res = await api<NlIntentPayload>("/nl/parse", {
        method: "POST",
        body: { teamId, text, page },
      });
      setNl(res);
    } catch (err) {
      setNlError(err instanceof Error ? err.message : "解析失败");
    } finally {
      setNlBusy(false);
    }
  }

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="命令栏" onMouseDown={onClose}>
      <div className="commandbar" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索资产、跳转页面，或输入中文指令让 AI 解析…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
            setNl(null);
            setNlError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, commands.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter" && (e.altKey || e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void parseNl();
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (nl) {
                const shouldClose = onExecuteNl(nl);
                setNl(null);
                if (shouldClose) onClose();
              } else {
                execute(cursor);
              }
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        {nlError && <div className="error-text" style={{ padding: "4px 14px" }}>{nlError}</div>}
        {nl && (
          <div className="nl-card">
            <div className="nl-head">
              <span className="nl-intent">{describeIntent(nl)}</span>
              <span className={`chip ${nl.parser.kind === "llm" ? "" : "chip-dim"}`} title={nl.parser.note ?? ""}>
                {nl.parser.kind === "llm" ? `LLM·${nl.parser.model ?? ""}${nl.parser.tokens ? ` · ${nl.parser.tokens} tokens` : ""}` : "规则解析"}
              </span>
            </div>
            {nl.parser.note && <div className="nl-note">{nl.parser.note}</div>}
            {nl.intent === "create_issue" && (
              <div className="nl-preview">
                <div className="nl-preview-title">{nl.params.title || "（无标题）"}</div>
                {nl.params.body && <div className="nl-preview-body">{nl.params.body}</div>}
                <div className="nl-note">写类操作双重确认：点「执行」才会调用真实接口创建工单；解析本身不落库。</div>
              </div>
            )}
            <div className="btn-row">
              <button className="primary" onClick={() => { const shouldClose = onExecuteNl(nl); setNl(null); if (shouldClose) onClose(); }}>执行</button>
              <button onClick={() => setNl(null)}>取消</button>
            </div>
          </div>
        )}
        <ul className="commandlist">
          {commands.length === 0 && !nl && <li className="command-empty">无匹配结果 — 可按 Ctrl+Enter 让 AI 解析这条指令</li>}
          {commands.map((c, i) => (
            <li key={c.id}>
              <button
                className={`commandrow${i === cursor ? " active" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => execute(i)}
              >
                <span className="command-icon" aria-hidden="true">{c.icon}</span>
                <span className="command-title">{c.title}</span>
                <span className="command-sub">{c.sub}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="commandbar-foot">
          <span>↑↓ 选择</span>
          <span>Enter 执行</span>
          <button className="nl-trigger" onClick={() => void parseNl()} disabled={nlBusy || !query.trim()}>
            {nlBusy ? "AI 解析中…" : "🤖 AI 解析（Ctrl+Enter）"}
          </button>
          <span style={{ flex: 1 }} />
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
