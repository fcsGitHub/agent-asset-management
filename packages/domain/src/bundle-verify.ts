// Bundle 离线校验（M63）：store-only ZIP 读取 + BagIt（RFC 8493）口径校验。
// complete（payload ↔ 清单双射）与 valid（校验和全对）分开报告；再加 manifest
// 交叉核对（描述符里的制品 path/digest/size 与 zip 实物一致）。
// 读取器与 M58 的 buildStoreZip 同源假设：无压缩、无加密、无 ZIP64（256MB 包上限
// 远小于 4GB）；遇到不满足的条目如实拒绝而非猜测。
// 已知边界：manifest.json 自身不在 checksum 清单里（M58 格式），描述符整体被替换
// 无法靠包内证据发现——交叉核对能抓制品级篡改，纯元数据改写抓不到。

import { createHash } from "node:crypto";
import { crc32 } from "./bundle.js";

export interface ZipReadEntry {
  path: string;
  data: Buffer;
  method: number;
  crcOk: boolean;
}

function u16(buf: Buffer, off: number): number {
  return buf.readUInt16LE(off);
}
function u32(buf: Buffer, off: number): number {
  return buf.readUInt32LE(off);
}

/**
 * 读取 store-only ZIP（本项目 bundle 格式）。EOCD → 中央目录 → 局部头切片，
 * 逐条目 CRC32 复核；中央目录缺失/偏移越界/非 store 条目抛出明确错误。
 */
