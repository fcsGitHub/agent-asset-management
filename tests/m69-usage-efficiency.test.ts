// M69 日常取用轮集成测试（三项）：
// ①分享快照有效期（GitHub PAT 过期锚点）：过去时间 → 公开 410 SHARE_EXPIRED；
//   未来时间 → 200 且回显 expiresAt；永久（缺省）→ 200 + null；非法 ISO 422；
//   已过期再吊销 → SHARE_REVOKED 优先（吊销比过期更具体）；清单带 expiresAt/expired。
// ②目录清单导出（CKAN/Dataverse 口径）：CSV（BOM + 表头 + 行）与 JSON（结构化 +
//   total + 边界注记）走与 search 同一套过滤；format 非法 422；导出盖章 asset.export
//   审计；外团队 404。
// ③个人收藏（GitHub stars 锚点）：pin → search 行级 pinned=true + pinned=true 过滤
//   只剩它；跨用户隔离（第二名成员的收藏对管理员不可见，反之亦然）；unpin 后过滤为空；
//   重复 pin 幂等；详情端点附 pinned。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4170;
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
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

async function callText(method: string, path: string, session: Session): Promise<{ status: number; text: string; contentType: string; disposition: string }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { cookie: session.cookie, "x-csrf-token": session.csrf } });
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") ?? "", disposition: res.headers.get("content-disposition") ?? "" };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 600)}`);
}

