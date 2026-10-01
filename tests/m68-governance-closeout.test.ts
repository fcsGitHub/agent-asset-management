// M68 治理收口轮集成测试（三项）：
// ①分享快照吊销（泄漏治理出口，Zenodo/GH token revoke 锚点）：创建→公开 200 →
//   管理权吊销 → 公开 410 SHARE_REVOKED → 团队内清单标注已吊销 → 重复吊销幂等；
//   外团队不可吊销；吊销不改 payload（列级 UPDATE 授权，公开端点 410 而非旧内容 200）。
// ②属性筛选算子（OpenMetadata 完整口径）：key>=v / key<=v 数值范围、点号嵌套路径
//   （#>>）、非数值行被范围比较排除而非报错、等值语义回归（M67 兼容）、
//   非数字范围值/坏键名 422 点名。
// ③治理动作进团队动态（audit_events 人机混排时间线）：血缘物化/标签传播/快照创建/
//   快照吊销各产生一条审计事件，GET /activity?action=… 可过滤，动作名进 filters 下发。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { parsePropFilters, formatPropFilters } from "@taw/domain/prop-filter";

const PORT = 4169;
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

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 600)}`);
}

describe("M68② 纯函数：prop-filter 算子与嵌套路径", () => {
  it("等值/范围/嵌套/两字符算符优先/同键覆盖/非法点名", () => {
    const { filters, problems } = parsePropFilters([
      "owner=alice", "score>=0.9", "score<=0.5", "metrics.accuracy>=0.8", "stage:prod", "bad", "k=", "score>=abc", "a b=1",
    ]);
    expect(filters).toEqual([
      { key: "owner", op: "=", value: "alice" },
      { key: "score", op: ">=", value: "0.9" },
      { key: "score", op: "<=", value: "0.5" },
      { key: "metrics.accuracy", op: ">=", value: "0.8" },
      { key: "stage", op: "=", value: "prod" },
    ]);
    // 同键不同算符各自保留（同键同算符才覆盖）
    expect(filters.filter((f) => f.key === "score")).toHaveLength(2);
    expect(problems.some((p) => p.includes("bad"))).toBe(true);
    expect(problems.some((p) => p.includes("键与值"))).toBe(true);
    expect(problems.some((p) => p.includes("值必须是数字"))).toBe(true);
    expect(problems.some((p) => p.includes("a b"))).toBe(true);
    expect(formatPropFilters(filters)).toBe("owner=alice score>=0.9 score<=0.5 metrics.accuracy>=0.8 stage=prod");
  });

  it("值里包含算符字符时按最早算符切分（owner=a=b → 值 a=b）", () => {
    const { filters } = parsePropFilters(["owner=a=b"]);
    expect(filters).toEqual([{ key: "owner", op: "=", value: "a=b" }]);
  });
});

describe("M68 治理收口（快照吊销/筛选算子/治理动态）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let outsider: Session;
  let teamId = "";
  let typeVersionId = "";
  let baseId = "", childId = "";
  let collectionId = "", snapshotId = "", token = "";
  const BASE_NAME = `m68-basenet-${runId}`;
  const CHILD_NAME = `m68-childnet-${runId}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m68admin-${runId}@t.dev`, password: "password-123", displayName: "M68管理员", teamName: `M68团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m68other-${runId}@t.dev`, password: "password-123", displayName: "M68外人", teamName: `M68外团队-${runId}` }),
    });
    outsider = sessionOf(o);
    const typeKey = `m68.model.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey, version: "1.0.0", title: "M68模型",
        jsonSchema: {
          type: "object",
          properties: {
            base_model: { type: "string" }, owner: { type: "string" }, score: { type: "number" },
            metrics: { type: "object", properties: { accuracy: { type: "number" } } },
          },
        },
      },
    });
    typeVersionId = typeReg.json.typeVersionId;
    const mk = async (name: string, properties: Record<string, unknown>, labels: string[] = []) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties, labels } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
      return r.json.assetId as string;
    };
    baseId = await mk(BASE_NAME, { owner: "m68-a", score: 0.95, metrics: { accuracy: 0.97 }, note: "base" }, ["m68lab"]);
    childId = await mk(CHILD_NAME, { owner: "m68-b", score: 0.42, metrics: { accuracy: 0.55 }, base_model: BASE_NAME });
    // 非数值 score 行：用 score 为 string 型的第二类型登记（M59 门禁合法入库）——
    // 范围筛选对该行应「排除」而不是 22P02 报错
    const textType = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `${typeKey}.text`, version: "1.0.0", title: "M68文本score",
        jsonSchema: { type: "object", properties: { owner: { type: "string" }, score: { type: "string" } } },
      },
    });
    const txt = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `m68-text-${runId}`, typeVersionId: textType.json.typeVersionId, properties: { owner: "m68-a", score: "not-a-number" } },
    });
    expectOk(txt.status === 201, txt.json, "文本 score 资产登记失败");
    // 血缘物化 + 标签传播（为 ③ 的审计断言铺底）；relation-types 列表触发默认类型播种
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    expectOk((relTypes.json as { type_key: string }[]).some((r) => r.type_key === "derivedFrom"), relTypes.json, "derivedFrom 未播种");
    const m = await call("POST", `/assets/${childId}/lineage/materialize`, { session: admin, body: { teamId } });
    expectOk(m.status === 200 && m.json.created === 1, m.json, "物化失败");
    const p1 = await call("GET", `/assets/${baseId}/propagate-labels?teamId=${teamId}`, { session: admin });
    const p2 = await call("POST", `/assets/${baseId}/propagate-labels`, { session: admin, body: { teamId, confirmPlanDigest: p1.json.planDigest } });
    expectOk(p2.status === 200 && p2.json.appliedAssets === 1, p2.json, "传播失败");
    // 集合 + 快照
    const col = await call("POST", "/collections", { session: admin, body: { teamId, name: `M68分享包-${runId}` } });
    collectionId = col.json.collectionId;
    for (const aid of [baseId, childId]) {
      const it = await call("POST", `/collections/${collectionId}/items`, { session: admin, body: { teamId, assetId: aid } });
      expectOk(it.status === 201, it.json, "集合条目失败");
    }
    const snap = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId } });
    expectOk(snap.status === 201, snap.json, "快照创建失败");
    snapshotId = snap.json.snapshotId;
    token = snap.json.token;
  });
  afterAll(async () => { await app.close(); });

  it("②数值范围与嵌套路径：>= 过滤子集；<= 对侧；嵌套 metrics.accuracy；非数值行被排除不报错；等值回归", async () => {
    const ge = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("score>=0.9")}`, { session: admin });
    expectOk(ge.status === 200, ge.json, "score>= 失败");
    let names = (ge.json as { name: string }[]).map((r) => r.name);
    expectOk(names.includes(BASE_NAME) && !names.includes(CHILD_NAME) && !names.includes(`m68-text-${runId}`), names, ">= 应只留高分数值行");

    const le = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("score<=0.5")}`, { session: admin });
    names = (le.json as { name: string }[]).map((r) => r.name);
    expectOk(names.includes(CHILD_NAME) && !names.includes(BASE_NAME), names, "<= 应只留低分行");

    const nested = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("metrics.accuracy>=0.9")}`, { session: admin });
    names = (nested.json as { name: string }[]).map((r) => r.name);
    expectOk(names.includes(BASE_NAME) && !names.includes(CHILD_NAME), names, "嵌套路径过滤失败");

    const eq = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("owner=m68-a")}`, { session: admin });
    names = (eq.json as { name: string }[]).map((r) => r.name);
    expectOk(names.includes(BASE_NAME) && names.includes(`m68-text-${runId}`) && !names.includes(CHILD_NAME), names, "等值语义回归失败");

    const badNum = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("score>=abc")}`, { session: admin });
    expectOk(badNum.status === 422 && JSON.stringify(badNum.json).includes("值必须是数字"), badNum.json, "非数字范围值应 422");
    const combo = await call("GET", `/assets/search?teamId=${teamId}&prop=${encodeURIComponent("owner=m68-a")}&prop=${encodeURIComponent("score>=0.9")}`, { session: admin });
    names = (combo.json as { name: string }[]).map((r) => r.name);
    expectOk(names.length === 1 && names[0] === BASE_NAME, names, "等值+范围组合应取交集");
  });

  it("①快照吊销：公开 200 → 吊销 → 公开 410 SHARE_REVOKED → 清单标注 → 重复吊销幂等 → 外团队 404", async () => {
    const pub1 = await call("GET", `/share/collections/${token}`);
    expectOk(pub1.status === 200, pub1.json, "吊销前公开读取应 200");
    const rv = await call("POST", `/collections/${collectionId}/snapshots/${snapshotId}/revoke`, { session: admin, body: { teamId } });
    expectOk(rv.status === 200 && rv.json.ok === true && rv.json.alreadyRevoked === false, rv.json, "吊销失败");
    const pub2 = await call("GET", `/share/collections/${token}`);
    expectOk(pub2.status === 410 && pub2.json.error.code === "SHARE_REVOKED", pub2.json, "吊销后应 410 SHARE_REVOKED");
    const list = await call("GET", `/collections/${collectionId}/snapshots?teamId=${teamId}`, { session: admin });
    const mine = (list.json as { snapshotId: string; revokedAt: string | null }[]).find((s) => s.snapshotId === snapshotId);
    expectOk(!!mine && !!mine.revokedAt, list.json, "清单应标注已吊销");
    const rv2 = await call("POST", `/collections/${collectionId}/snapshots/${snapshotId}/revoke`, { session: admin, body: { teamId } });
    expectOk(rv2.status === 200 && rv2.json.alreadyRevoked === true, rv2.json, "重复吊销应幂等");
    const ext = await call("POST", `/collections/${collectionId}/snapshots/${snapshotId}/revoke`, { session: outsider, body: { teamId } });
    expectOk(ext.status === 404, ext.json, "外团队吊销应 404");
    // 吊销后可再创建新快照（治理出口不是死路）
    const snap2 = await call("POST", `/collections/${collectionId}/snapshots`, { session: admin, body: { teamId } });
    expectOk(snap2.status === 201 && snap2.json.token !== token, snap2.json, "吊销后应可再创建新快照");
  });

  it("③治理动作进团队动态：四个动作各一条审计，action 过滤可查，动作中文名随响应下发", async () => {
    const activity = await call("GET", `/activity?teamId=${teamId}&limit=50`, { session: admin });
    expectOk(activity.status === 200, activity.json, "动态读取失败");
    const rows = (activity.json.items ?? []) as { action?: string; kind?: string }[];
    const seen = rows.map((r) => String(r.action ?? r.kind ?? ""));
    for (const act of ["asset.lineage_materialize", "asset.labels_propagate", "collection.snapshot_create", "collection.snapshot_revoke"]) {
      expectOk(seen.includes(act), seen, `动态缺 ${act}`);
    }
    // 动作中文名从服务端 ACTION_LABELS 下发（前端不硬编码副本）
    const actions = (activity.json.actions ?? []) as { value: string; label: string }[];
    const byValue = new Map(actions.map((a) => [a.value, a.label]));
    expectOk(byValue.get("asset.lineage_materialize") === "物化血缘关联", actions, "物化动作中文名缺失");
    expectOk(byValue.get("collection.snapshot_revoke") === "吊销分享快照", actions, "吊销动作中文名缺失");
    // action 精确过滤：吊销恰一条
    const f1 = await call("GET", `/activity?teamId=${teamId}&action=collection.snapshot_revoke`, { session: admin });
    expectOk(f1.status === 200, f1.json, "action 过滤失败");
    const f1rows = (f1.json.items ?? []) as { action?: string }[];
    expectOk(f1rows.length === 1, f1rows, "吊销过滤应恰一条");
  });
});
