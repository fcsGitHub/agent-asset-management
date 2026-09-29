// M58 集成测试 — 发布测试门禁与批量关联下载：
// ①门禁（GitHub required checks 思想）：类型声明 requires_test_evidence → 该类型资产的
//   CR 发布被强制校验「候选精确修订上最新一次测试运行 = pass」；无运行拦、最新 fail 拦、
//   prepare 之后状态翻转由快照摘要折叠兜底（REVIEW_DIGEST_CHANGED）；非门禁类型零影响。
// ②批量下载：资产 + confirmed 关系闭包 / 策展集合 → 一次请求 ZIP（manifest.json +
//   manifest-sha256.txt + 制品原文件）；跳数/方向/防环/越权（M57 同款：伪造 teamId → 404）。
// ③@taw/domain 纯函数：traverseClosure（深度/方向/环/截断）、buildBundlePlan（路径安全/
//   重名消解/校验和行/闭包外边过滤）、buildStoreZip（确定性/CRC 向量/可解析回读）、
//   checkTestGate（四态判定 + 摘要不匹配）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import {
  traverseClosure,
  buildBundlePlan,
  buildStoreZip,
  checkTestGate,
  crc32,
  type BundleAsset,
  type ClosureEdge,
} from "@taw/domain/bundle";

const PORT = 4158;
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

async function callRaw(method: string, path: string, session: Session): Promise<{ status: number; headers: Headers; buf: Buffer | null }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
  const ab = await res.arrayBuffer();
  return { status: res.status, headers: res.headers, buf: ab.byteLength > 0 ? Buffer.from(ab) : null };
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

/** 测试侧 store-only ZIP 解析（method=0 数据即原文，无需解压库）。 */
function parseZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65536); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("找不到 EOCD");
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`中央目录签名错误 @${off}`);
    const size = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`本地头签名错误 @${localOff}`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    files.set(name, Buffer.from(buf.subarray(dataStart, dataStart + size)));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ---------------------------------------------------------------------------
// 纯函数（@taw/domain/bundle）

