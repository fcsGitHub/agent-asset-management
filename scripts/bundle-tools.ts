/**
 * M63 bundle 离线校验/回导 CLI：
 *   npx tsx scripts/bundle-tools.ts verify <bundle.zip> [--json]
 *   npx tsx scripts/bundle-tools.ts import <bundle.zip> --team <teamId> \
 *     [--api <base>] (--email <e> --password <p> | TAW_EMAIL/TAW_PASSWORD) [--dry-run]
 *
 * verify：BagIt 口径离线校验（complete/valid 分离 + manifest 交叉核对），零网络。
 * import：先离线校验（不过不导入），再走公开 API（登录/CSRF/上传/登记/建关系）——
 * 与界面同一套关卡（M59 schema 强制、成员校验、RLS），无旁路；类型按
 * (typeKey, typeVersion) 精确解析，缺失如实跳过；不回导别名/测试运行/lifecycle
 * （报告注明）。部分成功是合法结果，逐条如实报告。
 */
import { readFileSync } from "node:fs";
import { readStoreZip, verifyBundle, type BundleVerifyReport } from "@taw/domain/bundle-verify";

// ---------------------------------------------------------------------------
// API 客户端（与测试同口径：cookie 会话 + CSRF 双提交）

export class ApiClient {
  private cookie = "";
  private csrf = "";

  constructor(private base: string) {}

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.base}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`登录失败（HTTP ${res.status}）：${(await res.text()).slice(0, 200)}`);
    for (const sc of res.headers.getSetCookie()) {
      if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) this.cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) this.csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { cookie: this.cookie, "x-csrf-token": this.csrf };
    if (json) h["content-type"] = "application/json";
    return h;
  }

  async getJson<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, { headers: this.headers(false) });
    if (!res.ok) throw new Error(`GET ${path} 失败（HTTP ${res.status}）：${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async postJson<T>(path: string, body: unknown): Promise<{ status: number; json: T }> {
    const res = await fetch(`${this.base}${path}`, { method: "POST", headers: this.headers(), body: JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as T) : ({} as T) };
  }

  async upload(teamId: string, fileName: string, mediaType: string, data: Uint8Array): Promise<{ digest: string; size: number }> {
    const form = new FormData();
    form.append("file", new File([data], fileName, { type: mediaType || "application/octet-stream" }));
    const res = await fetch(`${this.base}/uploads?teamId=${teamId}`, {
      method: "POST",
      headers: { cookie: this.cookie, "x-csrf-token": this.csrf },
      body: form,
    });
    if (!res.ok) throw new Error(`上传制品 ${fileName} 失败（HTTP ${res.status}）：${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { digest: string; size: number };
  }
}

// ---------------------------------------------------------------------------
// 回导

export interface ImportReport {
  verified: { ok: boolean; errors: string[] };
  dryRun: boolean;
  assets: { imported: { oldId: string; newId: string; name: string }[]; skipped: { name: string; reason: string }[] };
  relations: { imported: { predicate: string; fromName: string; toName: string }[]; skipped: { predicate: string; reason: string }[] };
  notes: string[];
}

interface BundleManifest {
  tawBundle: number;
  generatedAt: string;
  source: { kind: string; id: string; name: string };
  assets: {
    id: string;
    name: string;
    typeKey: string;
    typeVersion: string;
    revision: { properties: Record<string, unknown> };
    artifacts: { path: string; digest: string; role: string; originalName: string; mediaType: string; size: number }[];
  }[];
  relations: { fromAssetId: string; fromName: string; toAssetId: string; toName: string; predicate: string; predicateTitle?: string }[];
}

interface ApiErrorBody { error?: { message?: string; details?: unknown } }

function errText(status: number, body: ApiErrorBody): string {
  const msg = body.error?.message ?? JSON.stringify(body).slice(0, 200);
  const details = body.error?.details ? `：${JSON.stringify(body.error.details).slice(0, 300)}` : "";
  return `HTTP ${status} ${msg}${details}`;
}

