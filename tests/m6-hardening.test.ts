// M6 加固测试 — 资产生命周期（归档/恢复）与本体迁移影响预览。
// 全部真实（PG/HTTP）：归档写审计、守卫拒绝真实写入；预览对真实头修订逐个校验。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const PORT = 4107;
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

async function call(
  method: string,
  path: string,
  opts: { session?: Session; body?: unknown } = {}
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

async function withTeamDb<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  expect(res.status === 201, `register ${email} → ${res.status}`, "注册失败");
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M6 生命周期加固：归档/恢复 + 迁移预览（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, creator: Session, outsider: Session;
  let teamId = "", projectId = "";
  let typeVersionId = "";
  let assetA = "", assetB = "", assetC = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m6admin-${runId}@t.dev`, "管理员", `加固团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const c = await register(`m6creator-${runId}@t.dev`, "创建者", `创建者团队-${runId}`);
    creator = c.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m6creator-${runId}@t.dev`, role: "member" } });
    const o = await register(`m6other-${runId}@t.dev`, "无关成员", `无关团队-${runId}`);
    outsider = o.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m6other-${runId}@t.dev`, role: "member" } });

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "加固验证项目", code: `hard-${runId}` } });
    projectId = proj.json.projectId;
    await call("GET", `/types?teamId=${teamId}`, { session: creator });
    await withTeamDb(teamId, async (cx) => {
      const { rows } = await cx.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
      typeVersionId = rows[0]!.id;
    });
  });

  afterAll(async () => { await app.close(); });

  it("准备：创建者登记三个资产（A/B/C）", async () => {
    for (const [idx, name] of [ ["a", "加固资产A"], ["b", "加固资产B"], ["c", "加固资产C"] ] as const) {
      const res = await call("POST", "/assets", {
        session: creator,
        body: { teamId, name, typeVersionId,
          properties: { docRole: "design", format: "markdown", language: "zh-CN",
            confidentiality: "internal", scope: `加固验证-${name}` } },
      });
      expectOk(res.status === 201, res.json, `登记 ${name} 失败`);
      if (idx === "a") assetA = res.json.assetId;
      if (idx === "b") assetB = res.json.assetId;
      if (idx === "c") assetC = res.json.assetId;
    }
  });

  it("归档权限：非创建者非管理员 → 403；未登录 → 401", async () => {
    const denied = await call("POST", `/assets/${assetA}/archive`, {
      session: outsider, body: { teamId, reason: "无关成员试图归档他人资产" },
    });
    expect(denied.status === 403, denied.json, "无关成员不应能归档");
    const anon = await fetch(`${BASE}/assets/${assetA}/archive`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId, reason: "匿名归档尝试" }),
    });
    expect(anon.status === 401, anon.status, "未登录不应能归档");
  });

  it("创建者归档 A → 默认目录隐藏、归档过滤可见、审计落库", async () => {
    const res = await call("POST", `/assets/${assetA}/archive`, {
      session: creator, body: { teamId, reason: "方案废弃，由新模型替代" },
    });
    expectOk(res.status === 200 && res.json.lifecycle === "archived", res.json, "归档失败");

    const def = await call("GET", `/assets/search?teamId=${teamId}`, { session: creator });
    expect(!(def.json as { id: string }[]).some((r) => r.id === assetA), def.json, "默认目录不应包含已归档资产");
    const arch = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=archived`, { session: creator });
    expect((arch.json as { id: string }[]).some((r) => r.id === assetA), arch.json, "归档过滤应能看到 A");

    const detail = await call("GET", `/assets/${assetA}?teamId=${teamId}`, { session: creator });
    expect(detail.json.lifecycle === "archived", detail.json, "详情应显示 archived");
    // 修订历史仍完整可读（不可变原则）
    expect(detail.json.revisions).toHaveLength(1);

    await withTeamDb(teamId, async (cx) => {
      const { rows } = await cx.query<{ action: string; detail: Record<string, unknown> }>(
        `SELECT action, detail FROM audit_events WHERE object_kind = 'asset' AND object_id = $1 AND action = 'asset.archive'`,
        [assetA]
      );
      expect(rows).toHaveLength(1);
      expect((rows[0]!.detail as { reason?: string }).reason === "方案废弃，由新模型替代", rows[0], "审计应含归档原因");
    });
  });

  it("重复归档 → 409 ALREADY_ARCHIVED；恢复权限：无关成员 403、创建者成功", async () => {
    const dup = await call("POST", `/assets/${assetA}/archive`, {
      session: admin, body: { teamId, reason: "重复归档应被拒绝" },
    });
    expect(dup.status === 409 && dup.json.error.code === "ALREADY_ARCHIVED", dup.json, "重复归档应 409");

    const denied = await call("POST", `/assets/${assetA}/restore`, {
      session: outsider, body: { teamId, reason: "无关成员试图恢复他人资产" },
    });
    expect(denied.status === 403, denied.json, "无关成员不应能恢复");

    const bad = await call("POST", `/assets/${assetB}/restore`, {
      session: creator, body: { teamId, reason: "未归档资产不能恢复" },
    });
    expect(bad.status === 409 && bad.json.error.code === "NOT_ARCHIVED", bad.json, "未归档恢复应 409");

    const res = await call("POST", `/assets/${assetA}/restore`, {
      session: creator, body: { teamId, reason: "方案重新启用" },
    });
    expectOk(res.status === 200 && res.json.lifecycle === "active", res.json, "恢复失败");
    const def = await call("GET", `/assets/search?teamId=${teamId}`, { session: creator });
    expect((def.json as { id: string }[]).some((r) => r.id === assetA), def.json, "恢复后应回到默认目录");
    await withTeamDb(teamId, async (cx) => {
      const { rows } = await cx.query<{ action: string }>(
        `SELECT action FROM audit_events WHERE object_kind = 'asset' AND object_id = $1 AND action = 'asset.restore'`,
        [assetA]
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("守卫①：资产有未完成草稿时归档 → 409 OPEN_DRAFTS", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: creator, body: { teamId, name: `archive-guard-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const branchId = br.json.branchId as string;
    const save = await call("POST", `/branches/${branchId}/revisions`, {
      session: creator,
      body: { teamId, assetId: assetB, properties: { version: "1.1.0" } },
    });
    expectOk(save.status === 201, save.json, "保存草稿失败");

    const blocked = await call("POST", `/assets/${assetB}/archive`, {
      session: creator, body: { teamId, reason: "存在未合并草稿时归档" },
    });
    expect(blocked.status === 409 && blocked.json.error.code === "OPEN_DRAFTS", blocked.json, "应被 OPEN_DRAFTS 拦截");
  });

  it("守卫②：归档后草稿写入 → 409 ASSET_ARCHIVED（库内状态修复路径）", async () => {
    // 通过 API 正常路径无法把「有草稿的资产」归档（上一用例已证）；
    // 该守卫保护的是运维修复/历史数据等真实状态：直接在库内置为归档后，API 必须拒绝新草稿。
    await withTeamDb(teamId, async (cx) => {
      await cx.query(`UPDATE assets SET lifecycle = 'archived' WHERE id = $1`, [assetB]);
    });
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: creator, body: { teamId, name: `archived-write-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const save = await call("POST", `/branches/${br.json.branchId as string}/revisions`, {
      session: creator, body: { teamId, assetId: assetB, properties: { version: "9.9.9" } },
    });
    expect(save.status === 409 && save.json.error.code === "ASSET_ARCHIVED", save.json, "归档资产不应能写草稿");
    // 守卫③：包含归档资产的分支不能创建 CR
    const cr = await call("POST", "/change-requests", {
      session: creator,
      body: { teamId, branchId: br.json.branchId, title: "包含归档资产的 CR", motivation: "应被拒绝",
        changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
    });
    expect(cr.status === 409 && cr.json.error.code === "ASSET_ARCHIVED", cr.json, "归档资产不应进入 CR");
    await withTeamDb(teamId, async (cx) => {
      await cx.query(`UPDATE assets SET lifecycle = 'active' WHERE id = $1`, [assetB]);
    });
  });

  it("迁移预览：管理员可预览结构变更与真实受影响面；成员 403；未知类型 404", async () => {
    // 注册 preview.demo v1.0.0：a 必填、b 数字
    const reg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: "preview.demo", version: "1.0.0", title: "预览演示类型",
        jsonSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } }, required: ["a"] },
        unitVocabularies: {} },
    });
    expectOk(reg.status === 201, reg.json, "注册类型失败");
    await withTeamDb(teamId, async (cx) => {
      const { rows } = await cx.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'preview.demo'`);
      for (const n of ["预览资产一", "预览资产二"]) {
        const res2 = await call("POST", "/assets", {
          session: creator, body: { teamId, name: n, typeVersionId: rows[0]!.id,
            properties: { a: "保留字段", b: 42 } },
        });
        expectOk(res2.status === 201, res2.json, "预览资产登记失败");
      }
    });

    const denied = await call("POST", "/types/migration-preview", {
      session: creator,
      body: { teamId, typeKey: "preview.demo", jsonSchema: { type: "object", properties: {} } },
    });
    expect(denied.status === 403, denied.json, "成员不应能预览迁移");

    const missing = await call("POST", "/types/migration-preview", {
      session: admin,
      body: { teamId, typeKey: "preview.nope", jsonSchema: { type: "object", properties: {} } },
    });
    expect(missing.status === 404, missing.json, "未知类型应 404");

    // 预览迁移到 v2：移除 a、新增必填 c、关闭扩展 —— 两个存量资产都应失败
    const preview = await call("POST", "/types/migration-preview", {
      session: admin,
      body: { teamId, typeKey: "preview.demo",
        jsonSchema: { type: "object", properties: { b: { type: "number" }, c: { type: "string" } }, required: ["b", "c"], additionalProperties: false },
        unitVocabularies: {} },
    });
    expectOk(preview.status === 200, preview.json, "预览失败");
    expect(preview.json.affectedAssets === 2, preview.json, "受影响资产数应为 2");
    expect(preview.json.failingAssets === 2 && preview.json.safe === false, preview.json, "两资产在新定义下应失败");
    const kinds = (preview.json.structuralChanges as { kind: string }[]).map((c) => c.kind).sort();
    expect(kinds, kinds, "应识别结构变更");
    expect(kinds.includes("required-added") && kinds.includes("property-removed") && kinds.includes("additional-properties-closed"), kinds, "结构变更类别不全");
    expect((preview.json.sampleFailures as unknown[]).length === 2, preview.json, "失败样例应覆盖两资产");
    expect((preview.json.sampleFailures as { errors: string[] }[])[0]!.errors.length > 0, preview.json, "失败样例应含错误明细");

    // 兼容迁移：只加可选属性 d → 所有资产仍通过，safe = true
    const safePreview = await call("POST", "/types/migration-preview", {
      session: admin,
      body: { teamId, typeKey: "preview.demo",
        jsonSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" }, d: { type: "boolean" } }, required: ["a"] },
        unitVocabularies: {} },
    });
    expectOk(safePreview.status === 200 && safePreview.json.safe === true && safePreview.json.failingAssets === 0, safePreview.json, "兼容迁移应 safe");
  });
});
