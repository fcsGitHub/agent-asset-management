// 属性自定义筛选器（M67②，OpenMetadata Explore 任意属性过滤思想）。
// 目录筛选不该只有平台预设维度——head 修订的任意一级属性都可等值过滤。
// 语法：每项 "key=value"（也接受 "key:value"，首个分隔符生效）；URL 上以可重复的
// prop 参数传递。值比较为文本等值（range/正则/嵌套属性记为后续候选，如实不装）。

export interface PropFilter { key: string; value: string }

/**
 * 解析 prop 筛选原始值（Fastify 重复查询参数 → string[]，单项 → string）。
 * 非法项不静默丢弃：收进 problems，由调用方决定整体拒绝（API 层 400）。
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
    const sep = s.search(/[=:]/);
    if (sep <= 0 || sep >= s.length - 1) {
      problems.push(`「${s}」应为 key=value 形式（键与值都非空）`);
      continue;
    }
    const key = s.slice(0, sep).trim();
    const value = s.slice(sep + 1).trim();
    if (key.length > 64) {
      problems.push(`属性键「${key}」过长（≤64 字符）`);
      continue;
    }
    if (value.length > 256) {
      problems.push(`属性「${key}」的筛选值过长（≤256 字符）`);
      continue;
    }
    // 同键后项覆盖前项（URL 里重复键的直觉语义）
    const prev = filters.findIndex((f) => f.key === key);
    if (prev >= 0) filters[prev]!.value = value;
    else filters.push({ key, value });
  }
  return { filters, problems };
}

/** 展示用：filters → 空格分隔的输入框文本（与输入语法一致，可往返）。 */
export function formatPropFilters(filters: PropFilter[]): string {
  return filters.map((f) => `${f.key}=${f.value}`).join(" ");
}
