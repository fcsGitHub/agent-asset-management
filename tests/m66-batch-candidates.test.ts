// M66 批量候选轮集成测试（四项）：
// ①制品继承语义（RFC 7386 merge-patch 口径）：缺省=沿用 head 制品行；显式提供=替换；
//   显式空数组=清空；缺省保存且属性不变 → contentDigest 与 head 一致（幂等）。
// ②bundle tagmanifest（BagIt RFC 8493 tag 文件清单）：路由产物含 tagmanifest 且校验通过；
//   manifest.json 元数据被改（checksum 与制品交叉核对都发现不了）由 tagmanifest 抓获；
//   旧格式包（无 tagmanifest）ok 且如实注记边界。
// ③完整度目录汇总：search 行级 completenessScore 与详情卡同分；sort=completeness 升序
//   （低分优先治理）。
// ④引用导出（Zenodo Cite 锚点）：BibTeX @misc 字段齐全+owner 缺失如实占位标注；
//   Markdown 行；跨团队 404。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { verifyBundle } from "@taw/domain/bundle-verify";
import { buildStoreZip } from "@taw/domain/bundle";
import { buildCitation } from "@taw/domain/cite";

const PORT = 4167;
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

async function callText(method: string, path: string, session: Session): Promise<{ status: number; text: string; contentType: string }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: session.cookie } });
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "" };
}

async function callRaw(method: string, path: string, session: Session): Promise<{ status: number; buf: Buffer | null }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
  const ab = await res.arrayBuffer();
  return { status: res.status, buf: ab.byteLength > 0 ? Buffer.from(ab) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
}