export function readStoreZip(buf: Buffer): ZipReadEntry[] {
  if (buf.length < 22) throw new Error("不是 ZIP：文件小于 22 字节（缺 EOCD）");
  const eocd = buf.length - 22;
  if (u32(buf, eocd) !== 0x06054b50) {
    throw new Error("不是 ZIP：末尾无 EOCD 签名（注释/截断/加密均不支持）");
  }
  const count = u16(buf, eocd + 10);
  const cdSize = u32(buf, eocd + 12);
  const cdOffset = u32(buf, eocd + 16);
  if (cdOffset + cdSize > eocd) throw new Error("ZIP 中央目录偏移越界（疑似 ZIP64，不支持）");

  const entries: ZipReadEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (u32(buf, p) !== 0x02014b50) throw new Error(`ZIP 中央目录第 ${i + 1} 项签名不符`);
    const method = u16(buf, p + 10);
    const crc = u32(buf, p + 16);
    const compSize = u32(buf, p + 20);
    const uncompSize = u32(buf, p + 24);
    const nameLen = u16(buf, p + 28);
    const extraLen = u16(buf, p + 30);
    const commentLen = u16(buf, p + 32);
    const localOffset = u32(buf, p + 42);
    const path = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (seen.has(path)) throw new Error(`ZIP 内路径重复：${path}`);
    seen.add(path);
    if (method !== 0) throw new Error(`条目 ${path} 使用压缩（method=${method}），本工具只读 store-only 包`);
    if (compSize !== uncompSize) throw new Error(`条目 ${path} 的压缩前后大小不一致，数据损坏`);

    if (u32(buf, localOffset) !== 0x04034b50) throw new Error(`条目 ${path} 的局部头签名不符`);
    const lNameLen = u16(buf, localOffset + 26);
    const lExtraLen = u16(buf, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + uncompSize;
    if (dataEnd > buf.length) throw new Error(`条目 ${path} 的数据越界，包被截断`);
    const data = buf.subarray(dataStart, dataEnd);
    entries.push({ path, data, method, crcOk: crc32(data) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ---------------------------------------------------------------------------
// 校验（BagIt 口径：complete 与 valid 分离 + manifest 交叉核对）

export interface VerifyFileCheck {
  path: string;
  /** 清单期望摘要（缺失=未列入清单） */
  expected?: string;
  actual: string;
  size: number;
  ok: boolean;
}

export interface BundleVerifyReport {
  ok: boolean;
  /** payload ↔ 清单双射 */
  complete: boolean;
  /** 校验和全部匹配 */
  valid: boolean;
  files: VerifyFileCheck[];
  errors: string[];
  manifest: {
    tawBundle: number;
    generatedAt: unknown;
    source: { kind: string; id: string; name: string };
    assetCount: number;
    relationCount: number;
    warnings: unknown;
  } | null;
}

interface ManifestArtifact {
  path?: unknown;
  digest?: unknown;
  size?: unknown;
}
interface ManifestAsset {
  id?: unknown;
  name?: unknown;
  typeKey?: unknown;
  typeVersion?: unknown;
  revision?: { properties?: unknown };
  artifacts?: ManifestArtifact[];
}
interface ManifestShape {
  tawBundle?: unknown;
  generatedAt?: unknown;
  source?: { kind?: unknown; id?: unknown; name?: unknown };
  assets?: ManifestAsset[];
  relations?: unknown[];
  warnings?: unknown;
}

const MANIFEST = "manifest.json";
const CHECKSUM = "manifest-sha256.txt";
const SHA_LINE = /^([0-9a-f]{64})  (.+)$/;

/**
 * 离线校验一个 TAW bundle ZIP。返回完整报告（complete/valid/逐文件/manifest 摘要），
 * 不抛异常——所有问题进 errors，由调用方决定展示与退出码。
 */
export function verifyBundle(buf: Buffer): BundleVerifyReport {
  const errors: string[] = [];
  const files: VerifyFileCheck[] = [];
  let entries: ZipReadEntry[];
  try {
    entries = readStoreZip(buf);
  } catch (err) {
    return {
      ok: false, complete: false, valid: false, files,
      errors: [`包无法读取：${err instanceof Error ? err.message : String(err)}`],
      manifest: null,
    };
  }
  const byPath = new Map(entries.map((e) => [e.path, e]));
  for (const e of entries) {
    if (!e.crcOk) errors.push(`条目 ${e.path} 的 ZIP CRC32 不符（传输损坏）`);
  }

  const manifestEntry = byPath.get(MANIFEST);
  const checksumEntry = byPath.get(CHECKSUM);
  if (!manifestEntry) errors.push(`缺少 ${MANIFEST}`);
  if (!checksumEntry) errors.push(`缺少 ${CHECKSUM}`);

  // 清单解析（坏行如实报，不静默跳过）
  const expected = new Map<string, string>();
  if (checksumEntry) {
    for (const line of checksumEntry.data.toString("utf8").split(/\r?\n/)) {
      if (line === "") continue;
      const m = SHA_LINE.exec(line);
      if (!m) {
        errors.push(`checksum 清单坏行（应为「<64位sha256>␣␣<路径>」）：${line.slice(0, 120)}`);
        continue;
      }
      expected.set(m[2]!, m[1]!);
    }
  }

  // complete：payload 双射（manifest 两个自描述文件之外的都是 payload）
  const payloadPaths = new Set(entries.map((e) => e.path).filter((p) => p !== MANIFEST && p !== CHECKSUM));
  const listedButMissing = [...expected.keys()].filter((p) => !payloadPaths.has(p));
  for (const p of listedButMissing) errors.push(`清单列出但包中缺失：${p}`);
  for (const p of payloadPaths) {
    if (!expected.has(p)) errors.push(`包中存在但清单未列出：${p}`);
  }

  // valid：逐文件 sha256
  for (const p of [...payloadPaths].sort()) {
    const data = byPath.get(p)!.data;
    const actual = createHash("sha256").update(data).digest("hex");
    const exp = expected.get(p);
    const ok = exp === actual;
    if (!ok) errors.push(`校验和不符：${p}（期望 ${exp ?? "(未列出)"}，实际 ${actual}）`);
    files.push({ path: p, expected: exp, actual, size: data.length, ok });
  }

  // manifest 交叉核对
  let manifest: BundleVerifyReport["manifest"] = null;
  if (manifestEntry) {
    let parsed: ManifestShape;
    try {
      parsed = JSON.parse(manifestEntry.data.toString("utf8")) as ManifestShape;
    } catch (err) {
      errors.push(`${MANIFEST} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      parsed = {};
    }
    if (parsed.tawBundle !== 1) errors.push(`${MANIFEST} 的 tawBundle 版本不是 1（得到 ${String(parsed.tawBundle)}）`);
    manifest = {
      tawBundle: typeof parsed.tawBundle === "number" ? parsed.tawBundle : -1,
      generatedAt: parsed.generatedAt,
      source: {
        kind: String(parsed.source?.kind ?? ""),
        id: String(parsed.source?.id ?? ""),
        name: String(parsed.source?.name ?? ""),
      },
      assetCount: Array.isArray(parsed.assets) ? parsed.assets.length : 0,
      relationCount: Array.isArray(parsed.relations) ? parsed.relations.length : 0,
      warnings: parsed.warnings,
    };
    if (Array.isArray(parsed.assets)) {
      parsed.assets.forEach((a, i) => {
        const label = typeof a.name === "string" && a.name !== "" ? a.name : `第 ${i + 1} 项`;
        for (const art of a.artifacts ?? []) {
          const p = typeof art.path === "string" ? art.path : "";
          const file = p !== "" ? byPath.get(p) : undefined;
          if (!file) {
            errors.push(`manifest 资产「${label}」的制品路径不在包内：${p || "(空)"}`);
            continue;
          }
          if (typeof art.digest === "string" && art.digest !== "") {
            const actual = createHash("sha256").update(file.data).digest("hex");
            if (actual !== art.digest) {
              errors.push(`manifest 资产「${label}」制品 ${p} 的摘要与实物不符`);
            }
          }
          if (typeof art.size !== "number") {
            errors.push(`manifest 资产「${label}」制品 ${p} 的 size 不是数字（得到 ${JSON.stringify(art.size)}）——旧版打包格式缺陷，请重新下载`);
          } else if (art.size !== file.data.length) {
            errors.push(`manifest 资产「${label}」制品 ${p} 的大小与实物不符（${art.size} ≠ ${file.data.length}）`);
          }
        }
      });
    } else {
      errors.push(`${MANIFEST} 缺少 assets 数组`);
    }
  }

  const complete = errors.every((e) => !e.startsWith("清单列出但包中缺失") && !e.startsWith("包中存在但清单未列出") && !e.startsWith("缺少 "));
  const valid = errors.every((e) => !e.startsWith("校验和不符") && !e.startsWith("checksum 清单坏行") && !e.includes("CRC32"));
  return { ok: errors.length === 0, complete, valid, files, errors, manifest };
}
