// M63 集成测试 — bundle 离线校验与回导工具：
// ①readStoreZip 与 buildStoreZip 往返（路径/字节/CRC 全对）；
// ②verifyBundle：完好包通过（complete/valid + manifest 摘要）；篡改制品字节→valid=false；
//   缺文件/多文件→complete=false（BagIt 双射口径）；坏清单行；manifest 制品摘要交叉核对；
// ③API 端到端：真实下载的 bundle 离线校验通过（2 资产 + 1 关系）；
// ④回导 dry-run：零写入、类型缺失如实列计划；
// ⑤真实回导到新团队（先注册同版类型）：资产+制品+关系全导入；
// ⑥类型缺失团队导入：逐条如实跳过；坏包（校验不过）拒绝导入零写入。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes, createHash } from "node:crypto";
import { buildStoreZip, buildBundlePlan, type BundleAsset, type ClosureEdge } from "@taw/domain/bundle";
import { readStoreZip, verifyBundle } from "@taw/domain/bundle-verify";
import { importBundle } from "../scripts/bundle-tools.js";

const PORT = 4164;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const runId = randomBytes(4).toString("hex");

interface Session { cookie: string; csrf: string }
function sessionOf(res: Response): Session {
  let cookie = "";
  let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { cookie, csrf };
}

async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function callRaw(method: string, path: string, session: Session): Promise<{ status: number; buf: Buffer | null }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
  const ab = await res.arrayBuffer();
  return { status: res.status, buf: ab.byteLength > 0 ? Buffer.from(ab) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
}

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  const json = (await res.json()) as { teamId: string };
  expectOk(res.status === 201 && !!json.teamId, json, "注册失败");
  return { session: sessionOf(res), teamId: json.teamId };
}

async function upload(session: Session, teamId: string, content: string, name: string): Promise<{ digest: string; size: number }> {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
    method: "POST", headers: { cookie: session.cookie, "x-csrf-token": session.csrf }, body: form,
  });
  const json = (await res.json()) as { digest?: string; size?: number };
  expectOk(res.status === 201 && !!json.digest, json, "上传失败");
  return { digest: json.digest!, size: json.size! };
}

// ---------------- 纯函数侧：手造一个最小 bundle ----------------

function makeMiniBundle(): { zip: Buffer; artifactPath: string; artifactData: Buffer } {
  const artifactData = Buffer.from("model weights v3\n", "utf8");
  const digest = createHash("sha256").update(artifactData).digest("hex");
  const asset: BundleAsset = {
    id: "0f0e0d0c-0000-4000-8000-000000000001",
    name: "mini-model",
    typeKey: "simulation.model",
    typeVersion: "1.0.0",
    lifecycle: "in_progress",
    aliases: [],
    revisionId: "0f0e0d0c-0000-4000-8000-000000000002",
    revisionSeq: 1,
    contentDigest: "ab".repeat(32),
    properties: { note: "x" },
    artifacts: [{ digest, role: "implementation", originalName: "weights.bin", mediaType: "application/octet-stream", size: artifactData.length }],
    hop: 0,
    via: null,
  };
  const edges: ClosureEdge[] = [];
  const plan = buildBundlePlan(
    { kind: "asset", id: asset.id, name: asset.name, depth: 1, direction: "out" },
    [asset],
    edges,
    new Map(),
    new Map([[asset.id, asset.name]]),
    "2026-09-30T00:00:00Z"
  );
  const artifactPath = plan.files[0]!.path;
  const zip = buildStoreZip([
    { path: "manifest.json", data: Buffer.from(JSON.stringify(plan.manifest, null, 2), "utf8") },
    { path: "manifest-sha256.txt", data: Buffer.from(plan.checksumLines, "utf8") },
    { path: artifactPath, data: artifactData },
  ]);
  return { zip, artifactPath, artifactData };
}

