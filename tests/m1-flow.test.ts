// M1 集成测试 — 真实 PostgreSQL（docker）+ 真实 HTTP 服务。
// 覆盖：注册/登录/成员添加、项目/Session、上传、七类资产、属性负例、
// 关系正反向、跨团队负例、RLS 隔离、不可变修订 DB 层拒绝。
// 无 mock：数据库、文件库、HTTP 全部真实。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const PORT = 4100;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

interface Session {
  cookie: string;
  csrf: string;
}

const runId = randomBytes(4).toString("hex");

/** 以 taw_app 建立带租户上下文的临时连接，执行断言后回滚并关闭。 */
async function withTeamDb<T>(teamId: string | null, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    if (teamId) await client.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    return await fn(client);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    await client.end();
  }
}

async function call(
  method: string,
  path: string,
  opts: { session?: Session; body?: unknown; teamId?: string } = {}
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.teamId) headers["x-team-id"] = opts.teamId;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function sessionFrom(resHeaders: Headers): Session {
  const setCookies = resHeaders.getSetCookie();
  let cookie = "";
  let csrf = "";
  for (const sc of setCookies) {
    if (sc.startsWith("taw_session=")) cookie += sc.split(";")[0] + "; ";
    if (sc.startsWith("taw_csrf=")) {
      csrf = sc.split(";")[0].split("=")[1] ?? "";
      cookie += sc.split(";")[0] + "; ";
    }
  }
  return { cookie, csrf };
}

