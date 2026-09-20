// ⌘K 命令栏（吸收 AgentPM CommandBar）：页面跳转 + 资产搜索；键盘优先，Esc 关闭。
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

export function CommandBar({
  open,
  onClose,
  pages,
  onNavigate,
  teamId,
  onOpenAsset,
}: {
  open: boolean;
  onClose: () => void;
  pages: { key: PageKey; label: string; icon: string }[];
  onNavigate: (page: PageKey) => void;
  teamId: string;
  onOpenAsset: (assetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setCursor(0);
      setAssets([]);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

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
    const all = query.trim() ? assetCmds : pageCmds;
    // 有查询时页面跳转仍保留在下方，资产结果置顶
    return query.trim() ? [...assetCmds, ...pageCmds] : all;
  }, [pages, assets, query, onNavigate, onClose]);

  if (!open) return null;

  const execute = (i: number) => {
    const cmd = commands[i];
    if (cmd) cmd.run();
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="命令栏" onMouseDown={onClose}>
      <div className="commandbar" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索资产，或输入页面名跳转…"
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor((c) => Math.min(c + 1, commands.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor((c) => Math.max(c - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              execute(cursor);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <ul className="commandlist">
          {commands.length === 0 && <li className="command-empty">无匹配结果</li>}
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
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
