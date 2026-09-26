// 资产名链接化（M44）：把纯文本中出现的团队资产名切成可点击段。
// 规则克制：仅完整名称精确匹配（不含正则元字符解释）、同名取先出现者、
// 短于 4 字符的名字不参与（避免「报告」「模型」类噪音）；左到右贪心、
// 同起点最长名优先、不产生重叠匹配。解析不出就原样返回单段文本。

export interface AssetNameRef { id: string; name: string }

export type LinkifySegment =
  | { kind: "text"; text: string }
  | { kind: "asset"; text: string; id: string; name: string };

const MIN_NAME_LEN = 4;

export function linkifyAssets(text: string, assets: AssetNameRef[]): LinkifySegment[] {
  if (!text || assets.length === 0) return text ? [{ kind: "text", text }] : [];
  const idByName = new Map<string, string>();
  for (const a of assets) {
    if (!a.name || a.name.length < MIN_NAME_LEN) continue;
    if (!idByName.has(a.name)) idByName.set(a.name, a.id);
  }
  if (idByName.size === 0) return [{ kind: "text", text }];
  const names = [...idByName.keys()].sort((x, y) => y.length - x.length);
  const startHit = (pos: number): string | null => {
    for (const n of names) {
      if (text.startsWith(n, pos)) return n;
    }
    return null;
  };

  const out: LinkifySegment[] = [];
  let i = 0;
  while (i < text.length) {
    const hit = startHit(i);
    if (hit) {
      out.push({ kind: "asset", text: hit, id: idByName.get(hit)!, name: hit });
      i += hit.length;
      continue;
    }
    let j = i + 1;
    while (j < text.length && !startHit(j)) j++;
    out.push({ kind: "text", text: text.slice(i, j) });
    i = j;
  }
  return out;
}