describe("M63 bundle 离线校验与回导", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
  });
  afterAll(async () => { await app.close(); });

  it("readStoreZip：与 buildStoreZip 往返一致（路径/字节/CRC）", () => {
    const { zip, artifactPath, artifactData } = makeMiniBundle();
    const entries = readStoreZip(zip);
    expect(entries.map((e) => e.path)).toEqual(["manifest.json", "manifest-sha256.txt", artifactPath]);
    expect(entries.every((e) => e.crcOk)).toBe(true);
    expect(entries[2]!.data.equals(artifactData)).toBe(true);
  });

  it("verifyBundle：完好包通过（complete/valid + manifest 摘要与计数）", () => {
    const { zip, artifactPath } = makeMiniBundle();
    const report = verifyBundle(zip);
    expectOk(report.ok, report.errors, "完好包应通过");
    expect(report.complete).toBe(true);
    expect(report.valid).toBe(true);
    expect(report.files.map((f) => f.path)).toEqual([artifactPath]);
    expect(report.manifest).toMatchObject({ tawBundle: 1, assetCount: 1, relationCount: 0 });
    expect(report.manifest!.source).toMatchObject({ kind: "asset", name: "mini-model" });
  });

  it("verifyBundle：篡改制品字节→valid=false 且点到文件；complete 不受影响", () => {
    const { zip, artifactPath } = makeMiniBundle();
    const tampered = mutateEntry(zip, artifactPath, (d) => {
      const copy = Buffer.from(d);
      copy[0] ^= 0xff;
      return copy;
    });
    const report = verifyBundle(tampered.report);
    expect(report.ok).toBe(false);
    expect(report.valid).toBe(false);
    expect(report.complete).toBe(true); // 双射仍在，只是内容错了
    expect(report.errors.join("\n")).toContain(artifactPath);
    expect(report.files[0]!.ok).toBe(false);
  });

  it("verifyBundle：缺文件/多文件→complete=false（BagIt 双射）", () => {
    const { zip, artifactPath } = makeMiniBundle();
    const missing = rebuildWithout(zip, artifactPath);
    const r1 = verifyBundle(missing);
    expect(r1.complete).toBe(false);
    expect(r1.errors.join("\n")).toContain("清单列出但包中缺失");

    const extra = appendEntry(zip, "assets/extra/rogue.bin", Buffer.from("rogue"));
    const r2 = verifyBundle(extra);
    expect(r2.complete).toBe(false);
    expect(r2.errors.join("\n")).toContain("包中存在但清单未列出");
  });

  it("verifyBundle：坏清单行如实报；manifest 制品摘要交叉核对", () => {
    const { zip } = makeMiniBundle();
    const badLines = rebuildWithout(zip, "manifest-sha256.txt");
    const withBad = appendEntry(badLines, "manifest-sha256.txt", Buffer.from("not-a-sha  file.bin\n", "utf8"));
    const r1 = verifyBundle(withBad);
    expect(r1.valid).toBe(false);
    expect(r1.errors.join("\n")).toContain("checksum 清单坏行");

    // manifest 制品 digest 被改（checksum 清单与实物都对，但描述符撒谎）
    const { zip: z2, artifactPath } = makeMiniBundle();
    const tampered = mutateEntry(z2, "manifest.json", (d) => {
      const m = JSON.parse(d.toString("utf8")) as { assets: { artifacts: { digest: string }[] }[] };
      m.assets[0]!.artifacts[0]!.digest = "ff".repeat(32);
      return Buffer.from(JSON.stringify(m, null, 2), "utf8");
    });
    void artifactPath;
    const r2 = verifyBundle(tampered.report);
    expect(r2.ok).toBe(false);
    expect(r2.errors.join("\n")).toContain("摘要与实物不符");
  });

  // ---------------- API 端到端 ----------------

  it("端到端：真实下载的 bundle 离线校验通过 → dry-run → 回导新团队 → 类型缺失如实跳过", async () => {
    // 源团队：类型 + 两资产（带制品）+ dependsOn 关系
    const src = await register(`m63src-${runId}@t.dev`, "M63源", `M63源团队-${runId}`);
    const typeKey = `m63.doc.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: src.session,
      body: { teamId: src.teamId, typeKey, version: "1.0.0", title: "M63文档", jsonSchema: { type: "object", properties: { note: { type: "string" } } } },
    });
    expectOk(typeReg.status === 201, typeReg.json, "类型注册失败");
    const art1 = await upload(src.session, src.teamId, "manual chapter 1", "manual.md");
    const a1 = await call("POST", "/assets", {
      session: src.session,
      body: { teamId: src.teamId, name: "M63操作手册", typeVersionId: typeReg.json.typeVersionId, properties: { note: "手册" }, artifacts: [{ digest: art1.digest, role: "implementation", originalName: "manual.md", mediaType: "text/markdown", size: art1.size }] },
    });
    expectOk(a1.status === 201, a1.json, "资产1登记失败");
    const a2 = await call("POST", "/assets", {
      session: src.session,
      body: { teamId: src.teamId, name: "M63培训大纲", typeVersionId: typeReg.json.typeVersionId, properties: {}, artifacts: [] },
    });
    expectOk(a2.status === 201, a2.json, "资产2登记失败");
    const relTypes = await call("GET", `/relation-types?teamId=${src.teamId}`, { session: src.session });
    const dependsOn = (relTypes.json as { id: string; type_key: string }[]).find((r) => r.type_key === "dependsOn");
    expectOk(!!dependsOn, relTypes.json, "默认关系类型 dependsOn 缺失");
    const rel = await call("POST", "/relations", {
      session: src.session,
      body: { teamId: src.teamId, relationTypeVersionId: dependsOn!.id, sourceAssetId: a2.json.assetId, targetAssetId: a1.json.assetId, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "关系创建失败");

    // 下载 bundle（depth=2 双向覆盖两资产）→ 离线校验
    const dl = await callRaw("GET", `/assets/${a1.json.assetId}/bundle?teamId=${src.teamId}&depth=2&direction=both`, src.session);
    expectOk(dl.status === 200 && !!dl.buf, dl.status, "bundle 下载失败");
    const verify = verifyBundle(dl.buf!);
    expectOk(verify.ok, verify.errors, "真实包离线校验应通过");
    expect(verify.manifest!.assetCount).toBe(2);
    expect(verify.manifest!.relationCount).toBe(1);
    const zip = dl.buf!;

    // 目标团队（新注册，无该类型）：dry-run 如实报类型缺失；真实导入也逐条跳过
    const dst = await register(`m63dst-${runId}@t.dev`, "M63目标", `M63目标团队-${runId}`);
    const dryMissing = await importBundle(zip, { api: BASE, email: `m63dst-${runId}@t.dev`, password: "password-123", teamId: dst.teamId, dryRun: true });
    expect(dryMissing.verified.ok).toBe(true);
    expect(dryMissing.assets.imported).toHaveLength(0);
    expect(dryMissing.assets.skipped).toHaveLength(2);
    expect(dryMissing.assets.skipped[0]!.reason).toContain(typeKey);

    const impMissing = await importBundle(zip, { api: BASE, email: `m63dst-${runId}@t.dev`, password: "password-123", teamId: dst.teamId });
    expect(impMissing.assets.imported).toHaveLength(0);
    expect(impMissing.assets.skipped).toHaveLength(2);
    expect(impMissing.relations.skipped).toHaveLength(1);
    expect(impMissing.relations.skipped[0]!.reason).toContain("端点资产未导入成功");

    // 目标团队注册同版类型后：dry-run 计划可导入 → 真实回导资产+制品+关系全成功
    const typeReg2 = await call("POST", "/types", {
      session: dst.session,
      body: { teamId: dst.teamId, typeKey, version: "1.0.0", title: "M63文档", jsonSchema: { type: "object", properties: { note: { type: "string" } } } },
    });
    expectOk(typeReg2.status === 201, typeReg2.json, "目标团队类型注册失败");
    const dryOk = await importBundle(zip, { api: BASE, email: `m63dst-${runId}@t.dev`, password: "password-123", teamId: dst.teamId, dryRun: true });
    expect(dryOk.assets.imported).toHaveLength(2);
    expect(dryOk.relations.imported).toHaveLength(1);

    const imp = await importBundle(zip, { api: BASE, email: `m63dst-${runId}@t.dev`, password: "password-123", teamId: dst.teamId });
    expect(imp.verified.ok).toBe(true);
    expect(imp.assets.imported).toHaveLength(2);
    expect(imp.assets.skipped).toHaveLength(0);
    expect(imp.relations.imported).toHaveLength(1);
    expect(imp.relations.imported[0]).toMatchObject({ predicate: "dependsOn", fromName: "M63培训大纲", toName: "M63操作手册" });
    expect(imp.notes.join("\n")).toContain("别名未回导");

    // 目标团队可查到回导资产（走公开查询口径）
    const list = await call("GET", `/assets/search?teamId=${dst.teamId}&q=${encodeURIComponent("M63")}`, { session: dst.session });
    expect(list.status === 200);
    const names = JSON.stringify(list.json);
    expect(names).toContain("M63操作手册");
    expect(names).toContain("M63培训大纲");
  });

  it("坏包拒绝导入：篡改后校验不过，零写入（notes 声明未执行）", async () => {
    const { zip, artifactPath } = makeMiniBundle();
    const tampered = mutateEntry(zip, artifactPath, (d) => {
      const copy = Buffer.from(d);
      copy[0] ^= 0xff;
      return copy;
    });
    const dst = await register(`m63bad-${runId}@t.dev`, "M63坏包", `M63坏包团队-${runId}`);
    const report = await importBundle(tampered.report, { api: BASE, email: `m63bad-${runId}@t.dev`, password: "password-123", teamId: dst.teamId });
    expect(report.verified.ok).toBe(false);
    expect(report.assets.imported).toHaveLength(0);
    expect(report.relations.imported).toHaveLength(0);
    expect(report.notes.join("\n")).toContain("未执行任何写入");
  });
});

// ---------------- 测试侧 ZIP 变异工具（基于 readStoreZip 重建） ----------------

function mutateEntry(zip: Buffer, path: string, mutate: (data: Buffer) => Buffer): { report: Buffer } {
  const entries = readStoreZip(zip).map((e) =>
    e.path === path ? { path: e.path, data: mutate(e.data) } : { path: e.path, data: e.data }
  );
  return { report: buildStoreZip(entries) };
}

function rebuildWithout(zip: Buffer, path: string): Buffer {
  return buildStoreZip(readStoreZip(zip).filter((e) => e.path !== path).map((e) => ({ path: e.path, data: e.data })));
}

function appendEntry(zip: Buffer, path: string, data: Buffer): Buffer {
  return buildStoreZip([...readStoreZip(zip).map((e) => ({ path: e.path, data: e.data })), { path, data }]);
}
