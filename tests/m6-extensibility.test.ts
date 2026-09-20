// M6 可扩展性验证（扩展包）：不改一行代码，仅通过运行时类型定义注册全新资产类型，
// 并让它走通 登记校验 → 单位词表 → 草稿分支 → CR → 预览通道发布 → 通道视图 全链路。
// 这是"分类是目录视图而非独立数据库"（七类共用同一套身份/修订/审批机制）的直接证明。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const PORT = 4109;
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
  expect(res.status === 201, "注册失败").toBe(true);
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

describe("M6 扩展包：运行时注册全新类型并跑通全链路（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session;
  let teamId = "", projectId = "";
  let customTypeId = "", docTypeId = "";
  let sensorAssetId = "", sensorRevHead = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m6x-${runId}@t.dev`, "扩展管理员", `扩展团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await register(`m6xm-${runId}@t.dev`, "扩展成员", `扩展旁队-${runId}`);
    member = m.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m6xm-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "扩展验证项目", code: `ext-${runId}` } });
    projectId = proj.json.projectId;
    await call("GET", `/types?teamId=${teamId}`, { session: admin });
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string; type_key: string }>(
        `SELECT id, type_key FROM asset_type_versions WHERE team_id = $1 AND (type_key = 'document' OR type_key = 'custom.sensor-grid')`,
        [teamId]
      );
      docTypeId = rows.find((r) => r.type_key === "document")!.id;
    });
  });

  afterAll(async () => { await app.close(); });

  it("运行时注册全新类型 custom.sensor-grid（含受控单位词表），零代码改动", async () => {
    const res = await call("POST", "/types", {
      session: admin,
      body: {
        teamId,
        typeKey: "custom.sensor-grid",
        version: "1.0.0",
        title: "传感网格（运行时扩展）",
        jsonSchema: {
          type: "object",
          required: ["gridSize", "samplingHz"],
          properties: {
            gridSize: { type: "string" },
            samplingHz: { type: "number", minimum: 0 },
            calibrationDoc: { type: "string" },
          },
        },
        unitVocabularies: { samplingHz: ["Hz", "kHz"] },
      },
    });
    expectOk(res.status === 201, res.json, "注册新类型失败");
    customTypeId = res.json.typeVersionId;
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ json_schema: object; unit_vocabularies: Record<string, string[]> }>(
        `SELECT json_schema, unit_vocabularies FROM asset_type_versions WHERE team_id = $1 AND id = $2`,
        [teamId, customTypeId]
      );
      expect(rows[0]!.unit_vocabularies["samplingHz"], "词表应入库").toEqual(["Hz", "kHz"]);
    });
  });

  it("新类型立即生效：合法属性+词表单位通过；非法单位与缺失必填被拒（A03 扩展语义）", async () => {
    const ok = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "厂房温度网格", typeVersionId: customTypeId,
        properties: { gridSize: "8x8", samplingHz: 10, samplingHzUnit: "Hz" } },
    });
    expectOk(ok.status === 201, ok.json, "新类型资产登记失败");
    sensorAssetId = ok.json.assetId;

    const badUnit = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "非法单位", typeVersionId: customTypeId,
        properties: { gridSize: "8x8", samplingHz: 10, samplingHzUnit: "GHz" } },
    });
    expect(badUnit.status === 422, "词表外单位应拒绝").toBe(true);
    expect(String(JSON.stringify(badUnit.json)).includes("Hz"), "错误应提示词表").toBe(true);

    const badRequired = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "缺必填", typeVersionId: customTypeId, properties: { gridSize: "8x8" } },
    });
    expect(badRequired.status === 422, "缺失必填应拒绝").toBe(true);
  });

  it("跨类型关系：自定义类型资产 可与 内置 document 类型资产 建立依赖关系", async () => {
    const doc = await call("POST", "/assets", {
      session: member,
      body: { teamId, name: "传感器标定说明", typeVersionId: docTypeId,
        properties: { docRole: "manual", format: "markdown", language: "zh-CN", confidentiality: "internal", scope: "标定" } },
    });
    expectOk(doc.status === 201, doc.json, "内置类型资产登记失败");
    let relTypeVersionId = "";
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM relation_type_versions WHERE team_id = $1 AND type_key = 'dependsOn' LIMIT 1`, [teamId]);
      relTypeVersionId = rows[0]!.id;
    });
    const rel = await call("POST", "/relations", {
      session: member,
      body: { teamId, relationTypeVersionId: relTypeVersionId,
        sourceAssetId: sensorAssetId, targetAssetId: doc.json.assetId,
        evidenceNote: "网格依赖标定说明" },
    });
    expectOk(rel.status === 201, rel.json, "跨类型关系创建失败");
  });

  it("新类型资产走通 草稿 → CR → 预览通道发布 → 通道视图 全链路", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: member, body: { teamId, name: `ext-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const save = await call("POST", `/branches/${br.json.branchId as string}/revisions`, {
      session: member, body: { teamId, assetId: sensorAssetId, properties: { samplingHz: 20 } },
    });
    expectOk(save.status === 201, save.json, "草稿保存失败");
    sensorRevHead = save.json.revisionId;

    const cr = await call("POST", "/change-requests", {
      session: member,
      body: { teamId, branchId: br.json.branchId, title: "提升采样率", motivation: "扩展类型走发布链",
        changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
    });
    expectOk(cr.status === 201, cr.json, "CR 失败");
    const prep = await call("POST", `/change-requests/${cr.json.changeRequestId as string}/prepare-review`, {
      session: admin, body: { teamId, channel: "preview", audience: "team" },
    });
    expectOk(prep.status === 201, prep.json, "prepare 失败");
    const pub = await call("POST", `/change-requests/${cr.json.changeRequestId as string}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: prep.json.reviewDigest, note: "扩展类型发布" },
    });
    expectOk(pub.status === 200, pub.json, "发布失败");

    const channel = await call("GET", `/projects/${projectId}/channel?teamId=${teamId}&channel=preview`, { session: admin });
    const head = (channel.json as { asset_id: string; revision_id: string }[]).find((h) => h.asset_id === sensorAssetId);
    expectOk(!!head && head!.revision_id === sensorRevHead, channel.json, "通道头应指向新类型资产候选");
  });
});
