// 批量关联下载与发布测试门禁的纯函数（M58）。
// 调研吸收：HF snapshot_download（批量=解析后整体取走）+ BagIt（逐文件校验和清单）
// + Frictionless Data Package（单一自描述描述符）；门禁=GitHub Required Status Checks
// （类型层声明策略、未运行即阻断、strict 看最新状态）。API 路由与单测共用同一实现。

// ---------------------------------------------------------------------------
// 关系闭包遍历（批量下载的范围解析；检索负责发现、关系负责结构）

export interface ClosureEdge {
  fromAssetId: string;
  toAssetId: string;
  predicate: string;
}

export interface ClosureOptions {
  /** 从起点出发的最大跳数（1=直接关联；上限由路由钳制） */
  depth: number;
  direction: "out" | "in" | "both";
  /** 闭包内资产数上限，超出截断并出警告（防大团队全图拖走） */
  maxAssets?: number;
}

export interface ClosureVisit {
  hop: number;
  /** 经由哪条边到达（起点为 null；集合来源成员亦为 null） */
  via: { predicate: string; fromAssetId: string } | null;
}

export interface ClosureResult {
  visits: Map<string, ClosureVisit>;
  warnings: string[];
}

/** BFS 防环：已访问资产不再入队；邻居按资产 id 稳定排序保证确定性。 */
export function traverseClosure(
  seedIds: string[],
  edges: ClosureEdge[],
  opts: ClosureOptions
): ClosureResult {
  const depth = Math.max(1, Math.min(3, Math.floor(opts.depth)));
  const maxAssets = opts.maxAssets ?? 200;
  const byFrom = new Map<string, ClosureEdge[]>();
  const byTo = new Map<string, ClosureEdge[]>();
  for (const e of edges) {
    if (opts.direction !== "in") {
      const list = byFrom.get(e.fromAssetId) ?? [];
      list.push(e);
      byFrom.set(e.fromAssetId, list);
    }
    if (opts.direction !== "out") {
      const list = byTo.get(e.toAssetId) ?? [];
      list.push(e);
      byTo.set(e.toAssetId, list);
    }
  }
  const visits = new Map<string, ClosureVisit>();
  const warnings: string[] = [];
  const queue: string[] = [];
  for (const id of [...new Set(seedIds)].sort()) {
    visits.set(id, { hop: 0, via: null });
    queue.push(id);
  }
  while (queue.length > 0) {
    const current = queue.shift() as string;
    const hop = visits.get(current)?.hop ?? 0;
    if (hop >= depth) continue;
    const outgoing = opts.direction === "in" ? [] : (byFrom.get(current) ?? []);
    const incoming = opts.direction === "out" ? [] : (byTo.get(current) ?? []);
    const neighbors = [...outgoing.map((e) => ({ id: e.toAssetId, e })), ...incoming.map((e) => ({ id: e.fromAssetId, e }))].sort(
      (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    for (const { id, e } of neighbors) {
      if (visits.has(id)) continue; // 环：保留首达路径
      if (visits.size >= maxAssets) {
        warnings.push(`闭包超过 ${maxAssets} 个资产，已截断（可减小深度后分批下载）`);
        queue.length = 0;
        break;
      }
      visits.set(id, { hop: hop + 1, via: { predicate: e.predicate, fromAssetId: e.fromAssetId } });
      queue.push(id);
    }
  }
  return { visits, warnings };
}

// ---------------------------------------------------------------------------
// 打包计划（manifest + 文件清单 + BagIt 校验和行）

export interface BundleArtifact {
  digest: string;
  role: string;
  originalName: string;
  mediaType: string;
  size: number;
}

export interface BundleAsset {
  id: string;
  name: string;
  typeKey: string;
  typeVersion: string;
  lifecycle: string;
  aliases: string[];
  revisionId: string;
  revisionSeq: number;
  contentDigest: string;
  properties: Record<string, unknown> | null;
  artifacts: BundleArtifact[];
  hop: number;
  via: { predicate: string; fromAssetId: string } | null;
}

export interface BundleSourceInfo {
  kind: "asset" | "collection";
  id: string;
  name: string;
  depth?: number;
  direction?: string;
}

export interface BundlePlanFile {
  /** ZIP 内路径（服务端生成，制品原名只作末段） */
  path: string;
  digest: string;
  size: number;
  mediaType: string;
}

export interface BundlePlan {
  manifest: Record<string, unknown>;
  /** manifest-sha256.txt 内容（sha256sum 格式，覆盖全部 payload 文件，不含自身） */
  checksumLines: string;
  files: BundlePlanFile[];
}

/** ZIP 内路径安全化：剥离路径分隔与 Windows 保留字符，收敛空白，限长。 */
export function sanitizeName(raw: string, maxLen: number): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (cleaned === "") return "unnamed";
  return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 8)}…trunc`; // … 占 1 字符，留余量
}

/** 同目录重名消解：name.ext → name-2.ext（无扩展名则直接追加）。 */
function dedupePath(path: string, used: Set<string>): string {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  // dot 是全路径偏移，切片前换算到 base 内的相对偏移
  const relDot = dot - slash - 1;
  const stem = relDot > 0 ? base.slice(0, relDot) : base;
  const ext = relDot > 0 ? base.slice(relDot) : "";
  for (let n = 2; ; n++) {
    const candidate = `${dir}${stem}-${n}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