describe("M58 纯函数：闭包遍历 / 打包计划 / store ZIP / 门禁判定", () => {
  const A = "11111111-1111-1111-1111-111111111111";
  const B = "22222222-2222-2222-2222-222222222222";
  const C = "33333333-3333-3333-3333-333333333333";
  const D = "44444444-4444-4444-4444-444444444444";
  const edges: ClosureEdge[] = [
    { fromAssetId: A, toAssetId: B, predicate: "documentedBy" },
    { fromAssetId: B, toAssetId: C, predicate: "documentedBy" },
    { fromAssetId: C, toAssetId: A, predicate: "documentedBy" }, // 环：首达路径保留
    { fromAssetId: D, toAssetId: A, predicate: "documentedBy" },
  ];

  it("traverseClosure：深度截断、方向过滤、防环、上限警告", () => {
    const both3 = traverseClosure([A], edges, { depth: 3, direction: "both" });
    expect(both3.visits.get(A)).toEqual({ hop: 0, via: null });
    expect(both3.visits.get(B)!.hop).toBe(1); // 出边 A→B
    expect(both3.visits.get(C)!.hop).toBe(1); // 入边 C→A（both 视作无向，1 跳可达）
    expect(both3.visits.get(D)!.hop).toBe(1); // 入边 D→A
    expect(both3.visits.size).toBe(4);

    const d1 = traverseClosure([A], edges, { depth: 1, direction: "both" });
    expect(d1.visits.size).toBe(4); // A 的无向邻居恰为 B/C/D

    const outOnly = traverseClosure([A], edges, { depth: 3, direction: "out" });
    // 出向链 A→B→C，C→A 环不再扩散；D 只在入向、不进闭包
    expect([...outOnly.visits.keys()].sort()).toEqual([A, B, C].sort());
    expect(outOnly.visits.get(C)!.hop).toBe(2);

    const capped = traverseClosure([A], edges, { depth: 3, direction: "both", maxAssets: 2 });
    expect(capped.visits.size).toBe(2);
    expect(capped.warnings.some((w) => w.includes("截断"))).toBe(true);
  });

  it("buildBundlePlan：路径安全化、重名消解、校验和行、闭包外边过滤、警告透传", () => {
    const hex = (s: string) => (s.replace(/-/g, "") + "0".repeat(64)).slice(0, 64);
    const mk = (id: string, name: string, artName: string): BundleAsset => ({
      id, name, typeKey: "simulation.model", typeVersion: "1.0.0", lifecycle: "active",
      aliases: [], revisionId: `rev-${id}`, revisionSeq: 1, contentDigest: hex(`cd${id}`),
      properties: { frame: "ECI" },
      artifacts: [{ digest: hex(id), role: "implementation", originalName: artName, mediaType: "text/plain", size: 10 }],
      hop: 0, via: null,
    });
    const plan = buildBundlePlan(
      { kind: "asset", id: A, name: "起点", depth: 1, direction: "both" },
      [mk(A, "同名模型", "a/b\\c:*.txt"), mk(B, "同名模型", "a/b\\c:*.txt")],
      edges,
      new Map([["documentedBy", "文档说明"]]),
      new Map([[A, "同名模型"], [B, "同名模型"], [C, "x"], [D, "y"]]),
      "2026-09-29T00:00:00Z",
      ["测试警告"]
    );
    // 危险字符被替换、不出现路径分隔符；同目录重名追加 -2
    const paths = plan.files.map((f) => f.path);
    expect(paths[0]).toBe("assets/simulation.model/同名模型/a_b_c__.txt");
    expect(paths[1]).toBe("assets/simulation.model/同名模型/a_b_c__-2.txt");
    // 校验和行：sha256sum 格式（两空格）且覆盖全部文件
    const lines = plan.checksumLines.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => /^[0-9a-f]{64}  \S/.test(l))).toBe(true);
    // 闭包外资产（C/D 不在 assets 里）的边被过滤
    const relAssets = (plan.manifest.relations as { fromAssetId: string; toAssetId: string }[]).flatMap((r) => [r.fromAssetId, r.toAssetId]);
    expect(relAssets.every((x) => x === A || x === B)).toBe(true);
    expect((plan.manifest.relations as { predicate: string }[])[0].predicate).toBe("documentedBy"); // M63：predicate=type_key（机器可解析）
    expect((plan.manifest.relations as { predicateTitle: string }[])[0].predicateTitle).toBe("文档说明");
    expect((plan.manifest as { warnings: string[] }).warnings).toEqual(["测试警告"]);
    expect((plan.manifest as { source: { kind: string } }).source.kind).toBe("asset");
  });

  it("buildStoreZip：确定性、CRC 向量、可解析回读", () => {
    expect(crc32(Buffer.from("123456789", "utf8"))).toBe(0xcbf43926);
    const entries = [
      { path: "manifest.json", data: Buffer.from('{"tawBundle":1}', "utf8") },
      { path: "assets/x/y.bin", data: Buffer.from([0, 1, 2, 255]) },
    ];
    const z1 = buildStoreZip(entries);
    const z2 = buildStoreZip(entries);
    expect(z1.equals(z2)).toBe(true);
    const parsed = parseZip(z1);
    expect(parsed.get("manifest.json")!.toString("utf8")).toBe('{"tawBundle":1}');
    expect([...parsed.get("assets/x/y.bin")!]).toEqual([0, 1, 2, 255]);
  });

  it("checkTestGate：四态判定 + 证据摘要不匹配 + 同刻时间戳按 id 决胜", () => {
    const item = { assetId: A, assetName: "M", revisionId: "r2", contentDigest: "cd2", requiresTestEvidence: true };
    expect(checkTestGate({ ...item, requiresTestEvidence: false }, []).reason).toBe("not_required");
    expect(checkTestGate(item, []).reason).toBe("no_runs");
    expect(checkTestGate(item, [{ id: "t1", targetRevisionId: "r2", targetContentDigest: "cd2", result: "pass", executedAt: "2026-01-01T00:00:00Z", testAssetId: "x" }]).satisfied).toBe(true);
    // 最新一次 fail 压过更早的 pass（strict 模式）
    const mixed = checkTestGate(item, [
      { id: "t1", targetRevisionId: "r2", targetContentDigest: "cd2", result: "pass", executedAt: "2026-01-01T00:00:00Z", testAssetId: "x" },
      { id: "t2", targetRevisionId: "r2", targetContentDigest: "cd2", result: "fail", executedAt: "2026-01-02T00:00:00Z", testAssetId: "x" },
    ]);
    expect(mixed.satisfied).toBe(false);
    expect(mixed.latestResult).toBe("fail");
    // 证据只对精确摘要有效
    const wrongDigest = checkTestGate(item, [{ id: "t3", targetRevisionId: "r2", targetContentDigest: "OTHER", result: "pass", executedAt: "2026-01-01T00:00:00Z", testAssetId: "x" }]);
    expect(wrongDigest.satisfied).toBe(false);
    // 同 executedAt：id 决胜（取大）
    const tie = checkTestGate(item, [
      { id: "t1", targetRevisionId: "r2", targetContentDigest: "cd2", result: "pass", executedAt: "2026-01-01T00:00:00Z", testAssetId: "x" },
      { id: "t2", targetRevisionId: "r2", targetContentDigest: "cd2", result: "fail", executedAt: "2026-01-01T00:00:00Z", testAssetId: "x" },
    ]);
    expect(tie.latestRunId).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// 集成（真实 PG / HTTP / 文件）

describe("M58 发布测试门禁与批量关联下载（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session, outsider: Session;
  let teamId = "", projectId = "";
  let gatedTypeVersionId = "", plainTypeVersionId = "", relDocId = "";
  let modelA = "", docB = "", softC = "", gateModel = "", gateTestAsset = "";
  const tv: Record<string, string> = {};

  async function mkAsset(session: Session, name: string, typeVersionId: string, opts: { artifact?: { digest: string; originalName: string; size: number }; props?: Record<string, unknown> } = {}): Promise<string> {
    const r = await call("POST", "/assets", {
      session,
      body: {
        teamId, name, typeVersionId, properties: opts.props ?? {},
        ...(opts.artifact ? { artifacts: [{ digest: opts.artifact.digest, role: "implementation", originalName: opts.artifact.originalName, mediaType: "text/plain", size: opts.artifact.size }] } : {}),
      },
    });
    expectOk(r.status === 201, r.json, `${name} 登记失败`);
    return r.json.assetId as string;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await register(`m58admin-${runId}@t.dev`, "M58管理员", `M58团队-${runId}`);
    admin = reg.session; teamId = reg.teamId;
    // 成员先注册（端点按 email 找已存在用户），再由管理员拉入团队
    const memberReg = await register(`m58member-${runId}@t.dev`, "M58成员", `M58成员团-${runId}`);
    member = memberReg.session;
    const mem = await fetch(`${BASE}/teams/${teamId}/members`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ email: `m58member-${runId}@t.dev`, role: "member" }),
    });
    expectOk(mem.status === 201, await mem.text(), "加成员失败");
    const out = await register(`m58out-${runId}@t.dev`, "外人", `M58外团-${runId}`);
    outsider = out.session;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M58验证", code: `m58-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;

    // 门禁类型（策略在类型层声明）与自由类型
    const gateType = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `m58.gated.${runId.slice(0, 4)}`, version: "1.0.0", title: "门禁仿真模型",
        jsonSchema: { type: "object", properties: { interfaceVersion: { type: "string" } } },
        requiresTestEvidence: true,
      },
    });
    expectOk(gateType.status === 201, gateType.json, "门禁类型注册失败");
    gatedTypeVersionId = gateType.json.typeVersionId;
    const plainType = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m58.plain.${runId.slice(0, 4)}`, version: "1.0.0", title: "普通类型", jsonSchema: { type: "object" } },
    });
    expectOk(plainType.status === 201, plainType.json, "普通类型注册失败");
    plainTypeVersionId = plainType.json.typeVersionId;

    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string; requires_test_evidence?: boolean }[];
    for (const t of types) tv[t.type_key] = t.id;
    const gatedRow = types.find((t) => t.id === gatedTypeVersionId);
    expectOk(gatedRow?.requires_test_evidence === true, gatedRow, "GET /types 应带 requires_test_evidence=true");
    const relTypes = (await call("GET", `/relation-types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    relDocId = relTypes.find((r) => r.type_key === "documentedBy")!.id;

    // 链路资产：A --documentedBy--> B --documentedBy--> C（各带制品）
    const artA = await upload(member, teamId, `m58-model-payload-${runId}`, `模型A-${runId}.txt`);
    const artB = await upload(member, teamId, `m58-doc-payload-${runId}`, `文档B ${runId}.md`);
    const artC = await upload(member, teamId, `m58-soft-payload-${runId}`, `soft_${runId}.py`);
    modelA = await mkAsset(member, "M58轨道模型", gatedTypeVersionId, { artifact: { digest: artA.digest, originalName: `模型A-${runId}.txt`, size: artA.size } });
    docB = await mkAsset(member, "M58接口文档", tv["document"], {
      artifact: { digest: artB.digest, originalName: `文档B ${runId}.md`, size: artB.size },
      props: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m58" },
    });
    softC = await mkAsset(member, "M58处理软件", tv["software"], {
      artifact: { digest: artC.digest, originalName: `soft_${runId}.py`, size: artC.size },
      props: { language: "python", entry: "main.py", interfaceVersion: "if-m58", runtime: "python3.12", license: "MIT" },
    });
    for (const [s, t] of [[modelA, docB], [docB, softC]] as [string, string][]) {
      const rel = await call("POST", "/relations", { session: member, body: { teamId, relationTypeVersionId: relDocId, sourceAssetId: s, targetAssetId: t, confirm: true, evidenceNote: "M58 链路" } });
      expectOk(rel.status === 201, rel.json, "关系断言失败");
    }

    // 门禁流程资产（member 提案 → admin 发布）
    gateModel = await mkAsset(member, "M58门禁模型", gatedTypeVersionId);
    gateTestAsset = await mkAsset(member, "M58回归套件", tv["test.suite"], {
      props: { testTarget: "simulation", execProtocol: "pytest", fixtureVersion: "f1", passThreshold: 1 },
    });
  });
  afterAll(async () => { await app.close(); });

  // ---------------- 批量关联下载 ----------------

  it("资产闭包打包：manifest + 校验和 + 制品原文，2 跳闭包与跳数/方向生效", async () => {
    const res = await callRaw("GET", `/assets/${modelA}/bundle?teamId=${teamId}&depth=2&direction=out`, member);
    expectOk(res.status === 200, res.status, "bundle 下载失败");
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition") ?? "").toContain("bundle-");
    const files = parseZip(res.buf!);
    // 三资产制品 + 两条 manifest
    const payloadPaths = [...files.keys()].filter((p) => p.startsWith("assets/"));
    expect(payloadPaths).toHaveLength(3);
    expect(files.has("manifest.json")).toBe(true);
    expect(files.has("manifest-sha256.txt")).toBe(true);
    // 制品字节与上传原文一致（store-only 数据即原文）
    const artA = files.get(`assets/m58.gated.${runId.slice(0, 4)}/M58轨道模型/模型A-${runId}.txt`);
    expect(artA!.toString("utf8")).toBe(`m58-model-payload-${runId}`);
    // manifest：来源、跳数、别名、关系（闭包内）
    const manifest = JSON.parse(files.get("manifest.json")!.toString("utf8")) as {
      tawBundle: number; source: { kind: string; depth: number; direction: string };
      assets: { id: string; name: string; hop: number; revision: { contentDigest: string }; artifacts: { path: string; digest: string }[] }[];
      relations: { fromAssetId: string; toAssetId: string; predicate: string; predicateTitle: string }[];
    };
    expect(manifest.tawBundle).toBe(1);
    expect(manifest.source).toMatchObject({ kind: "asset", depth: 2, direction: "out" });
    const hops = Object.fromEntries(manifest.assets.map((a) => [a.id, a.hop]));
    expect(hops[modelA]).toBe(0);
    expect(hops[docB]).toBe(1);
    expect(hops[softC]).toBe(2);
    expect(manifest.relations).toHaveLength(2);
    expect(manifest.relations.every((r) => r.predicate === "documentedBy" && r.predicateTitle === "文档说明")).toBe(true);
    // 校验和行与实际文件摘要一致
    for (const line of files.get("manifest-sha256.txt")!.toString("utf8").trim().split("\n")) {
      const [digest, path] = [line.slice(0, 64), line.slice(66)];
      expect(createHash("sha256").update(files.get(path)!).digest("hex")).toBe(digest);
    }
    // 使用度：包内每个资产 +1 真实下载
    const detail = (await call("GET", `/assets/${softC}?teamId=${teamId}`, { session: member })).json as { usage: { download: number } };
    expect(detail.usage.download).toBeGreaterThanOrEqual(1);
  });

  it("方向过滤：direction=in 只带上游；depth=1 只带直接关联", async () => {
    const res = await callRaw("GET", `/assets/${softC}/bundle?teamId=${teamId}&depth=1&direction=in`, member);
    expectOk(res.status === 200, res.status, "bundle 下载失败");
    const manifest = JSON.parse(parseZip(res.buf!).get("manifest.json")!.toString("utf8")) as { assets: { id: string }[] };
    const ids = manifest.assets.map((a) => a.id).sort();
    expect(ids).toEqual([docB, softC].sort());
  });

  it("集合打包：条目即范围（flat 不扩散）；空集合如实 422；畸形 id 404", async () => {
    const col = await call("POST", "/collections", { session: member, body: { teamId, name: `M58移交包-${runId}`, description: "批量下载验证" } });
    expectOk(col.status === 201, col.json, "集合创建失败");
    for (const a of [modelA, softC]) {
      await call("POST", `/collections/${col.json.collectionId}/items`, { session: member, body: { teamId, assetId: a, note: "包内" } });
    }
    const res = await callRaw("GET", `/collections/${col.json.collectionId}/bundle?teamId=${teamId}`, member);
    expectOk(res.status === 200, { status: res.status, body: res.buf?.toString("utf8").slice(0, 500) }, "集合打包失败");
    const manifest = JSON.parse(parseZip(res.buf!).get("manifest.json")!.toString("utf8")) as {
      source: { kind: string; name: string }; assets: { id: string; hop: number }[];
    };
    expect(manifest.source.kind).toBe("collection");
    const ids = manifest.assets.map((a) => a.id).sort();
    expect(ids).toEqual([modelA, softC].sort());
    expect(manifest.assets.every((a) => a.hop === 0)).toBe(true);
    // 空集合 / 畸形 id
    const empty = await call("POST", "/collections", { session: member, body: { teamId, name: `M58空包-${runId}` } });
    const emptyRes = await callRaw("GET", `/collections/${empty.json.collectionId}/bundle?teamId=${teamId}`, member);
    expect(emptyRes.status).toBe(422);
    const malformed = await callRaw("GET", `/collections/not-a-uuid/bundle?teamId=${teamId}`, member);
    expect(malformed.status).toBe(404);
  });

  it("越权（M57 同款）：外人伪造 teamId → 404；teamId 缺失 → 422", async () => {
    const forged = await callRaw("GET", `/assets/${modelA}/bundle?teamId=${teamId}`, outsider);
    expect(forged.status).toBe(404);
    const forgedCol = await callRaw("GET", `/collections/x/bundle?teamId=${teamId}`, outsider);
    expect(forgedCol.status).toBe(404);
    const missing = await callRaw("GET", `/assets/${modelA}/bundle`, member);
    expect(missing.status).toBe(422);
  });

  // ---------------- 发布测试门禁 ----------------

  /** 成员在分支上为资产保存新草稿修订并提交 CR（返回 CR id 与候选修订 id）。 */
  async function propose(session: Session, assetId: string, tag: string): Promise<{ crId: string; candidateRevisionId: string }> {
    const br = await call("POST", `/projects/${projectId}/branches`, { session, body: { teamId, name: `m58-${tag}-${runId}` } });
    expectOk(br.status === 201, br.json, "建分支失败");
    const save = await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session, body: { teamId, assetId, properties: { interfaceVersion: `v-${tag}` } },
    });
    expectOk(save.status === 201, save.json, "保存草稿失败");
    const cr = await call("POST", "/change-requests", {
      session,
      body: {
        teamId, branchId: br.json.branchId, title: `M58 门禁 ${tag}`, motivation: "门禁验证",
        relatedRefs: "无", changeSummary: "接口版本变更", compatibility: "向后兼容", testPlan: "回归套件", rollbackNotes: "回退上一发布",
      },
    });
    expectOk(cr.status === 201, cr.json, "CR 创建失败");
    return { crId: cr.json.changeRequestId, candidateRevisionId: save.json.revisionId };
  }

  async function recordRun(targetAssetId: string, targetRevisionId: string, result: "pass" | "fail"): Promise<void> {
    const testDetail = (await call("GET", `/assets/${gateTestAsset}?teamId=${teamId}`, { session: member })).json as { revisions: { id: string }[] };
    const r = await call("POST", `/projects/${projectId}/test-runs`, {
      session: member,
      body: {
        teamId, testAssetId: gateTestAsset, testRevisionId: testDetail.revisions[0]!.id,
        targetAssetId, targetRevisionId, result, summary: `M58 ${result}`, environment: "ci",
      },
    });
    expectOk(r.status === 201, r.json, "测试运行记录失败");
  }

  it("门禁拦截与放行：无运行 409 TEST_GATE_REQUIRED → 补证据后摘要失配 → 退回重提后发布成功", async () => {
    const { crId, candidateRevisionId } = await propose(member, gateModel, "no-run");
    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, { session: member, body: { teamId, channel: "stable", audience: "team" } });
    expectOk(prep.status === 201, prep.json, "prepare-review 失败");
    // CR 详情可见门禁状态（评审者提前看到，M58）
    const detail = (await call("GET", `/change-requests/${crId}?teamId=${teamId}`, { session: admin })).json as {
      items: { asset_id: string; test_gate?: { required: boolean; satisfied: boolean; reason: string } }[];
    };
    const gate = detail.items.find((i) => i.asset_id === gateModel)?.test_gate;
    expectOk(gate?.required === true && gate.satisfied === false && gate.reason === "no_runs", gate, "CR 详情应携带未满足门禁");
    const blocked = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest, note: "证据呢" },
    });
    expectOk(blocked.status === 409 && blocked.json.error.code === "TEST_GATE_REQUIRED", blocked.json, "无运行应被拦截");
    const blockedDetail = blocked.json.error.details as { assetId: string; reason: string }[];
    expect(blockedDetail[0].assetId).toBe(gateModel);

    // prepare 之后才补 pass 运行：现场门禁已满足，但快照冻结的是 no_runs → 摘要失配
    await recordRun(gateModel, candidateRevisionId, "pass");
    const stale = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest, note: "补了证据" },
    });
    expectOk(stale.status === 409 && stale.json.error.code === "REVIEW_DIGEST_CHANGED", stale.json, "门禁状态变化应使快照失效");

    // 退回 → 重新准备（冻结新状态）→ 发布成功
    await call("POST", `/change-requests/${crId}/changes-requested`, { session: admin, body: { teamId, comment: "请附测试证据后重提" } });
    const prep2 = await call("POST", `/change-requests/${crId}/prepare-review`, { session: member, body: { teamId, channel: "stable", audience: "team" } });
    expectOk(prep2.status === 201, prep2.json, "重新 prepare 失败");
    const detail2 = (await call("GET", `/change-requests/${crId}?teamId=${teamId}`, { session: admin })).json as {
      items: { test_gate?: { satisfied: boolean; reason: string } }[];
    };
    expectOk(detail2.items[0]!.test_gate?.satisfied === true && detail2.items[0]!.test_gate?.reason === "pass", detail2.items[0], "重提后门禁应为 pass");
    const pub = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep2.json.reviewDigest, note: "证据齐备" },
    });
    expectOk(pub.status === 200, pub.json, "有 pass 运行应放行");
  });

  it("门禁 strict：prepare 时证据齐备，prepare 后回归失败 → 发布拦截（最新一次为准）", async () => {
    const { crId, candidateRevisionId } = await propose(member, gateModel, "regress");
    await recordRun(gateModel, candidateRevisionId, "pass");
    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, { session: member, body: { teamId, channel: "stable", audience: "team" } });
    expectOk(prep.status === 201, prep.json, "prepare-review 失败");
    // prepare 之后回归失败：最新一次不是 pass → 显式拦截（而非笼统摘要失配）
    await recordRun(gateModel, candidateRevisionId, "fail");
    const pub = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest, note: "想发布" },
    });
    expectOk(pub.status === 409 && pub.json.error.code === "TEST_GATE_REQUIRED", pub.json, "回归后应被拦截");
    expect((pub.json.error.details as { latestResult: string }[])[0].latestResult).toBe("fail");
  });

  it("非门禁类型零影响：无任何测试运行也能正常发布（回归）", async () => {
    const plainAsset = await mkAsset(member, "M58普通资产", plainTypeVersionId);
    const { crId } = await propose(member, plainAsset, "plain");
    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, { session: member, body: { teamId, channel: "stable", audience: "team" } });
    expectOk(prep.status === 201, prep.json, "prepare-review 失败");
    const detail = (await call("GET", `/change-requests/${crId}?teamId=${teamId}`, { session: admin })).json as {
      items: { asset_id: string; test_gate?: { required: boolean } }[];
    };
    const gate = detail.items.find((i) => i.asset_id === plainAsset)?.test_gate;
    expectOk(gate?.required === false && gate.satisfied === true, gate, "非门禁类型应 not_required");
    const pub = await call("POST", `/change-requests/${crId}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest, note: "无门禁" },
    });
    expectOk(pub.status === 200, pub.json, "非门禁类型发布不应被拦");
  });
});