describe("M1 身份与资产目录（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session; // 团队A管理员（用户甲）
  let member: Session; // 团队A普通成员（用户乙）
  let outsider: Session; // 其他团队用户（用户丙）
  let teamAId: string;
  let projectId: string;
  let sessionId: string;
  let modelAssetId: string;
  let docAssetId: string;
  let testAssetId: string;
  let typeVersionIds: Record<string, string> = {};
  let relationTypeIds: Record<string, string> = {};

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await app.close();
  });

  it("注册三个真实用户（甲=管理员，乙=成员，丙=外人）", async () => {
    const regA = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `alpha-${runId}@test.dev`,
        password: "password-123",
        displayName: "用户甲",
        teamName: `团队A-${runId}`,
      }),
    });
    expect(regA.status).toBe(201);
    admin = sessionFrom(regA.headers);
    teamAId = ((await regA.json()) as { teamId: string }).teamId;

    const regB = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `beta-${runId}@test.dev`,
        password: "password-123",
        displayName: "用户乙",
        teamName: `团队B-${runId}`,
      }),
    });
    expect(regB.status).toBe(201);
    member = sessionFrom(regB.headers);

    const regC = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `gamma-${runId}@test.dev`,
        password: "password-123",
        displayName: "用户丙",
        teamName: `团队C-${runId}`,
      }),
    });
    expect(regC.status).toBe(201);
    outsider = sessionFrom(regC.headers);
  });

  it("管理员把用户乙加入团队A（成员角色）", async () => {
    const res = await call("POST", `/teams/${teamAId}/members`, {
      session: admin,
      body: { email: `beta-${runId}@test.dev`, role: "member" },
    });
    expect(res.status).toBe(201);
  });

  it("未登录访问被拒", async () => {
    const res = await call("GET", "/auth/me");
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("UNAUTHORIZED");
  });

  it("CSRF 缺失时变更请求被拒", async () => {
    const res = await fetch(`${BASE}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ teamId: teamAId, name: "x", code: "x" }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("CSRF_TOKEN_INVALID");
  });

  it("创建项目与项目 Session（成员乙参与）", async () => {
    const proj = await call("POST", "/projects", {
      session: admin,
      body: { teamId: teamAId, name: "轨道传播验证", code: `orbit-${runId}` },
    });
    expect(proj.status).toBe(201);
    projectId = proj.json.projectId;

    // 成员创建 Session：先加入项目
    // （项目创建者为 lead；乙作为团队成员可访问项目级内容——本版项目对团队成员开放读取）
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: member,
      body: { teamId: teamAId, title: "整理模型与测试", visibility: "project" },
    });
    expect(sess.status).toBe(201);
    sessionId = sess.json.sessionId;
  });

  it("七类默认类型自动可用", async () => {
    const res = await call("GET", `/types?teamId=${teamAId}`, { session: member });
    expect(res.status).toBe(200);
    const types = res.json as { id: string; type_key: string }[];
    const keys = types.map((t) => t.type_key);
    for (const k of [
      "document", "software", "simulation.model", "simulation.engine",
      "test.suite", "agent.template", "simulation.scenario",
    ]) {
      expect(keys).toContain(k);
    }
    for (const t of types) typeVersionIds[t.type_key] = t.id;
    // 关系类型：租户上下文内直查（真实连接）
    await withTeamDb(teamAId, async (client) => {
      const { rows } = await client.query<{ type_key: string; id: string }>(
        `SELECT type_key, id FROM relation_type_versions WHERE team_id = $1`,
        [teamAId]
      );
      for (const row of rows) relationTypeIds[row.type_key] = row.id;
    });
    expect(Object.keys(relationTypeIds)).toContain("documentedBy");
    expect(Object.keys(relationTypeIds)).toContain("verifies");
  });

  it("上传真实文件（内存生成模型压缩包）并返回内容摘要", async () => {
    const content = Buffer.from(`fake-model-payload-${runId}-${"x".repeat(1024)}`);
    const form = new FormData();
    form.append("file", new Blob([content]), `orbit-model-${runId}.zip`);
    const res = await fetch(`${BASE}/uploads?teamId=${teamAId}`, {
      method: "POST",
      headers: { cookie: member.cookie, "x-csrf-token": member.csrf },
      body: form,
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { digest: string; size: number; uploadId: string };
    expect(json.digest).toMatch(/^[0-9a-f]{64}$/);
    (globalThis as { __m1digest?: string }).__m1digest = json.digest;
  });

  async function registerAsset(
    session: Session,
    name: string,
    typeKey: string,
    properties: object,
    extra: Record<string, unknown> = {}
  ): Promise<{ status: number; json: any }> {
    return call("POST", "/assets", {
      session,
      body: { teamId: teamAId, name, typeVersionId: typeVersionIds[typeKey], properties, ...extra },
    });
  }

  it("登记七类资产（每类一例）全部成功", async () => {
    const digest = (globalThis as { __m1digest?: string }).__m1digest!;
    const cases: [string, string, object][] = [
      ["轨道传播模型A", "simulation.model", { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v2", validStepSeconds: { min: 0.1, max: 60 } }],
      ["模型A接口说明", "document", { docRole: "interface-spec", format: "pdf", language: "zh-CN", confidentiality: "internal", scope: "prop-v2" }],
      ["回归测试集A", "test.suite", { testTarget: "prop-v2", execProtocol: "pytest-v1", fixtureVersion: "fx-3", passThreshold: 0.95 }],
      ["轨道引擎核心", "simulation.engine", { execProtocol: "grpc-sim", acceptedInterfaces: ["prop-v2"], timeAdvance: "fixed-step", platform: "linux-x64" }],
      ["遥测处理软件", "software", { language: "python", entry: "main.py", interfaceVersion: "tm-1", runtime: "python3.11", license: "MIT" }],
      ["答复整理Agent模板", "agent.template", { promptSpec: "整理上传文件", modelConstraints: "any", toolAllowlist: ["asset.search"], permissionCeiling: "draft-write" }],
      ["LEO捕获场景", "simulation.scenario", { initialConditions: { alt: 400 }, timeRange: { start: "2026-01-01", end: "2026-01-02" }, seed: 42 }],
    ];
    for (const [name, typeKey, props] of cases) {
      const res = await registerAsset(member, name, typeKey, props);
      expect(res.status, `${typeKey} 登记失败: ${JSON.stringify(res.json)}`).toBe(201);
    }
  });

  it("登记携带制品的模型资产，记录其 ID", async () => {
    const digest = (globalThis as { __m1digest?: string }).__m1digest!;
    const res = await registerAsset(member, "轨道传播模型A-带实现", "simulation.model", {
      frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s",
      interfaceVersion: "prop-v2", validStepSeconds: { min: 0.1, max: 60 },
    }, {
      artifacts: [{ digest, role: "implementation", originalName: "orbit.zip", mediaType: "application/zip", size: 1050 }],
      categoryPath: "simulation/model/orbit",
      labels: ["常用"],
    });
    expect(res.status).toBe(201);
    modelAssetId = res.json.assetId;
  });

  it("非法属性被拒绝（非法单位/缺失必填/坏枚举）", async () => {
    const badUnit = await registerAsset(member, "坏单位模型", "simulation.model", {
      frame: "ECI", timeScale: "TAI", positionUnit: "parsecs", velocityUnit: "m/s",
      interfaceVersion: "x", validStepSeconds: { min: 0.1, max: 60 },
    });
    expect(badUnit.status).toBe(422);
    expect(JSON.stringify(badUnit.json)).toContain("positionUnit");

    const missing = await registerAsset(member, "缺必填文档", "document", { docRole: "manual" });
    expect(missing.status).toBe(422);

    const badEnum = await registerAsset(member, "坏枚举引擎", "simulation.engine", {
      execProtocol: "x", acceptedInterfaces: ["x"], timeAdvance: "quantum", platform: "x",
    });
    expect(badEnum.status).toBe(422);
  });

  it("建立关系（documentedBy / verifies）并正反向一致可查", async () => {
    // 文档资产
    const doc = await registerAsset(member, "模型A接口说明r9", "document", {
      docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "prop-v2",
    });
    docAssetId = doc.json.assetId;
    const rel1 = await call("POST", "/relations", {
      session: member,
      body: {
        teamId: teamAId,
        relationTypeVersionId: relationTypeIds["documentedBy"],
        sourceAssetId: modelAssetId,
        targetAssetId: docAssetId,
        evidenceNote: "接口说明文档",
      },
    });
    expect(rel1.status).toBe(201);
    expect(rel1.json.status).toBe("confirmed");

    // 测试资产
    const test = await registerAsset(member, "回归测试集A-r2", "test.suite", {
      testTarget: "prop-v2", execProtocol: "pytest-v1", fixtureVersion: "fx-3", passThreshold: 0.95,
    });
    testAssetId = test.json.assetId;
    const rel2 = await call("POST", "/relations", {
      session: member,
      body: {
        teamId: teamAId,
        relationTypeVersionId: relationTypeIds["verifies"],
        sourceAssetId: testAssetId,
        targetAssetId: modelAssetId,
      },
    });
    expect(rel2.status).toBe(201);

    const rels = await call("GET", `/relations?teamId=${teamAId}&assetId=${modelAssetId}`, { session: member });
    expect(rels.status).toBe(200);
    const outgoing = rels.json.outgoing as { type_key: string }[];
    const incoming = rels.json.incoming as { type_key: string }[];
    expect(outgoing.some((r) => r.type_key === "documentedBy")).toBe(true);
    expect(incoming.some((r) => r.type_key === "verifies")).toBe(true);
  });

  it("跨团队关系被拒绝（A08 服务端负例）", async () => {
    // 外人丙在自己的团队建立资产
    const meC = await call("GET", "/auth/me", { session: outsider });
    const teamC = (meC.json.teams as { teamId: string }[])[0]!.teamId;
    await call("GET", `/types?teamId=${teamC}`, { session: outsider });
    let teamCDocType = "";
    await withTeamDb(teamC, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM asset_type_versions WHERE team_id = $1 AND type_key = 'document'`,
        [teamC]
      );
      teamCDocType = rows[0]!.id;
    });
    const cDoc = await call("POST", "/assets", {
      session: outsider,
      body: {
        teamId: teamC,
        name: "丙的文档",
        typeVersionId: teamCDocType,
        properties: { docRole: "manual", format: "txt", language: "zh", confidentiality: "public", scope: "x" },
      },
    });
    expect(cDoc.status).toBe(201);
    const teamCAsset = (cDoc.json as { assetId: string }).assetId;

    // 乙试图把团队A资产连到团队C资产 → 拒绝
    const res = await call("POST", "/relations", {
      session: member,
      body: {
        teamId: teamAId,
        relationTypeVersionId: relationTypeIds["documentedBy"],
        sourceAssetId: modelAssetId,
        targetAssetId: teamCAsset,
      },
    });
    expect(res.status).toBe(422);
  });

  it("外人访问团队A资产返回 404（不泄露存在性）", async () => {
    const res = await call("GET", `/assets/${modelAssetId}?teamId=${teamAId}`, { session: outsider });
    expect(res.status).toBe(404);
  });

  it("RLS：应用角色未设 team 上下文时租户行不可见；写入被 WITH CHECK 拒绝", async () => {
    await withTeamDb(null, async (client) => {
      const { rows } = await client.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM assets`);
      expect(rows[0]!.n).toBe(0); // 数据存在但 RLS 无上下文 → 不可见
      // 无 team 上下文的 INSERT 被 WITH CHECK 拒绝
      await expect(
        client.query(
          `INSERT INTO assets (team_id, id, name, current_type_version_id, created_by)
           VALUES ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'hacked',
                   '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444')`
        )
      ).rejects.toThrow(/violates row-level security/i);
    });
  });

  it("B01（DB层）：应用角色对 asset_revisions 无 UPDATE/DELETE 权限", async () => {
    // 每个 expect 独立事务：首条失败会中止当前事务，SAVEPOINT 不够，需分开
    const attempt = (sql: string) =>
      withTeamDb(teamAId, async (client) => {
        await expect(client.query(sql)).rejects.toThrow(/permission denied/i);
      });
    await attempt(`UPDATE asset_revisions SET properties = '{"hacked":true}'`);
    await attempt(`DELETE FROM asset_revisions`);
  });

  it("重复 digest 上传幂等（blobs 去重）", async () => {
    const content = Buffer.from(`dedupe-check-${runId}`);
    const form1 = new FormData();
    form1.append("file", new Blob([content]), `a-${runId}.bin`);
    const form2 = new FormData();
    form2.append("file", new Blob([content]), `b-${runId}.bin`);
    const r1 = await fetch(`${BASE}/uploads?teamId=${teamAId}`, {
      method: "POST", headers: { cookie: member.cookie, "x-csrf-token": member.csrf }, body: form1,
    });
    const r2 = await fetch(`${BASE}/uploads?teamId=${teamAId}`, {
      method: "POST", headers: { cookie: member.cookie, "x-csrf-token": member.csrf }, body: form2,
    });
    const j1 = (await r1.json()) as { digest: string };
    const j2 = (await r2.json()) as { digest: string };
    expect(j1.digest).toBe(j2.digest);
    await withTeamDb(teamAId, async (client) => {
      const { rows } = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM blobs WHERE team_id = $1 AND digest = $2`,
        [teamAId, j1.digest]
      );
      expect(rows[0]!.n).toBe(1);
    });
  });
});