export function buildBundlePlan(
  source: BundleSourceInfo,
  assets: BundleAsset[],
  relations: ClosureEdge[],
  relationNames: Map<string, string>,
  assetNames: Map<string, string>,
  generatedAt: string,
  /** 遍历层警告（闭包截断等），如实写进 manifest 供接收方知晓 */
  warnings: string[] = []
): BundlePlan {
  // 资产按（hop, id）稳定排序：起点最前，同跳按 id；文件路径先到先得，消解重名。
  const ordered = [...assets].sort((a, b) => a.hop - b.hop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const usedPaths = new Set<string>();
  const files: BundlePlanFile[] = [];
  const assetIds = new Set(ordered.map((a) => a.id));
  const manifestAssets = ordered.map((a) => {
    const dir = `assets/${sanitizeName(a.typeKey, 48)}/${sanitizeName(a.name, 60)}`;
    const artifacts = a.artifacts.map((art) => {
      const path = dedupePath(`${dir}/${sanitizeName(art.originalName || "unnamed", 120)}`, usedPaths);
      files.push({ path, digest: art.digest, size: art.size, mediaType: art.mediaType });
      return { path, digest: art.digest, role: art.role, originalName: art.originalName, mediaType: art.mediaType, size: art.size };
    });
    return {
      id: a.id,
      name: a.name,
      typeKey: a.typeKey,
      typeVersion: a.typeVersion,
      lifecycle: a.lifecycle,
      aliases: a.aliases,
      hop: a.hop,
      viaRelation: a.via,
      revision: { id: a.revisionId, seq: a.revisionSeq, contentDigest: a.contentDigest, properties: a.properties ?? {} },
      artifacts,
    };
  });
  // 只保留闭包内资产之间的边（外部引用如实出现在 manifest 之外没有意义）。
  // predicate 携带稳定标识 type_key（回导工具据此解析关系类型，M63）；标题另列
  // predicateTitle 供人读——标题可改可重名，不是机器可解析的标识。
  const manifestRelations = relations
    .filter((e) => assetIds.has(e.fromAssetId) && assetIds.has(e.toAssetId))
    .map((e) => ({
      fromAssetId: e.fromAssetId,
      fromName: assetNames.get(e.fromAssetId) ?? "",
      toAssetId: e.toAssetId,
      toName: assetNames.get(e.toAssetId) ?? "",
      predicate: e.predicate,
      predicateTitle: relationNames.get(e.predicate) ?? e.predicate,
    }));
  const manifest = {
    tawBundle: 1,
    generatedAt,
    source,
    assets: manifestAssets,
    relations: manifestRelations,
    warnings,
  };
  const checksumLines = `${files
    .map((f) => `${f.digest}  ${f.path}`)
    .sort()
    .join("\n")}\n`;
  return { manifest, checksumLines, files };
}

// ---------------------------------------------------------------------------
// store-only ZIP 写入（确定性：固定 DOS 时间戳 1980-01-01，无压缩，UTF-8 文件名）

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  path: string;
  data: Uint8Array;
}

/**
 * 组装 store-only ZIP。同输入同字节（可复现构建），接收方任何标准解压工具可开；
 * 测试侧无需解压库即可读出内容（method=0 数据即原文）。
 */
export function buildStoreZip(entries: ZipEntry[]): Buffer {
  const chunks: Uint8Array[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const DOS_TIME = 0; // 00:00:00
  const DOS_DATE = 0x21; // 1980-01-01（ZIP 纪元起点）
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    if (name.length > 0xffff) throw new Error("zip 条目名过长");
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, entry.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(entry.data.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(0, 30); // extra/comment/attrs
    cd.writeUInt32LE(0, 34);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += 30 + name.length + entry.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// 发布测试门禁（GitHub Required Status Checks 思想）

export interface TestRunLite {
  id: string;
  targetRevisionId: string;
  targetContentDigest: string;
  result: "pass" | "fail" | "error" | "skipped";
  executedAt: string;
  testAssetId: string;
}

export interface TestGateCheck {
  assetId: string;
  assetName: string;
  revisionId: string;
  contentDigest: string;
  required: boolean;
  satisfied: boolean;
  /** not_required | pass | no_runs | latest_not_pass */
  reason: string;
  latestRunId?: string;
  latestResult?: string;
  latestExecutedAt?: string;
}

/**
 * 门禁判定：required 来自类型链上任一定义声明 requires_test_evidence（与属性
 * 校验的链语义一致）；证据只认该精确修订上的运行，取 executedAt 最新一次——
 * 曾经过但最新一次 fail/error/skipped 一样拦（strict 模式，prepare 后状态
 * 翻转由快照摘要失配兜底，见 releases 路由）。
 */
export function checkTestGate(
  item: {
    assetId: string;
    assetName: string;
    revisionId: string;
    contentDigest: string;
    requiresTestEvidence: boolean;
  },
  runs: TestRunLite[]
): TestGateCheck {
  const base: TestGateCheck = {
    assetId: item.assetId,
    assetName: item.assetName,
    revisionId: item.revisionId,
    contentDigest: item.contentDigest,
    required: item.requiresTestEvidence,
    satisfied: !item.requiresTestEvidence,
    reason: item.requiresTestEvidence ? "no_runs" : "not_required",
  };
  if (!item.requiresTestEvidence) return base;
  const mine = runs
    .filter((r) => r.targetRevisionId === item.revisionId)
    .sort((a, b) => (a.executedAt < b.executedAt ? 1 : a.executedAt > b.executedAt ? -1 : a.id < b.id ? 1 : -1));
  const latest = mine[0];
  if (!latest) return base;
  const satisfied = latest.result === "pass" && latest.targetContentDigest === item.contentDigest;
  return {
    ...base,
    satisfied,
    reason: satisfied ? "pass" : "latest_not_pass",
    latestRunId: latest.id,
    latestResult: latest.result,
    latestExecutedAt: latest.executedAt,
  };
}
