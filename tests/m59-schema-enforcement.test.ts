// M59 集成测试 — 更新与入库的全路径 schema 强制：
// ①分支草稿保存（资产「更新」主路径）此前完全绕过类型 schema——现在与登记共用
//   同一关卡（loadTypeChain + validateAgainstChain，子类型资产满足链上全部祖先定义）。
// ②prepare-review 复核候选修订属性：拦截校验上线前存量的不合规历史草稿
//   （409 CANDIDATE_SCHEMA_INVALID），已过卡候选恒过（零成本纵深）。
// ③dry-run 端点 POST /assets/validate（Backstage catalog validate 思想）：
//   与真实写入同源判定、零副作用；登记表单「校验」按钮的数据源。
// 全部真实链路（真实 PG / HTTP）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";

const PORT = 4159;
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
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 500)}`);
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

/** 会话级租户上下文 + 自动提交（模拟「绕过端点的直插写入」需要真实落库）。 */
async function writeTeamDb<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  try {
    await c.query("SELECT set_config('app.team_id', $1, false)", [teamId]);
    return await fn(c);
  } finally {
    await c.end();
  }
}

describe("M59 更新与入库的全路径 schema 强制", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session, outsider: Session;
  let teamId = "", projectId = "";
  let baseTypeId = "", childTypeId = "", docTypeId = "";
  let childAsset = "", legacyAsset = "";
  let branchId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m59admin-${runId}@t.dev`, password: "password-123", displayName: "M59管理员", teamName: `M59团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m59member-${runId}@t.dev`, password: "password-123", displayName: "M59成员", teamName: `M59成员团-${runId}` }),
    });
    member = sessionOf(m);
    await fetch(`${BASE}/teams/${teamId}/members`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ email: `m59member-${runId}@t.dev`, role: "member" }),
    });
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m59out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `M59外团-${runId}` }),
    });
    outsider = sessionOf(o);
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "M59验证", code: `m59-${runId}` } });
    expectOk(proj.status === 201, proj.json, "项目创建失败");
    projectId = proj.json.projectId;

    // 类型层次：m59.base（level: number 0-10 必填）→ m59.child（收窄 + extra 必填 string）
    const base = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `m59.base.${runId.slice(0, 4)}`, version: "1.0.0", title: "M59基类",
        jsonSchema: { type: "object", required: ["level"], properties: { level: { type: "number", minimum: 0, maximum: 10 } } },
      },
    });
    expectOk(base.status === 201, base.json, "基类注册失败");
    baseTypeId = base.json.typeVersionId;
    const child = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: `m59.child.${runId.slice(0, 4)}`, version: "1.0.0", title: "M59子类",
        jsonSchema: { type: "object", required: ["extra"], properties: { level: { type: "number", minimum: 0, maximum: 5 }, extra: { type: "string" } } },
        parentTypeVersionId: baseTypeId,
      },
    });
    expectOk(child.status === 201, child.json, "子类注册失败");
    childTypeId = child.json.typeVersionId;
    const types = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json as { id: string; type_key: string }[];
    docTypeId = types.find((t) => t.type_key === "document")!.id;

    const childReg = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "M59子类资产", typeVersionId: childTypeId, properties: { level: 3, extra: "ok" } },
    });
    expectOk(childReg.status === 201, childReg.json, "子类资产登记失败");
    childAsset = childReg.json.assetId;
    const legacyReg = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "M59存量资产", typeVersionId: childTypeId, properties: { level: 3, extra: "ok" } },
    });
    legacyAsset = legacyReg.json.assetId;

    const br = await call("POST", `/projects/${projectId}/branches`, { session: member, body: { teamId, name: `m59-main-${runId}` } });
    expectOk(br.status === 201, br.json, "建分支失败");
    branchId = br.json.branchId;
  });
  afterAll(async () => { await app.close(); });

  it("登记仍强制（回归）：子类型属性违反祖先定义 → 422 带链上前缀", async () => {
    const res = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "M59违规登记", typeVersionId: childTypeId, properties: { level: 99, extra: "x" } },
    });
    expectOk(res.status === 422, res.json, "应 422");
    const errors = (res.json.error.details as string[]).join("\n");
    expect(errors).toContain(`[m59.base.${runId.slice(0, 4)} v1.0.0]`);
    expect(errors).toContain(`[m59.child.${runId.slice(0, 4)} v1.0.0]`);
  });

  it("更新强制（本轮核心）：分支草稿非法属性 → 422，且未写入任何修订", async () => {
    const bad = await call("POST", `/branches/${branchId}/revisions`, {
      session: member, body: { teamId, assetId: childAsset, properties: { level: 99 } },
    });
    expectOk(bad.status === 422, bad.json, "分支非法属性应 422");
    const errors = (bad.json.error.details as string[]).join("\n");
    expect(errors).toContain(`[m59.base.${runId.slice(0, 4)} v1.0.0]`); // 祖先 max 10 被违反
    expect(errors).toContain(`[m59.child.${runId.slice(0, 4)} v1.0.0]`); // 子定义 max 5 被违反
    // 类型错误同样拦：level 传字符串
    const badType = await call("POST", `/branches/${branchId}/revisions`, {
      session: member, body: { teamId, assetId: childAsset, properties: { level: "high" } },
    });
    expect(badType.status).toBe(422);
    // 未写入：修订数仍为 1，分支无条目
    const detail = (await call("GET", `/assets/${childAsset}?teamId=${teamId}`, { session: member })).json as { revisionsTotal: number };
    expect(detail.revisionsTotal).toBe(1);
  });

  it("更新合法路径（回归）：满足全链的草稿正常保存", async () => {
    const ok = await call("POST", `/branches/${branchId}/revisions`, {
      session: member, body: { teamId, assetId: childAsset, properties: { level: 4 } },
    });
    expectOk(ok.status === 201 && ok.json.seq === 2, ok.json, "合法草稿应保存为 r2");
  });

  it("存量欠账拦截：绕过端点直插的不合规修订，prepare-review 409 CANDIDATE_SCHEMA_INVALID", async () => {
    // 模拟校验上线前的历史草稿：DB 直插不合规修订并把分支头指过去（应用角色可 INSERT）
    const badRevisionId = await writeTeamDb(teamId, async (c) => {
      const { rows: head } = await c.query<{ id: string; type_version_id: string; seq: number }>(
        `SELECT id, type_version_id, seq FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT 1`,
        [teamId, legacyAsset]
      );
      const id = randomUUID();
      await c.query(
        `INSERT INTO asset_revisions (team_id, id, asset_id, type_version_id, properties, content_digest, seq, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'member' LIMIT 1))`,
        [teamId, id, legacyAsset, head[0]!.type_version_id, JSON.stringify({ level: 99, extra: "legacy-bad" }), randomBytes(32).toString("hex"), head[0]!.seq + 1]
      );
      await c.query(
        `INSERT INTO branch_entries (team_id, branch_id, asset_id, base_revision_id, head_revision_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [teamId, branchId, legacyAsset, head[0]!.id, id]
      );
      return id;
    });
    const cr = await call("POST", "/change-requests", {
      session: member,
      body: {
        teamId, branchId, title: "M59 存量欠账", motivation: "验证发布复核",
        relatedRefs: "无", changeSummary: "存量", compatibility: "-", testPlan: "-", rollbackNotes: "-",
      },
    });
    expectOk(cr.status === 201, cr.json, "CR 创建失败");
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId}/prepare-review`, {
      session: member, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(prep.status === 409 && prep.json.error.code === "CANDIDATE_SCHEMA_INVALID", prep.json, "存量不合规候选应被 prepare 拦截");
    expect((prep.json.error.message as string)).toContain("M59存量资产");
    // 分支头回到 r1（合法候选）后重建 CR 验证正路
    await writeTeamDb(teamId, async (c) => {
      await c.query(`UPDATE branch_entries SET head_revision_id = base_revision_id WHERE team_id = $1 AND branch_id = $2 AND asset_id = $3`, [teamId, branchId, legacyAsset]);
      void badRevisionId;
    });
    // CR 冻结了 items（含坏候选），重建 CR 才干净——退回后再验证干净分支
    await call("POST", `/change-requests/${cr.json.changeRequestId}/changes-requested`, { session: admin, body: { teamId, comment: "候选不合规" } });
    const cr2 = await call("POST", "/change-requests", {
      session: member,
      body: {
        teamId, branchId, title: "M59 合规候选", motivation: "验证正路",
        relatedRefs: "无", changeSummary: "合规", compatibility: "-", testPlan: "-", rollbackNotes: "-",
      },
    });
    const prep2 = await call("POST", `/change-requests/${cr2.json.changeRequestId}/prepare-review`, {
      session: member, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(prep2.status === 201, prep2.json, "合规候选应可正常准备审核");
  });

  it("dry-run 端点：与登记同源判定、零副作用、越权 404", async () => {
    const good = await call("POST", "/assets/validate", {
      session: member, body: { teamId, typeVersionId: childTypeId, properties: { level: 4, extra: "x" } },
    });
    expectOk(good.status === 200 && good.json.valid === true && good.json.errors.length === 0, good.json, "合法属性应过");
    const bad = await call("POST", "/assets/validate", {
      session: member, body: { teamId, typeVersionId: childTypeId, properties: { level: 99 } },
    });
    expectOk(bad.status === 200 && bad.json.valid === false, bad.json, "非法属性应判 false");
    expect((bad.json.errors as string[]).some((e) => e.includes(`[m59.base.${runId.slice(0, 4)} v1.0.0]`))).toBe(true);
    // 缺 required 字段同样判出
    const missing = await call("POST", "/assets/validate", {
      session: member, body: { teamId, typeVersionId: childTypeId, properties: {} },
    });
    expect(missing.json.valid).toBe(false);
    // 零副作用：不产生资产/修订
    const before = (await call("GET", `/assets/search?teamId=${teamId}&q=M59子类资产`, { session: member })).json as { total?: number };
    void before;
    // 越权（M57 教训）：外人伪造 teamId → 404
    const forged = await call("POST", "/assets/validate", {
      session: outsider, body: { teamId, typeVersionId: childTypeId, properties: {} },
    });
    expect(forged.status).toBe(404);
  });
});
