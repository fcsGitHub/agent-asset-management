// 属性自定义筛选器（M67② 引入，M68② 补算子：OpenMetadata Explore 完整口径）。
// 目录筛选不该只有平台预设维度——head 修订的属性都可过滤：
//   key=value / key:value —— 一级或点号嵌套路径的文本等值（M67 语义不变）
//   key>=value / key<=value —— 数值范围（比较前文本须匹配数值正则，否则该行被排除）
// 语法在 URL 上以可重复的 prop 参数传递；同键后项覆盖前项；非法项不静默丢弃
// （收进 problems，由调用方决定整体拒绝——API 层 422 点名）。

export type PropOp = "=" | ">=" | "<=";
export interface PropFilter { key: string; op: PropOp; value: string }

/** 解析单项：按最早算符位置切分，优先匹配两字符算符（>= 不会切成 > + =x）。 */
function parseItem(s: string, problems: string[]): PropFilter | null {
  // 找最早出现的算符：逐位置扫描，该位置先看两字符（>=/<=）再看单字符（=/:）
  let idx = -1;
  let len = 1;
  let op: PropOp = "=";
  for (let i = 0; i < s.length; i += 1) {
    const two = s.slice(i, i + 2);
    if (two === ">=" || two === "<=") {
      idx = i; len = 2; op = two; break;
    }
    if (s[i] === "=" || s[i] === ":") {
      idx = i; len = 1; op = "="; break;
    }
  }
  if (idx < 0) {
    problems.push(`「${s}」应为 key=value / key>=value / key<=value 形式（键与值都非空）`);
    return null;
  }
  const key = s.slice(0, idx).trim();
  const value = s.slice(idx + len).trim();
  if (!key || !value) {
    problems.push(`「${s}」的键与值都必须非空`);
    return null;
  }
  if (key.length > 64) {
    problems.push(`属性键「${key}」过长（≤64 字符）`);
    return null;
  }
  if (!/^[A-Za-z0-9_.\-]+$/.test(key)) {
    problems.push(`属性键「${key}」只能含字母/数字/点/下划线/连字符`);
    return null;
  }
  if (value.length > 256) {
    problems.push(`属性「${key}」的筛选值过长（≤256 字符）`);
    return null;
  }
  if (op !== "=" && !/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(value)) {
    problems.push(`「${key}${op}${value}」是数值范围比较，值必须是数字`);
    return null;
  }
  return { key, op, value };
}

/**
 * 解析 prop 筛选原始值（Fastify 重复查询参数 → string[]，单项 → string）。
 * 非法项不静默丢弃：收进 problems，由调用方决定整体拒绝（API 层 400/422）。
 */
export function parsePropFilters(raw: string | string[] | undefined | null): {
  filters: PropFilter[];
  problems: string[];
} {
  const items = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const filters: PropFilter[] = [];
  const problems: string[] = [];
  for (const item of items) {
    const s = String(item).trim();
    if (!s) continue;
    const f = parseItem(s, problems);
    if (!f) continue;
    // 同键（含算符）后项覆盖前项（URL 里重复键的直觉语义）
    const prev = filters.findIndex((x) => x.key === f.key && x.op === f.op);
    if (prev >= 0) filters[prev]!.value = f.value;
    else filters.push(f);
  }
  return { filters, problems };
}

/** 展示用：filters → 空格分隔的输入框文本（与输入语法一致，可往返）。 */
export function formatPropFilters(filters: PropFilter[]): string {
  return filters.map((f) => `${f.key}${f.op}${f.value}`).join(" ");
}
