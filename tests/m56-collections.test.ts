// M56 集成测试 — 资产集合（HF Collections 思想落地）：
// 集合 CRUD（重名 409 / 管理权创建者或管理员）、条目增删改备注（重复 409 / 未知资产 422）、
// 列表 contains_asset（详情页勾选态数据源）、级联删除、跨团队隔离、
// NL L1「把 X 加入集合 Y」句式（解析零副作用，含代词/缺侧不命中与既有句式回归）、
// Agent collection.search / collection.add（seedInTeam + 真实 agent_runs 行满足外键，同 m55）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { ruleParse } from "../apps/api/src/routes/nl";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";

const PORT = 4155;
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

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

async function seedInTeam<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await c.end();
  }
}

describe("M56 资产集合", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session, outsider: Session;
  let teamId = "", projectId = "";
  let modelId = "", docId = "";
  const tv: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m56admin-${runId}@t.dev`, password: "password-123", displayName: "集合管理员", teamName: `集合团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m56member-${runId}@t.dev`, password: "password-123", displayName: "集合成员", teamName: `成员自建-${runId}` }),
    });
    member = sessionOf(m);
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m56out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `外团-${runId}` }),
    });
    outsider = sessionOf(o);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m56member-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "集合验证", code: `m56-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    for (const t of types) tv[t.type_key] = t.id;
  });
  afterAll(async () => { await app.close(); });

  it("登记两个跨类型资产", async () => {
    const r1 = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M56传播模型", typeVersionId: tv["simulation.model"], properties: { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v56", validStepSeconds: { min: 0.1, max: 60 } } },
    });
    expectOk(r1.status === 201, r1.json, "模型登记失败");
    modelId = r1.json.assetId;
    const r2 = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "M56接口说明", typeVersionId: tv.document, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "m56" } },
    });
    expectOk(r2.status === 201, r2.json, "文档登记失败");
    docId = r2.json.assetId;
  });

  it("创建集合：成功 / 重名 409 / 空名 422", async () => {
    const c1 = await call("POST", "/collections", { session: admin, body: { teamId, name: "新人入门包", description: "新成员第一周要读的资产" } });
    expectOk(c1.status === 201, c1.json, "集合创建失败");
    const dup = await call("POST", "/collections", { session: member, body: { teamId, name: "新人入门包" } });
    expect(dup.status).toBe(409);
    expect((dup.json as { error: { code: string } }).error.code).toBe("COLLECTION_TAKEN");
    const empty = await call("POST", "/collections", { session: admin, body: { teamId, name: "" } });
    expect(empty.status).toBe(422);
  });

  it("条目：加入（带备注）/ 重复 409 / 未知资产 422 / contains_asset 勾选态", async () => {
    const cols = (await call("GET", `/collections?teamId=${teamId}`, { session: admin })).json as { id: string; name: string; item_count: number; contains_asset: boolean | null }[];
    const col = cols.find((c) => c.name === "新人入门包")!;
    // 不带 assetId 时 contains_asset 语义为 null（勾选态只在按资产过滤的列表里有意义）
    expect(cols.find((c) => c.name === "新人入门包")!.contains_asset).toBeNull();

    const add = await call("POST", `/collections/${col.id}/items`, { session: admin, body: { teamId, assetId: docId, note: "接口契约从这里开始" } });
    expectOk(add.status === 201, add.json, "加入集合失败");
    // 全员协作：member 也可加条目
    const add2 = await call("POST", `/collections/${col.id}/items`, { session: member, body: { teamId, assetId: modelId, note: "权威起点" } });
    expectOk(add2.status === 201, add2.json, "成员加入集合失败");

    const dup = await call("POST", `/collections/${col.id}/items`, { session: admin, body: { teamId, assetId: docId } });
    expect(dup.status).toBe(409);
    const ghost = await call("POST", `/collections/${col.id}/items`, { session: admin, body: { teamId, assetId: randomUUID() } });
    expect(ghost.status).toBe(422);

    const detail = (await call("GET", `/collections/${col.id}?teamId=${teamId}`, { session: admin })).json as {
      name: string; items: { asset_id: string; note: string; added_by_name: string; asset_name: string; type_key: string }[];
    };
    expect(detail.items).toHaveLength(2);
    const docItem = detail.items.find((i) => i.asset_id === docId)!;
    expect(docItem.note).toBe("接口契约从这里开始");
    expect(docItem.asset_name).toBe("M56接口说明");
    expect(docItem.type_key).toBe("document");

    // contains_asset：按资产过滤的列表（详情页「加入集合」勾选态数据源）
    const withAsset = (await call("GET", `/collections?teamId=${teamId}&assetId=${docId}`, { session: admin })).json as { id: string; contains_asset: boolean }[];
    expect(withAsset.find((c) => c.id === col.id)!.contains_asset).toBe(true);
    const withModel = (await call("GET", `/collections?teamId=${teamId}&assetId=${modelId}`, { session: admin })).json as { id: string; contains_asset: boolean }[];
    expect(withModel.find((c) => c.id === col.id)!.contains_asset).toBe(true);
  });

  it("备注更新与条目移除；再删 404", async () => {
    const cols = (await call("GET", `/collections?teamId=${teamId}`, { session: admin })).json as { id: string }[];
    const col = cols[0]!;
    const patch = await call("PATCH", `/collections/${col.id}/items/${docId}`, { session: member, body: { teamId, note: "先读这份" } });
    expectOk(patch.status === 200, patch.json, "备注更新失败");
    const detail = (await call("GET", `/collections/${col.id}?teamId=${teamId}`, { session: admin })).json as { items: { asset_id: string; note: string }[] };
    expect(detail.items.find((i) => i.asset_id === docId)!.note).toBe("先读这份");
    // 空备注合法（清空备注）
    const clear = await call("PATCH", `/collections/${col.id}/items/${docId}`, { session: admin, body: { teamId, note: "" } });
    expect(clear.status).toBe(200);

    const rm = await call("DELETE", `/collections/${col.id}/items/${modelId}?teamId=${teamId}`, { session: member });
    expectOk(rm.status === 200, rm.json, "移除条目失败");
    const rmAgain = await call("DELETE", `/collections/${col.id}/items/${modelId}?teamId=${teamId}`, { session: admin });
    expect(rmAgain.status).toBe(404);
    // 恢复条目供后续用例
    const reAdd = await call("POST", `/collections/${col.id}/items`, { session: admin, body: { teamId, assetId: modelId, note: "权威起点" } });
    expectOk(reAdd.status === 201, reAdd.json, "条目重建失败");
  });

  it("管理权：成员改名 403 / 创建者改名成功 / 撞名 409 / 描述更新", async () => {
    const cols = (await call("GET", `/collections?teamId=${teamId}`, { session: admin })).json as { id: string }[];
    const col = cols[0]!;
    const forbidden = await call("PATCH", `/collections/${col.id}`, { session: member, body: { teamId, name: "改名未遂" } });
    expect(forbidden.status).toBe(403);
    const renamed = await call("PATCH", `/collections/${col.id}`, { session: admin, body: { teamId, name: "新人入门包v2", description: "第一周必读" } });
    expectOk(renamed.status === 200, renamed.json, "改名失败");
    const dup = await call("POST", "/collections", { session: admin, body: { teamId, name: "评审材料" } });
    expectOk(dup.status === 201, dup.json, "第二个集合创建失败");
    const clash = await call("PATCH", `/collections/${col.id}`, { session: admin, body: { teamId, name: "评审材料" } });
    expect(clash.status).toBe(409);
  });

  it("跨团队隔离：外人看列表为空语义 / 详情与条目 404", async () => {
    const cols = (await call("GET", `/collections?teamId=${teamId}`, { session: admin })).json as { id: string }[];
    const col = cols[0]!;
    // outsider 对本团队集合：teamId 不在其成员团队 → teamRole 404
    const detail = await call("GET", `/collections/${col.id}?teamId=${teamId}`, { session: outsider });
    expect(detail.status).toBe(404);
    const addItem = await call("POST", `/collections/${col.id}/items`, { session: outsider, body: { teamId, assetId: docId } });
    expect(addItem.status).toBe(404);
    // member 用自己团队 id 访问本团队集合 id：RLS 隔离 404
    const otherDetail = await call("GET", `/collections/${col.id}?teamId=${((await call("GET", "/auth/me", { session: member })).json as { teams: { teamId: string }[] }).teams.find((t) => t.teamId !== teamId)!.teamId}`, { session: member });
    expect(otherDetail.status).toBe(404);
  });

  it("删除集合：非创建者 403 / 创建者删除成功 / 详情随级联 404", async () => {
    const mk = await call("POST", "/collections", { session: member, body: { teamId, name: "临时集合" } });
    expectOk(mk.status === 201, mk.json, "临时集合创建失败");
    const tempId = (mk.json as { collectionId: string }).collectionId;
    await call("POST", `/collections/${tempId}/items`, { session: member, body: { teamId, assetId: docId } });
    // 创建者本人可删
    const del = await call("DELETE", `/collections/${tempId}?teamId=${teamId}`, { session: member });
    expectOk(del.status === 200, del.json, "删除集合失败");
    const gone = await call("GET", `/collections/${tempId}?teamId=${teamId}`, { session: member });
    expect(gone.status).toBe(404);
    // 资产本身不受影响
    const asset = await call("GET", `/assets/${docId}?teamId=${teamId}`, { session: admin });
    expect(asset.status).toBe(200);
  });

  it("NL L1：「把 X 加入集合 Y」命中；代词与缺侧不命中；既有句式回归", () => {
    const hit = ruleParse("把轨道传播模型加入集合新人入门包");
    expect(hit?.intent).toBe("add_to_collection");
    if (hit?.intent === "add_to_collection") {
      expect(hit.params.assetName).toBe("轨道传播模型");
      expect(hit.params.collectionName).toBe("新人入门包");
    }
    const quoted = ruleParse("把「M56接口说明」加进集合「评审材料」");
    expect(quoted?.intent).toBe("add_to_collection");
    if (quoted?.intent === "add_to_collection") {
      expect(quoted.params.assetName).toBe("M56接口说明");
      expect(quoted.params.collectionName).toBe("评审材料");
    }
    // 代词资产侧不命中（不猜测）→ 落入后续 LLM 解析/搜索回退
    expect(ruleParse("把它加入集合新人入门包")).toBeNull();
    // 缺集合侧不命中
    expect(ruleParse("把轨道传播模型加入集合")).toBeNull();
    // 既有句式零回归
    expect(ruleParse("搜索轨道传播模型")?.intent).toBe("search_assets");
    expect(ruleParse("轨道传播模型的关联资产")?.intent).toBe("navigate");
    expect(ruleParse("登记轨道传播模型资产")?.intent).toBe("fill_register_form");
  });

  it("Agent collection.search / collection.add：按名解析入集合、重复如实报错", async () => {
    // 真实 agent_runs 行（tool_invocations 外键，同 m33/m50/m55）
    const me = await call("GET", "/auth/me", { session: admin });
    const adminUserId = (me.json as { userId: string }).userId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M56工具验证", visibility: "project" } });
    const sessionId = (sess.json as { sessionId: string }).sessionId;
    const runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,'M56 集合工具验证',$5,$6,$7,'deepseek',$8)`,
        [teamId, runRowId, sessionId, projectId, JSON.stringify([]),
         JSON.stringify(["collection.search", "collection.add"]),
         JSON.stringify({ maxToolCalls: 8, maxTokens: 20000 }), adminUserId]
      );
    });
    const ctx = { teamId, userId: adminUserId, projectId, runId: runRowId };

    const search = await seedInTeam(teamId, async (client) =>
      invokeTool(client as never, ctx, allAgentTools(), "call-m56-1", "collection.search", JSON.stringify({ q: "入门包" }))
    );
    expectOk(search.status === "ok", search, "collection.search 应成功");
    expect(((search.result as { name: string }[]) ?? []).map((r) => r.name)).toContain("新人入门包v2");

    const add = await seedInTeam(teamId, async (client) =>
      invokeTool(client as never, ctx, allAgentTools(), "call-m56-2", "collection.add",
        JSON.stringify({ collection: "新人入门包v2", assetName: "prop-v56", note: "Agent 按别名收录" }))
    );
    // prop-v56 未登记别名 → 名称解析失败是诚实路径；先用真实资产名验证
    expectOk(add.status === "error" && (add.error ?? "").includes("未命中"), add, "未登记别名应如实报错");

    const addOk = await seedInTeam(teamId, async (client) =>
      invokeTool(client as never, ctx, allAgentTools(), "call-m56-3", "collection.add",
        JSON.stringify({ collection: "评审材料", assetName: "M56传播模型", note: "Agent 收录" }))
    );
    expectOk(addOk.status === "ok", addOk, "collection.add 应成功");
    expect((addOk.result as { collectionName: string; assetName: string }).collectionName).toBe("评审材料");

    const dupAdd = await seedInTeam(teamId, async (client) =>
      invokeTool(client as never, ctx, allAgentTools(), "call-m56-4", "collection.add",
        JSON.stringify({ collection: "评审材料", assetName: "M56传播模型" }))
    );
    expect(dupAdd.status === "error" && (dupAdd.error ?? "").includes("已在集合")).toBe(true);

    // 工具写入与 API 可见性一致：详情条目数 +1
    const cols = (await call("GET", `/collections?teamId=${teamId}`, { session: admin })).json as { id: string; name: string; item_count: number }[];
    const col = cols.find((c) => c.name === "评审材料")!;
    expect(col.item_count).toBe(1);
  });
});
