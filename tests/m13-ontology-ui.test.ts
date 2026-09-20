// M13 本体治理台测试 — 界面背后的真实端点契约：
// 关系类型列表带断言计数（治理台表格）、NL 导航新页面、治理写操作的管理员门。
// 全部真实集成。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "@taw/agent-adapter/env";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runId = randomBytes(4).toString("hex");
loadEnvFile();
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

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

function caller(base: string) {
  return async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = {};
    if (opts.session) {
      headers.cookie = opts.session.cookie;
      headers["x-csrf-token"] = opts.session.csrf;
    }
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

const PORT = 4120;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M13 本体治理台（关系类型计数 / NL 导航 / 管理员门）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let projectId = "";
  let docTypeId = "";
  const call = caller(BASE);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = async (email: string, name: string, team: string) => {
      const res = await fetch(`${BASE}/auth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
      });
      expect(res.status === 201, "注册失败").toBe(true);
      return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
    };
    const a = await reg(`m13-${runId}@t.dev`, "M13管理员", `M13团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const m = await reg(`m13member-${runId}@t.dev`, "M13成员", `M13成员团队-${runId}`);
    member = m.session;
    // 成员加入管理员团队（member 角色，非 admin）
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m13member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M13项目-${runId}`, code: `m13${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    projectId = proj.json.projectId;
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("治理写操作有管理员门：本团队成员（非 admin）登记类型 403", async () => {
    const r = await call("POST", "/types", {
      session: member,
      body: { teamId, typeKey: `m13x${runId.slice(0, 4)}`, version: "1.0.0", title: "越权类型", jsonSchema: { required: [], properties: {} } },
    });
    expect(r.status === 403, `成员非管理员应 403，实际 ${r.status}`).toBe(true);
    // 管理员同一请求成功（对照）
  });

  it("管理员登记类型与关系类型：成功创建且质量门/层次校验生效", async () => {
    // 带父类型的子类型：父为 document
    const docType = (await call("GET", `/types?teamId=${teamId}`, { session: admin })).json
      .find((t: { type_key: string }) => t.type_key === "document");
    const child = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: "m13spec", version: "1.0.0", title: "M13规格",
        jsonSchema: { required: ["docRole"], properties: { docRole: { type: "string" }, specLevel: { type: "string" } } },
        parentTypeVersionId: docType.id,
      },
    });
    expectOk(child.status === 201, child.json, "登记子类型应成功");

    // 改写父类型属性的类型（string → number）→ 收窄门拒绝（property-type-changed）
    const typeChanged = await call("POST", "/types", {
      session: admin,
      body: {
        teamId, typeKey: "m13spec", version: "1.1.0", title: "M13规格改型",
        jsonSchema: { required: ["docRole"], properties: { docRole: { type: "number" }, specLevel: { type: "string" } } },
        parentTypeVersionId: docType.id,
      },
    });
    expect(typeChanged.status === 422 || typeChanged.status === 400, `改写父属性类型应被质量门拒绝，实际 ${typeChanged.status}`).toBe(true);
  });

  it("关系类型列表带 assertion_count：断言后计数如实增长", async () => {
    const mkAsset = async (name: string) => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: {
          teamId, name, typeVersionId: docTypeId,
          properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M13" },
        },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    const a = await mkAsset(`M13甲-${runId}`);
    const b = await mkAsset(`M13乙-${runId}`);
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: {
        teamId, typeKey: "m13link", version: "1.0.0", title: "M13关联",
        sourceTypeKeys: ["document"], targetTypeKeys: ["document"], requiresRevision: false,
      },
    });
    expectOk(rt.status === 201, rt.json, "登记关系类型失败");
    const rtId = rt.json.relationTypeVersionId;

    const before = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rowBefore = (before.json as { id: string; assertion_count: number }[]).find((r) => r.id === rtId);
    expect(!!rowBefore, "关系类型应在列表中").toBe(true);
    expect(rowBefore!.assertion_count === 0, `断言前计数应为 0：${rowBefore!.assertion_count}`).toBe(true);

    const rel = await call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: rtId, sourceAssetId: a, targetAssetId: b, confirm: true },
    });
    expectOk(rel.status === 201, rel.json, "断言关系失败");

    const after = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const rowAfter = (after.json as { id: string; assertion_count: number }[]).find((r) => r.id === rtId);
    expect(rowAfter!.assertion_count === 1, `断言后计数应为 1：${rowAfter!.assertion_count}`).toBe(true);
  });

  it("NL 导航扩展：打开本体 → navigate ontology（规则解析）", async () => {
    for (const [text, page] of [["打开本体", "ontology"], ["跳到本体治理", "ontology"], ["打开图谱", "graph"]] as const) {
      const r = await call("POST", "/nl/parse", { session: admin, body: { teamId, text } });
      expectOk(r.status === 200, r.json, `解析失败：${text}`);
      expect(r.json.intent === "navigate", `${text} 应为 navigate`).toBe(true);
      expect(r.json.params.page === page, `${text} → ${r.json.params.page}`).toBe(true);
      expect(r.json.parser.kind === "rules", `${text} 应走规则解析`).toBe(true);
    }
  });
});
