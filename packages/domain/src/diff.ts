// 修订差异（设计 12 章）：文本按行、JSON 属性逐字段、关系按稳定键、
// 二进制只比较摘要（冲突显式标记，不自动合并）。

export interface PropChange {
  key: string;
  kind: "added" | "changed" | "removed";
  from?: unknown;
  to?: unknown;
}

export interface ArtifactDiff {
  role: string;
  name: string;
  fromDigest?: string;
  toDigest?: string;
  binary: boolean;
  conflict: boolean; // 两侧同时修改同一二进制
  textPatch?: { type: "context" | "add" | "del"; line: string }[];
}

export interface RevisionDiff {
  properties: PropChange[];
  artifacts: ArtifactDiff[];
  relations: {
    added: { typeKey: string; target: string }[];
    removed: { typeKey: string; target: string }[];
  };
}

export function diffProperties(
  from: Record<string, unknown>,
  to: Record<string, unknown>
): PropChange[] {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const changes: PropChange[] = [];
  for (const key of [...keys].sort()) {
    const a = from[key];
    const b = to[key];
    if (a === undefined && b !== undefined) changes.push({ key, kind: "added", to: b });
    else if (a !== undefined && b === undefined) changes.push({ key, kind: "removed", from: a });
    else if (JSON.stringify(a) !== JSON.stringify(b))
      changes.push({ key, kind: "changed", from: a, to: b });
  }
  return changes;
}

function isTextual(mediaType: string): boolean {
  return mediaType.startsWith("text/") || mediaType === "application/json";
}

/** 简单 LCS 行差异（文件规模可控；仅用于预览，不参与合并决策）。 */
export function diffLines(from: string, to: string): { type: "context" | "add" | "del"; line: string }[] {
  const a = from.split(/\r?\n/);
  const b = to.split(/\r?\n/);
  const n = a.length;
  const m = b.length;
  // 经典 DP LCS（行数上限保护）
  if (n * m > 4_000_000) {
    return [
      { type: "del", line: `<${n} 行（差异过大，仅显示计数）>` },
      { type: "add", line: `<${m} 行（差异过大，仅显示计数）>` },
    ];
  }
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: { type: "context" | "add" | "del"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "context", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ type: "del", line: a[i++]! });
    } else {
      out.push({ type: "add", line: b[j++]! });
    }
  }
  while (i < n) out.push({ type: "del", line: a[i++]! });
  while (j < m) out.push({ type: "add", line: b[j++]! });
  return out;
}

export interface DiffInput {
  from: {
    properties: Record<string, unknown>;
    artifacts: { role: string; originalName: string; digest: string; mediaType: string }[];
    relations: { typeKey: string; target: string }[];
  };
  to: {
    properties: Record<string, unknown>;
    artifacts: { role: string; originalName: string; digest: string; mediaType: string }[];
    relations: { typeKey: string; target: string }[];
  };
  fetchText?: (digest: string) => Promise<string>;
}

export async function diffRevisions(input: DiffInput): Promise<RevisionDiff> {
  const properties = diffProperties(input.from.properties, input.to.properties);
  const byKey = (a: { role: string; originalName: string }) => `${a.role}:${a.originalName}`;
  const fromMap = new Map(input.from.artifacts.map((x) => [byKey(x), x]));
  const toMap = new Map(input.to.artifacts.map((x) => [byKey(x), x]));
  const keys = new Set([...fromMap.keys(), ...toMap.keys()]);
  const artifacts: ArtifactDiff[] = [];
  for (const key of [...keys].sort()) {
    const f = fromMap.get(key);
    const t = toMap.get(key);
    if (!f && !t) continue;
    const binary =
      !(f && isTextual(f.mediaType)) && !(t && isTextual(t.mediaType));
    const conflict = !!f && !!t && f.digest !== t.digest && binary;
    const entry: ArtifactDiff = {
      role: f?.role ?? t?.role ?? "",
      name: f?.originalName ?? t?.originalName ?? "",
      fromDigest: f?.digest,
      toDigest: t?.digest,
      binary,
      conflict,
    };
    if (!binary && f && t && f.digest !== t.digest && input.fetchText) {
      const [fa, ta] = await Promise.all([input.fetchText(f.digest), input.fetchText(t.digest)]);
      entry.textPatch = diffLines(fa, ta).slice(0, 500);
    }
    artifacts.push(entry);
  }
  const relKey = (r: { typeKey: string; target: string }) => `${r.typeKey}->${r.target}`;
  const fromRels = new Set(input.from.relations.map(relKey));
  const toRels = new Set(input.to.relations.map(relKey));
  const relations = {
    added: input.to.relations.filter((r) => !fromRels.has(relKey(r))),
    removed: input.from.relations.filter((r) => !toRels.has(relKey(r))),
  };
  return { properties, artifacts, relations };
}