describe("M69 日常取用（快照有效期/清单导出/个人收藏）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let teamId = "";
  let typeVersionId = "";
  let assetA = "", assetB = "", assetC = "";
  let collectionId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m69admin-${runId}@t.dev`, password: "password-123", displayName: "M69管理员", teamName: `M69团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    // 第二名团队成员（收藏跨用户隔离用）：先注册（自带团队），再由管理员按邮箱加入
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m69member-${runId}@t.dev`, password: "password-123", displayName: "M69成员", teamName: `M69成员临时团队-${runId}` }),
    });
    member = sessionOf(m);
    const add = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m69member-${runId}@t.dev`, role: "member" } });
    expectOk(add.status < 300, add.json, "加成员失败");
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m69other-${runId}@t.dev`, password: "password-123", displayName: "M69外人", teamName: `M69外团队-${runId}` }),
    });
    outsider = sessionOf(o);
    const typeKey = `m69.model.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M69模型", jsonSchema: { type: "object", properties: { owner: { type: "string" } } } },
    });
    typeVersionId = typeReg.json.typeVersionId;
    const mk = async (name: string, owner: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties: { owner } } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
      return r.json.assetId as string;
    };
    assetA = await mk(`m69-asset-a-${runId}`, "m69-owner-x");
    assetB = await mk(`m69-asset-b-${runId}`, "m69-owner-y");
    assetC = await mk(`m69-asset-c-${runId}`, "m69-owner-y");
    const col = await call("POST", "/collections", { session: admin, body: { teamId, name: `M69分享包-${runId}` } });
    collectionId = col.json.collectionId;
    const it = await call("POST", `/collections/${collectionId}/items`, { session: admin, body: { teamId, assetId: assetA } });
    expectOk(it.status === 201, it.json, "集合条目失败");
  });
  afterAll(async () => { await app.close(); });

  it("①快照有效期：过期 410 SHARE_EXPIRED；未来 200 回显；永久缺省；非法 422；吊销优先；清单带过期态", async () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const future = new Date(Date.now() + 7 * 86400_000).toISOString();
    const sExpired = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId, expiresAt: past } });
    expectOk(sExpired.status === 201, sExpired.json, "过期快照创建失败");
    const pub1 = await call("GET", `/share/collections/${sExpired.json.token}`);
    expectOk(pub1.status === 410 && pub1.json.error.code === "SHARE_EXPIRED", pub1.json, "过期应 410 SHARE_EXPIRED");
    const sFuture = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId, expiresAt: future } });
    expectOk(sFuture.status === 201 && sFuture.json.expiresAt === future, sFuture.json, "未来快照应回显 expiresAt");
    const pub2 = await call("GET", `/share/collections/${sFuture.json.token}`);
    expectOk(pub2.status === 200 && pub2.json.expiresAt === future, pub2.json, "未过期公开读取应 200");
    const sForever = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId } });
    expectOk(sForever.status === 201 && sForever.json.expiresAt === null, sForever.json, "缺省应为永久（null）");
    const bad = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId, expiresAt: "not-a-date" } });
    expectOk(bad.status === 422, bad.json, "非法 ISO 应 422");
    // 已过期再吊销 → 吊销优先（更具体的管理动作）
    const rv = await call("POST", `/collections/${collectionId}/snapshots/${sExpired.json.snapshotId}/revoke`, { session: admin, body: { teamId } });
    expectOk(rv.status === 200, rv.json, "吊销失败");
    const pub3 = await call("GET", `/share/collections/${sExpired.json.token}`);
    expectOk(pub3.status === 410 && pub3.json.error.code === "SHARE_REVOKED", pub3.json, "吊销应优先于过期");
    // 清单带过期态
    const list = await call("GET", `/collections/${collectionId}/snapshots?teamId=${teamId}`, { session: admin });
    const expiredRow = (list.json as { snapshotId: string; expired: boolean; expiresAt: string | null }[]).find((s) => s.snapshotId === sExpired.json.snapshotId);
    expectOk(expiredRow?.expired === true && !!expiredRow?.expiresAt, list.json, "清单应标注已过期");
  });

  it("②清单导出：CSV BOM+表头+筛选行；JSON 结构化+边界注记；format 非法 422；审计盖章；外团队 404", async () => {
    const csv = await callText("GET", `/assets/export?teamId=${teamId}&format=csv&prop=${encodeURIComponent("owner=m69-owner-x")}`, admin);
    expectOk(csv.status === 200 && csv.contentType.includes("text/csv"), csv, "CSV 导出失败");
    // BOM 用原始字节验证（fetch text() 会按 UTF-8 剥掉 U+FEFF）
    const rawRes = await fetch(`${BASE}/assets/export?teamId=${teamId}&format=csv`, { headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf } });
    const rawBytes = new Uint8Array(await rawRes.arrayBuffer());
    expectOk(rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf, [...rawBytes.slice(0, 3)], "CSV 应带 UTF-8 BOM");
    expectOk(csv.text.includes("name,type_key,type_version,lifecycle"), csv.text.slice(0, 200), "CSV 表头缺失");
    expectOk(csv.text.includes(`m69-asset-a-${runId}`) && !csv.text.includes(`m69-asset-b-${runId}`), csv.text.slice(0, 300), "CSV 应只含筛选命中行");
    expectOk(csv.disposition.includes("attachment"), csv.disposition, "应带 attachment");
    const json = await callText("GET", `/assets/export?teamId=${teamId}&format=json&prop=${encodeURIComponent("owner=m69-owner-y")}`, admin);
    const parsed = JSON.parse(json.text) as { total: number; items: { name: string }[]; note: string };
    expectOk(json.status === 200 && parsed.total === 2, parsed, "JSON 导出条数应=2");
    expectOk(parsed.items.every((it) => it.name.startsWith("m69-asset-")), parsed.items, "JSON 行过滤失败");
    expectOk(parsed.note.includes("属性明细不在导出中"), parsed.note, "JSON 应注记属性边界");
    const bad = await call("GET", `/assets/export?teamId=${teamId}&format=xml`, { session: admin });
    expectOk(bad.status === 422, bad.json, "format 非法应 422");
    const ext = await call("GET", `/assets/export?teamId=${teamId}&format=csv`, { session: outsider });
    expectOk(ext.status === 404, ext.json, "外团队应 404");
    // 审计盖章
    const act = await call("GET", `/activity?teamId=${teamId}&action=asset.export&limit=10`, { session: admin });
    const rows = (act.json.items ?? []) as { action?: string }[];
    expectOk(rows.length >= 2, rows, "asset.export 审计应≥2 条（两次导出）");
  });

  it("③个人收藏：行级 pinned + 只看收藏过滤 + 跨用户隔离 + 幂等 + 详情 pinned + 取消", async () => {
    const pin1 = await call("POST", `/assets/${assetA}/pin`, { session: admin, body: { teamId } });
    expectOk(pin1.status === 200 && pin1.json.pinned === true, pin1.json, "pin 失败");
    const dup = await call("POST", `/assets/${assetA}/pin`, { session: admin, body: { teamId } });
    expectOk(dup.status === 200, dup.json, "重复 pin 应幂等");
    // 行级视角：管理员看 assetA pinned=true，其余 false
    const rows = await call("GET", `/assets/search?teamId=${teamId}&limit=50`, { session: admin });
    const byId = new Map((rows.json as { id: string; pinned: boolean }[]).map((r) => [r.id, r.pinned]));
    expectOk(byId.get(assetA) === true && byId.get(assetB) === false && byId.get(assetC) === false, [...byId], "行级 pinned 视角错误");
    // 只看收藏
    const only = await call("GET", `/assets/search?teamId=${teamId}&pinned=true`, { session: admin });
    expectOk((only.json as { id: string }[]).length === 1 && only.json[0].id === assetA, only.json, "pinned 过滤应只剩 assetA");
    // 成员收藏 assetB——管理员不可见，成员自己的视角正确
    const pinB = await call("POST", `/assets/${assetB}/pin`, { session: member, body: { teamId } });
    expectOk(pinB.status === 200, pinB.json, "成员 pin 失败");
    const adminOnly = await call("GET", `/assets/search?teamId=${teamId}&pinned=true`, { session: admin });
    expectOk((adminOnly.json as { id: string }[]).every((r) => r.id === assetA), adminOnly.json, "管理员的收藏视图不应混入成员收藏");
    const memberOnly = await call("GET", `/assets/search?teamId=${teamId}&pinned=true`, { session: member });
    const memberIds = (memberOnly.json as { id: string }[]).map((r) => r.id);
    expectOk(memberIds.includes(assetB) && !memberIds.includes(assetA), memberIds, "成员收藏视图应只含自己的");
    // 详情 pinned
    const dA = await call("GET", `/assets/${assetA}?teamId=${teamId}`, { session: admin });
    expectOk(dA.json.pinned === true, dA.json.pinned, "详情应带 pinned=true");
    const dA2 = await call("GET", `/assets/${assetA}?teamId=${teamId}`, { session: member });
    expectOk(dA2.json.pinned === false, dA2.json.pinned, "成员视角 assetA 应 pinned=false");
    // 取消收藏
    const un = await call("DELETE", `/assets/${assetA}/pin?teamId=${teamId}`, { session: admin });
    expectOk(un.status === 200 && un.json.pinned === false, un.json, "unpin 失败");
    const empty = await call("GET", `/assets/search?teamId=${teamId}&pinned=true`, { session: admin });
    expectOk((empty.json as unknown[]).length === 0, empty.json, "取消后只看收藏应为空");
  });
});
