// M53 集成测试 — 分面检索与随取随用（CKAN 吸收项落地）：
// GET /assets/facets（类型/标签/分类聚合）、/assets/search 的 label 与 typePrefix 过滤、
// GET /blobs/:digest 回真实文件名（content-disposition）、目录行 has_artifacts 标记。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4135;
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
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

describe("M53 分面检索与随取随用", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "", projectId = "";
  let docAssetId = "", dataAssetId = "", plainAssetId = "";
  const typeVersionIds: Record<string, string> = {};
  let zipDigest = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m53admin-${runId}@t.dev`, password: "password-123", displayName: "分面管理员", teamName: `分面团队-${runId}` }),
    });
    admin = sessionOf(reg);
    console.error("debug register status:", reg.status, "setCookie n:", reg.headers.getSetCookie().length, "raw:", String(reg.headers.get("set-cookie") ?? "").slice(0, 80));
    if (reg.status !== 201) console.error("debug register body:", await reg.text());
    teamId = ((await reg.json()) as { teamId: string }).teamId;
    console.error("debug cookies:", admin.cookie ? "cookie-len=" + admin.cookie.length : "EMPTY", "csrf:", admin.csrf ? "set(len=" + admin.csrf.length + ")" : "EMPTY");
    const me = await call("GET", "/auth/me", { session: admin });
    console.error("debug /auth/me:", me.status, me.cookieNote ?? "", JSON.stringify(me.json).slice(0, 120));
    const proj = await call("POST", "/projects", {
      session: admin,
      body: { teamId, name: "分面验证", code: `facet-${runId}` },
    });
    if (proj.status !== 201) console.error("project create failed:", JSON.stringify(proj.json));
    expect(proj.status).toBe(201);
    projectId = proj.json.projectId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const t of types) typeVersionIds[t.type_key] = t.id;
  });
  afterAll(async () => { await app.close(); });

  async function register(name: string, typeKey: string, properties: object, extra: Record<string, unknown> = {}) {
    return call("POST", "/assets", {
      session: admin,
      body: { teamId, name, typeVersionId: typeVersionIds[typeKey], properties, ...extra },
    });
  }

  it("上传真实制品文件", async () => {
    const content = Buffer.from(`m53-artifact-${runId}-${"y".repeat(2048)}`);
    const form = new FormData();
    form.append("file", new Blob([content]), `m53-数据包-${runId}.zip`);
    const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
      method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf }, body: form,
    });
    expect(res.status).toBe(201);
    zipDigest = ((await res.json()) as { digest: string }).digest;
    expect(zipDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("登记三类资产：文档（带标签）、数据、软件（带制品）", async () => {
    const doc = await register("接口说明M53", "document", { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m53" }, {
      labels: ["重点", "接口"], categoryPath: "docs/interface",
    });
    expect(doc.status).toBe(201);
    docAssetId = doc.json.assetId;
    const data = await register("遥测数据集M53", "dataset" in typeVersionIds ? "dataset" : "document", { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m53" }, {
      labels: ["重点"], categoryPath: "data/telemetry",
    });
    expect(data.status).toBe(201);
    dataAssetId = data.json.assetId;
    const soft = await register("遥测处理M53", "software", {
      language: "python", entry: "main.py", interfaceVersion: "tm-53", runtime: "python3.11", license: "MIT",
    }, {
      artifacts: [{ digest: zipDigest, role: "implementation", originalName: `m53-数据包-${runId}.zip`, mediaType: "application/zip", size: 2048 + 32 }],
    });
    expect(soft.status).toBe(201);
    plainAssetId = soft.json.assetId;
  });

  it("facets 返回在用类型、标签计数与分类路径", async () => {
    const res = await call("GET", `/assets/facets?teamId=${teamId}`, { session: admin });
    expect(res.status).toBe(200);
    const facets = res.json as { typeKeys: string[]; labels: { label: string; count: number }[]; categories: string[] };
    expect(facets.typeKeys).toContain("document");
    expect(facets.typeKeys).toContain("software");
    const labelMap = new Map(facets.labels.map((l) => [l.label, l.count]));
    expect(labelMap.get("重点")).toBe(2);
    expect(labelMap.get("接口")).toBe(1);
    expect(facets.categories).toContain("docs/interface");
    expect(facets.categories).toContain("data/telemetry");
  });

  it("search?label= 只返回带该标签的资产", async () => {
    const res = await call("GET", `/assets/search?teamId=${teamId}&label=${encodeURIComponent("接口")}`, { session: admin });
    expect(res.status).toBe(200);
    const rows = res.json as { id: string; name: string }[];
    expect(rows.map((r) => r.id)).toEqual([docAssetId]);
  });

  it("search?typePrefix= 家族快筛（software 前缀只中软件）", async () => {
    const res = await call("GET", `/assets/search?teamId=${teamId}&typePrefix=software`, { session: admin });
    const rows = res.json as { id: string; type_key: string; has_artifacts: boolean }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const r of rows) expect(r.type_key.startsWith("software")).toBe(true);
    const soft = rows.find((r) => r.id === plainAssetId)!;
    expect(soft.has_artifacts).toBe(true);
  });

  it("无过滤时 search 行为不回归（has_artifacts 正确区分）", async () => {
    const res = await call("GET", `/assets/search?teamId=${teamId}`, { session: admin });
    const rows = res.json as { id: string; has_artifacts: boolean }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(docAssetId)?.has_artifacts).toBe(false);
    expect(byId.get(plainAssetId)?.has_artifacts).toBe(true);
  });

  it("下载制品回真实文件名（content-disposition RFC 5987）", async () => {
    const res = await fetch(`${BASE}/blobs/${zipDigest}?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition") ?? "";
    expect(cd).toContain("attachment");
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent(`m53-数据包-${runId}.zip`)}`);
  });
});
