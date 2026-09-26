// 轻量安全 Markdown 渲染器：为 Agent 回复设计。
// 全程构造 React 元素（文本节点由 React 自动转义），不使用 dangerouslySetInnerHTML。
// 支持：代码围栏、行内代码、粗体/斜体/删除线、http(s) 链接、标题(≤h4)、
// 无序/有序列表（平铺）、引用块、分隔线、GFM 表格、段落与软换行。
// renderText（可选）：对纯文本叶节点做变换（如资产名链接化，M44）；
// 行内代码、围栏代码与链接文本不经过该变换。
import { Fragment, type ReactNode } from "react";

/** 纯文本叶节点变换：输入一段原始文本与稳定 key，返回替换后的节点。 */
export type TextTransform = (text: string, key: string) => ReactNode;

export function Markdown({ text, className, renderText }: { text: string; className?: string; renderText?: TextTransform }) {
  return <div className={`md${className ? ` ${className}` : ""}`}>{renderBlocks(text, renderText)}</div>;
}

/* ---------------- 行内 ---------------- */

type InlineRule = { re: RegExp; tag: "code" | "link" | "strong" | "del" | "em" };

// 顺序即同位置冲突时的优先级：code 内不再解析；bold 先于 em（如 **x**）
const INLINE_RULES: InlineRule[] = [
  { re: /`([^`]+)`/, tag: "code" },
  { re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, tag: "link" },
  { re: /\*\*([^*]+)\*\*/, tag: "strong" },
  { re: /~~([^~]+)~~/, tag: "del" },
  { re: /\*([^*\n]+)\*/, tag: "em" },
];

function renderInline(src: string, keyPrefix: string, tx?: TextTransform): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = src;
  let n = 0;
  const pushText = (s: string) => {
    if (!s) return;
    out.push(tx ? tx(s, `${keyPrefix}-t${n++}`) : s);
  };
  while (rest.length > 0) {
    let best: { idx: number; len: number; rule: InlineRule; m: RegExpMatchArray } | null = null;
    for (const rule of INLINE_RULES) {
      const m = rest.match(rule.re);
      if (!m || m.index === undefined) continue;
      if (!best || m.index < best.idx || (m.index === best.idx && INLINE_RULES.indexOf(rule) < INLINE_RULES.indexOf(best.rule))) {
        best = { idx: m.index, len: m[0].length, rule, m };
      }
    }
    if (!best) {
      pushText(rest);
      break;
    }
    if (best.idx > 0) pushText(rest.slice(0, best.idx));
    const key = `${keyPrefix}-${n++}`;
    const inner = best.m[1] ?? "";
    if (best.rule.tag === "code") out.push(<code key={key} className="md-code">{inner}</code>);
    else if (best.rule.tag === "link")
      out.push(
        <a key={key} href={best.m[2]} target="_blank" rel="noreferrer">
          {inner}
        </a>
      );
    else if (best.rule.tag === "strong") out.push(<strong key={key}>{inner}</strong>);
    else if (best.rule.tag === "del") out.push(<del key={key}>{inner}</del>);
    else out.push(<em key={key}>{inner}</em>);
    rest = rest.slice(best.idx + best.len);
  }
  return out;
}

/* ---------------- 块级 ---------------- */

const RE_FENCE = /^\s*```(\w*)\s*$/;
const RE_HEADING = /^\s*(#{1,6})\s+(.*)$/;
const RE_HR = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
const RE_QUOTE = /^\s*>\s?(.*)$/;
const RE_UL = /^\s*[-*+]\s+(.*)$/;
const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
const RE_TABLE_SEP = /^\s*\|?[\s:|-]*-+[\s:|-]*\|?\s*$/;

function splitTableRow(line: string): string[] {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function isBlockStart(line: string, next?: string): boolean {
  return (
    RE_FENCE.test(line) ||
    RE_HEADING.test(line) ||
    RE_HR.test(line) ||
    RE_QUOTE.test(line) ||
    RE_UL.test(line) ||
    RE_OL.test(line) ||
    (next !== undefined && line.includes("|") && RE_TABLE_SEP.test(next))
  );
}

function renderBlocks(text: string, tx?: TextTransform): ReactNode[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let n = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const key = `b${n++}`;

    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(RE_FENCE);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !RE_FENCE.test(lines[i]!)) buf.push(lines[i++]);
      i++; // 跳过收尾围栏（未闭合时自然到末尾）
      out.push(
        <div key={key} className="md-pre-wrap">
          {fence[1] && <div className="md-pre-lang">{fence[1]}</div>}
          <pre className="md-pre">
            <code>{buf.join("\n")}</code>
          </pre>
        </div>
      );
      continue;
    }

    const heading = line.match(RE_HEADING);
    if (heading) {
      const level = Math.min(heading[1]!.length, 4);
      const Tag = `h${level}` as "h1";
      out.push(<Tag key={key}>{renderInline(heading[2]!, key, tx)}</Tag>);
      i++;
      continue;
    }

    if (RE_HR.test(line)) {
      out.push(<hr key={key} />);
      i++;
      continue;
    }

    if (RE_QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length) {
        const q = lines[i]!.match(RE_QUOTE);
        if (!q) break;
        buf.push(q[1]!);
        i++;
      }
      out.push(
        <blockquote key={key}>
          {buf.map((l, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(l, `${key}q${j}`, tx)}
            </Fragment>
          ))}
        </blockquote>
      );
      continue;
    }

    if (RE_UL.test(line) || RE_OL.test(line)) {
      const ordered = RE_OL.test(line);
      const items: string[] = [];
      const re = ordered ? RE_OL : RE_UL;
      while (i < lines.length) {
        const m = lines[i]!.match(re);
        if (!m) break;
        items.push(m[1]!);
        i++;
      }
      const ListTag = ordered ? "ol" : "ul";
      out.push(
        <ListTag key={key}>
          {items.map((it, j) => (
            <li key={j}>{renderInline(it, `${key}i${j}`, tx)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    if (i + 1 < lines.length && line.includes("|") && RE_TABLE_SEP.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2; // 表头 + 分隔行
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      out.push(
        <div key={key} className="md-table-wrap">
          <table>
            <thead>
              <tr>
                {header.map((c, j) => (
                  <th key={j}>{renderInline(c, `${key}h${j}`, tx)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, j) => (
                <tr key={j}>
                  {r.map((c, k) => (
                    <td key={k}>{renderInline(c, `${key}r${j}c${k}`, tx)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    // 段落：连续到空行或下一块级结构
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i]!.trim() !== "" && !isBlockStart(lines[i]!, lines[i + 1])) {
      para.push(lines[i]!);
      i++;
    }
    out.push(
      <p key={key}>
        {para.map((l, j) => (
          <Fragment key={j}>
            {j > 0 && <br />}
            {renderInline(l, `${key}p${j}`, tx)}
          </Fragment>
        ))}
      </p>
    );
  }
  return out;
}