describe("M66 批量候选（制品继承/tagmanifest/完整度汇总/引用导出）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "";
  let typeVersionId = "";
  let artDigest = "";
  let fullAsset = ""; // 高分资产（owner+制品+关系+别名+标签）
  let bareAsset = ""; // 低分资产（仅必填）

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m66admin-${runId}@t.dev`, password: "password-123", displayName: "M66管理员", teamName: `M66团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M66验证", code: `m66-${runId}` } });
    projectId = proj.json.projectId;
    const typeKey = `m66.doc.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M66文档", jsonSchema: { type: "object", properties: { owner: { type: "string" }, note: { type: "string" } } } },
    });
    typeVersionId = typeReg.json.typeVersionId;
    // 制品
    const form = new FormData();
    form.append("file", new Blob(["m66 payload v1"]), "payload.bin");
    const up = await fetch(`${BASE}/uploads?teamId=${teamId}`, { method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf }, body: form });
    const upJson = (await up.json()) as { digest: string; size: number };
    artDigest = upJson.digest;
    // 高分资产：owner + 制品 + 标签；再补关系+别名
    const f = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M66完整资产", typeVersionId, properties: { owner: "alice", note: "full" }, labels: ["核心"], artifacts: [{ digest: artDigest, role: "implementation", originalName: "payload.bin", mediaType: "application/octet-stream", size: upJson.size }] },
    });
    fullAsset = f.json.assetId;
    // 低分资产：仅 note，无其余
    const b = await call("POST", "/assets", {
      session: admin, body: { teamId, name: "M66裸资产", typeVersionId, properties: { note: "bare" } },
    });
    bareAsset = b.json.assetId;
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const dependsOn = (relTypes.json as { id: string; type_key: string }[]).find((r) => r.type_key === "dependsOn")!;
    const rel = await call("POST", "/relations", {
      session: admin, body: { teamId, relationTypeVersionId: dependsOn.id, sourceAssetId: fullAsset, targetAssetId: bareAsset, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "关系创建失败");
    const alias = await call("POST", `/assets/${fullAsset}/aliases`, { session: admin, body: { teamId, alias: `m66-full-${runId.slice(0, 4)}` } });
    expectOk(alias.status === 201, alias.json, "别名创建失败");
  });
  afterAll(async () => { await app.close(); });

  it("③完整度汇总：search 行级分数与详情一致；sort=completeness 低分优先", async () => {
    const rows = await call("GET", `/assets/search?teamId=${teamId}`, { session: admin });
    expectOk(rows.status === 200, rows.json, "search 失败");
    const byId = new Map((rows.json as { id: string; completenessScore?: number }[]).map((r) => [r.id, r.completenessScore]));
    expect(byId.get(fullAsset)).toBe(100); // owner+关系+制品+别名+标签+无必填声明
    expect(byId.get(bareAsset)).toBeLessThan(50);           // 仅部分项
    // 与详情卡同分（同一条 computeCompleteness 定义）
    const detail = await call("GET", `/assets/${fullAsset}?teamId=${teamId}`, { session: admin });
    expect(detail.json.completeness.score).toBe(byId.get(fullAsset));
    // 升序：裸资产在前
    const sorted = await call("GET", `/assets/search?teamId=${teamId}&sort=completeness`, { session: admin });
    const ids = (sorted.json as { id: string }[]).map((r) => r.id);
    expectOk(ids.indexOf(bareAsset) < ids.indexOf(fullAsset), ids, "sort=completeness 应低分优先");
  });

  it("①制品继承：缺省沿用 head；显式替换；显式清空；属性不变时摘要幂等", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `m66-inherit-${runId}` } });
    const branchId = br.json.branchId;
    // 登记修订（r1）带制品 → 缺省保存（只改属性）→ r2 应继承制品
    const head1 = await call("GET", `/assets/${fullAsset}?teamId=${teamId}`, { session: admin });
    const r1 = head1.json.revisions[0];
    expect(r1.artifacts).toHaveLength(1);
    const save2 = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: fullAsset, properties: { note: "v2" } }, // 无 artifacts 字段
    });
    expectOk(save2.status === 201, save2.json, "缺省保存失败");
    const head2 = await call("GET", `/assets/${fullAsset}?teamId=${teamId}`, { session: admin });
    const r2 = head2.json.revisions[0];
    expect(r2.artifacts).toHaveLength(1); // 继承
    expect(r2.artifacts[0].blob_digest ?? r2.artifacts[0].digest).toBeTruthy();
    // 属性不变再缺省保存 → contentDigest 与 head 一致（同属性+同制品清单 ⇒ 同摘要，幂等）
    const save3 = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: fullAsset }, // 连 properties 都不改
    });
    expectOk(save3.status === 201, save3.json, "空保存失败");
    expect(save3.json.contentDigest).toBe(r2.content_digest ?? r2.contentDigest);
    // 显式替换：传新制品数组（复用同一 blob 但换 role 表意替换路径）
    const save4 = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin,
      body: { teamId, assetId: fullAsset, properties: { note: "v3" }, artifacts: [{ digest: artDigest, role: "documentation", originalName: "payload.bin", mediaType: "application/octet-stream", size: r1.artifacts[0].size }] },
    });
    expectOk(save4.status === 201, save4.json, "显式替换失败");
    const head4 = await call("GET", `/assets/${fullAsset}?teamId=${teamId}`, { session: admin });
    expect(head4.json.revisions[0].artifacts).toHaveLength(1);
    // 显式清空：空数组
    const save5 = await call("POST", `/branches/${branchId}/revisions`, {
      session: admin, body: { teamId, assetId: fullAsset, properties: { note: "v4" }, artifacts: [] },
    });
    expectOk(save5.status === 201, save5.json, "显式清空失败");
    const head5 = await call("GET", `/assets/${fullAsset}?teamId=${teamId}`, { session: admin });
    expect(head5.json.revisions[0].artifacts).toHaveLength(0);
  });

  it("②tagmanifest：路由产物含之且通过；manifest 元数据被改由 tagmanifest 抓获；旧包兼容注记", async () => {
    const dl = await callRaw("GET", `/assets/${fullAsset}/bundle?teamId=${teamId}&depth=1&direction=both`, admin);
    expectOk(dl.status === 200 && !!dl.buf, dl.status, "bundle 下载失败");
    const good = verifyBundle(dl.buf!);
    expectOk(good.ok, good.errors, "新格式包应通过");
    expect(good.tagManifest).toBe(true);
    expect(good.notes).toEqual([]);

    // 只改 manifest.json 的资产名（checksum 清单与制品交叉核对都发现不了）
    const { readStoreZip } = await import("@taw/domain/bundle-verify");
    const entries = readStoreZip(dl.buf!).map((e) => {
      if (e.path !== "manifest.json") return { path: e.path, data: e.data };
      const m = JSON.parse(e.data.toString("utf8")) as { assets: { name: string }[] };
      m.assets[0]!.name = "TAMPERED-NAME";
      return { path: e.path, data: Buffer.from(JSON.stringify(m, null, 2), "utf8") };
    });
    const tampered = verifyBundle(buildStoreZip(entries));
    expect(tampered.ok).toBe(false);
    expect(tampered.valid).toBe(false);
    expect(tampered.errors.join("\n")).toContain("tagmanifest 校验和不符：manifest.json");

    // 旧格式（无 tagmanifest）兼容：mini 包 ok 且注记边界
    const legacy = buildStoreZip(entries.filter((e) => e.path !== "tagmanifest-sha256.txt"));
    const legacyReport = verifyBundle(legacy);
    expect(legacyReport.ok).toBe(true);
    expect(legacyReport.tagManifest).toBe(false);
    expect(legacyReport.notes.join("\n")).toContain("不在包内可证");
  });

  it("④引用导出：BibTeX 字段齐全与 owner 占位、Markdown 行、跨团队 404；纯函数转义", async () => {
    const bib = await callText("GET", `/assets/${fullAsset}/cite?teamId=${teamId}&format=bibtex`, admin);
    expectOk(bib.status === 200, bib.text, "bibtex 失败");
    expect(bib.contentType).toContain("x-bibtex");
    expect(bib.text).toContain(`@misc{taw_${fullAsset.replace(/-/g, "").slice(0, 8)},`);
    expect(bib.text).toContain("title = {M66完整资产 (m66.doc");
    expect(bib.text).toContain("author = {alice}");
    expect(bib.text).toContain(`asset ${fullAsset}`);
    expect(bib.text).toContain("aliases:");

    // 裸资产无 owner → 占位 + note 如实标注
    const bibBare = await callText("GET", `/assets/${bareAsset}/cite?teamId=${teamId}&format=bibtex`, admin);
    expect(bibBare.text).toContain("author = {TAW 团队资产}");
    expect(bibBare.text).toContain("owner 未在属性中声明");

    const md = await callText("GET", `/assets/${fullAsset}/cite?teamId=${teamId}&format=markdown`, admin);
    expect(md.text).toContain("**M66完整资产**");
    expect(md.text).toContain(fullAsset);

    const outsider = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m66out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `M66外团-${runId}` }),
    });
    const outSession = sessionOf(outsider);
    const out = await callText("GET", `/assets/${fullAsset}/cite?teamId=${teamId}&format=bibtex`, outSession);
    expect(out.status).toBe(404);

    // 纯函数：BibTeX 花括号转义
    const escaped = buildCitation({ assetId: "ab".repeat(16), name: "a{b}c", typeKey: "t", typeVersion: "1" }, "bibtex").text;
    expect(escaped).toContain("a\\{b\\}c");
  });
});
