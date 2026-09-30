// 完整度团队汇总（M67⑦，Backstage TechInsights 水位视图思想）。
// 与详情卡/目录列同一条 computeCompleteness 分数——汇总层只做聚合：
// 水位（平均分 + 三档分桶）+ 拖后腿清单（低分资产及其未过项，可直达补元数据）。

export interface SummaryEntry { id: string; name: string; score: number; missingTitles: string[] }

export interface CompletenessSummary {
  count: number;
  /** 算术平均四舍五入到整数；空集为 0。 */
  average: number;
  /** 三档分桶阈值与详情卡着色一致：80+ 绿 / 50-79 黄 / <50 红。 */
  buckets: { green: number; yellow: number; red: number };
  /** 低分清单：score < lowThreshold（默认 60）升序，最多 maxLow（默认 20）条。 */
  low: SummaryEntry[];
  lowThreshold: number;
}

export function summarizeCompleteness(
  entries: SummaryEntry[],
  opts: { lowThreshold?: number; maxLow?: number } = {}
): CompletenessSummary {
  const lowThreshold = opts.lowThreshold ?? 60;
  const maxLow = opts.maxLow ?? 20;
  const count = entries.length;
  const average = count === 0 ? 0 : Math.round(entries.reduce((s, e) => s + e.score, 0) / count);
  const buckets = { green: 0, yellow: 0, red: 0 };
  for (const e of entries) {
    if (e.score >= 80) buckets.green += 1;
    else if (e.score >= 50) buckets.yellow += 1;
    else buckets.red += 1;
  }
  const low = entries
    .filter((e) => e.score < lowThreshold)
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, maxLow);
  return { count, average, buckets, low, lowThreshold };
}