/**
 * 回导一个 bundle ZIP 到目标团队（走公开 API）。先离线校验（不过即中止，无 --force
 * 后门），再按 manifest 顺序导入资产与关系；逐条如实报告成败，部分成功不回滚
 * （要原子性先 --dry-run 看计划）。
 */
export async function importBundle(
  zip: Buffer,
  opts: { api: string; email: string; password: string; teamId: string; dryRun?: boolean; log?: (s: string) => void }
): Promise<ImportReport> {
  const log = opts.log ?? (() => undefined);
  const report: ImportReport = {
    verified: { ok: false, errors: [] },
    dryRun: opts.dryRun === true,
    assets: { imported: [], skipped: [] },
    relations: { imported: [], skipped: [] },
    notes: [],
  };

  // 1. 离线校验
  const verify = verifyBundle(zip);
  report.verified = { ok: verify.ok, errors: verify.errors };
  if (!verify.ok) {
    report.notes.push("离线校验未通过，未执行任何写入——先拿到完好的包（重新下载或联系发送方）");
    return report;
  }
  const entries = readStoreZip(zip);
  const manifestRaw = entries.find((e) => e.path === "manifest.json");
  const m = manifestRaw ? (JSON.parse(manifestRaw.data.toString("utf8")) as BundleManifest) : null;
  if (!m || !Array.isArray(m.assets)) {
    report.verified = { ok: false, errors: [...verify.errors, "manifest.json 缺少 assets 数组"] };
    return report;
  }
  const artifactBytes = new Map(entries.map((e) => [e.path, e.data]));

  // 2. 登录 + 目标团队注册表解析（类型按 typeKey+version 精确；谓词按 type_key 取最新版本）
  const client = new ApiClient(opts.api);
  await client.login(opts.email, opts.password);
  const types = await client.getJson<{ id: string; type_key: string; version: string }[]>(`/types?teamId=${opts.teamId}`);
  const typeByExact = new Map(types.map((t) => [`${t.type_key} v${t.version}`, t.id]));
  const relTypes = await client.getJson<{ id: string; type_key: string; version: string }[]>(`/relation-types?teamId=${opts.teamId}`);
  const relTypeByKey = new Map<string, { id: string; version: string }>();
  for (const r of relTypes) {
    const prev = relTypeByKey.get(r.type_key);
    if (prev === undefined || r.version > prev.version) relTypeByKey.set(r.type_key, { id: r.id, version: r.version });
  }

  if (report.dryRun) {
    for (const a of m.assets) {
      if (typeByExact.has(`${a.typeKey} v${a.typeVersion}`)) {
        report.assets.imported.push({ oldId: a.id, newId: "(dry-run)", name: a.name });
      } else {
        report.assets.skipped.push({ name: a.name, reason: `类型 ${a.typeKey} v${a.typeVersion} 在目标团队不存在` });
      }
    }
    const plannable = new Set(m.assets.filter((a) => typeByExact.has(`${a.typeKey} v${a.typeVersion}`)).map((a) => a.id));
    for (const r of m.relations) {
      if (!relTypeByKey.has(r.predicate)) {
        report.relations.skipped.push({ predicate: r.predicate, reason: "关系类型在目标团队不存在（计划）" });
      } else if (!plannable.has(r.fromAssetId) || !plannable.has(r.toAssetId)) {
        report.relations.skipped.push({ predicate: r.predicate, reason: "端点资产类型缺失，无法导入（计划）" });
      } else {
        report.relations.imported.push({ predicate: r.predicate, fromName: r.fromName, toName: r.toName });
      }
    }
    report.notes.push("dry-run：零写入，以上为导入计划");
    return report;
  }

  // 3. 资产逐个导入（制品内容寻址上传自动去重；上传后摘要与 manifest 不符即中止该资产）
  const idMap = new Map<string, string>();
  for (const a of m.assets) {
    const label = a.name || a.id;
    const typeVersionId = typeByExact.get(`${a.typeKey} v${a.typeVersion}`);
    if (!typeVersionId) {
      report.assets.skipped.push({ name: label, reason: `类型 ${a.typeKey} v${a.typeVersion} 在目标团队不存在（先在目标团队注册同名同版类型）` });
      continue;
    }
    try {
      const artifacts: { digest: string; role: string; originalName: string; mediaType: string; size: number }[] = [];
      for (const art of a.artifacts) {
        const data = artifactBytes.get(art.path);
        if (!data) throw new Error(`制品文件 ${art.path} 不在包内（校验已过仍缺失？拒绝继续）`);
        const up = await client.upload(opts.teamId, art.originalName || "unnamed", art.mediaType, data);
        if (up.digest !== art.digest) throw new Error(`制品 ${art.path} 上传后摘要与 manifest 不符（${up.digest} ≠ ${art.digest}），完整性存疑`);
        artifacts.push({ digest: art.digest, role: art.role, originalName: art.originalName, mediaType: art.mediaType, size: art.size });
      }
      const res = await client.postJson<{ assetId?: string }>("/assets", {
        teamId: opts.teamId,
        name: a.name,
        typeVersionId,
        properties: a.revision.properties ?? {},
        artifacts,
      });
      if (res.status !== 201 || !res.json.assetId) {
        report.assets.skipped.push({ name: label, reason: `登记被目标团队关卡拒绝：${errText(res.status, res.json as unknown as ApiErrorBody)}` });
        continue;
      }
      idMap.set(a.id, res.json.assetId);
      report.assets.imported.push({ oldId: a.id, newId: res.json.assetId, name: a.name });
      log(`✓ 资产「${a.name}」已导入（${a.artifacts.length} 制品）`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      report.assets.skipped.push({ name: label, reason });
      log(`✗ 资产「${label}」失败：${reason}`);
    }
  }

  // 4. 关系重建（两端资产都成功且谓词类型存在才建；evidenceNote 注明回导来源）
  for (const r of m.relations) {
    const src = idMap.get(r.fromAssetId);
    const dst = idMap.get(r.toAssetId);
    const relType = relTypeByKey.get(r.predicate);
    const missing: string[] = [];
    if (!src) missing.push(r.fromName || r.fromAssetId);
    if (!dst) missing.push(r.toName || r.toAssetId);
    if (missing.length > 0) {
      report.relations.skipped.push({ predicate: r.predicate, reason: `端点资产未导入成功：${missing.join("、")}` });
      continue;
    }
    if (!relType) {
      report.relations.skipped.push({ predicate: r.predicate, reason: `关系类型 ${r.predicate} 在目标团队不存在` });
      continue;
    }
    const res = await client.postJson<{ relationId?: string }>("/relations", {
      teamId: opts.teamId,
      relationTypeVersionId: relType.id,
      sourceAssetId: src,
      targetAssetId: dst,
      evidenceNote: `bundle 回导：来源 ${m.source.kind}:${m.source.name} @ ${m.generatedAt}`,
      confirm: true,
    });
    if (res.status === 201) {
      report.relations.imported.push({ predicate: r.predicate, fromName: r.fromName, toName: r.toName });
      log(`✓ 关系 ${r.predicate}：${r.fromName} → ${r.toName}`);
    } else {
      report.relations.skipped.push({ predicate: r.predicate, reason: `创建被拒绝：${errText(res.status, res.json as unknown as ApiErrorBody)}` });
    }
  }

  report.notes.push("别名未回导（团队唯一 slug，需人工处理冲突）；测试运行不回导（证据绑定精确修订，跨环境无意义）；lifecycle 从「进行中」重新开始");
  return report;
}

// ---------------------------------------------------------------------------
// CLI

function printVerify(report: BundleVerifyReport, asJson: boolean): number {
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const m = report.manifest;
    console.log(`TAW bundle 校验：${report.ok ? "✓ 通过" : "✗ 未通过"}（complete=${report.complete} valid=${report.valid} tagmanifest=${report.tagManifest ? "有" : "无"}）`);
    if (m) {
      console.log(`  来源：${m.source.kind}:${m.source.name} @ ${String(m.generatedAt)}；资产 ${m.assetCount}，关系 ${m.relationCount}`);
      if (Array.isArray(m.warnings) && m.warnings.length > 0) console.log(`  打包警告：${m.warnings.join("；")}`);
    }
    for (const n of report.notes) console.log(`  · ${n}`);
    for (const f of report.files) {
      console.log(`  ${f.ok ? "✓" : "✗"} ${f.path}（${f.size} B，sha256 ${f.actual.slice(0, 16)}…）`);
    }
    for (const e of report.errors) console.log(`  ⚠ ${e}`);
  }
  return report.ok ? 0 : 1;
}

function printImport(report: ImportReport): number {
  console.log(`离线校验：${report.verified.ok ? "✓ 通过" : `✗ 未通过（${report.verified.errors.length} 项错误）`}`);
  for (const e of report.verified.errors) console.log(`  ⚠ ${e}`);
  console.log(`资产：导入 ${report.assets.imported.length}，跳过 ${report.assets.skipped.length}${report.dryRun ? "（dry-run，零写入）" : ""}`);
  for (const a of report.assets.imported) console.log(`  ✓ ${a.name}${report.dryRun ? "" : `：${a.oldId.slice(0, 8)}… → ${a.newId.slice(0, 8)}…`}`);
  for (const s of report.assets.skipped) console.log(`  ✗ ${s.name}：${s.reason}`);
  console.log(`关系：导入 ${report.relations.imported.length}，跳过 ${report.relations.skipped.length}`);
  for (const r of report.relations.imported) console.log(`  ✓ ${r.predicate}：${r.fromName} → ${r.toName}`);
  for (const s of report.relations.skipped) console.log(`  ✗ ${s.predicate}：${s.reason}`);
  for (const n of report.notes) console.log(`  · ${n}`);
  if (!report.verified.ok) return 1;
  if (report.assets.skipped.length > 0 || report.relations.skipped.length > 0) return 2;
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (name: string): string => {
    const i = rest.indexOf(`--${name}`);
    return i >= 0 ? (rest[i + 1] ?? "") : "";
  };
  const positional = (): string => {
    const flagNames = new Set(["--api", "--email", "--password", "--team"]);
    for (let i = 0; i < rest.length; i++) {
      if (!rest[i]!.startsWith("--") && (i === 0 || !flagNames.has(rest[i - 1]!))) return rest[i]!;
    }
    return "";
  };

  if (cmd === "verify") {
    const zipPath = positional();
    if (!zipPath) {
      console.error("用法：bundle-tools verify <bundle.zip> [--json]");
      return 1;
    }
    return printVerify(verifyBundle(readFileSync(zipPath)), rest.includes("--json"));
  }
  if (cmd === "import") {
    const zipPath = positional();
    const api = flag("api") || "http://127.0.0.1:4000/api/v1";
    const email = flag("email") || process.env.TAW_EMAIL || "";
    const password = flag("password") || process.env.TAW_PASSWORD || "";
    const teamId = flag("team");
    if (!zipPath || !email || !password || !teamId) {
      console.error("用法：bundle-tools import <bundle.zip> --team <teamId> [--api <base>] (--email e --password p | TAW_EMAIL/TAW_PASSWORD) [--dry-run]");
      return 1;
    }
    const report = await importBundle(readFileSync(zipPath), {
      api, email, password, teamId,
      dryRun: rest.includes("--dry-run"),
      log: (s) => console.log(s),
    });
    return printImport(report);
  }
  console.error("命令：verify <zip> [--json] | import <zip> --team <id> [--dry-run]");
  return 1;
}

// 直接执行时跑 CLI（被测试 import 时不跑）：按入口文件名判定。
// 退出用 exitCode 而非 process.exit()——强杀会让 keep-alive 连接触发 libuv
// 断言（Windows/Node 24），自然退出更稳。
const invoked = process.argv[1]?.replace(/\\/g, "/");
if (invoked?.endsWith("bundle-tools.ts")) {
  void main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  );
}
