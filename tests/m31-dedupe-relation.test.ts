// M31 实测走查修复测试 — 关系断言防重与撤回：
// 1) 同（关系类型 + 源 + 目标）不带修订限定的存活断言唯一，重复创建 409 DUPLICATE_ASSERTION
//    （confirmed/proposed 一视同仁）；撤回后允许重建；带修订限定的断言语义上可多条不受约束。
// 2) 撤回端点（走查发现 schema 预留 withdrawn 但全工程无撤回路径）：管理员/提议人可撤回，
//    普通成员 403；重复撤回 409；撤回后图谱立减；relation.withdraw 审计盖章如实落库；
//    动作标签随 /activity 同源下发。全部真实集成：真实 PostgreSQL、真实 HTTP。无任何 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
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

const PORT = 4138;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M31：关系断言防重 + 撤回路径（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let teamId = "";
  let docTypeId = "";
  let relTypeId = "";
  let assetA = "";
  let assetB = "";
  const call = caller(BASE);

  async function withRls<T>(fn: (c: Client) => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } finally {
      await c.end();
    }
  }

  async function mkAsset(name: string): Promise<string> {
    const r = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name, typeVersionId: docTypeId, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M31防重验证" } },
    });
    expectOk(r.status === 201, r.json, `建资产失败：${name}`);
    return r.json.assetId;
  }

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m31-${runId}@t.dev`, password: "password-123", displayName: "M31管理员", teamName: `M31团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    // 普通成员：先注册（自带团队）再被邀请进本团队
    const mreg = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m31member-${runId}@t.dev`, password: "password-123", displayName: "M31成员", teamName: `M31成员团队-${runId}` }),
    });
    expect(mreg.status === 201, "成员注册失败").toBe(true);
    member = sessionOf(mreg);
    const join = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m31member-${runId}@t.dev`, role: "member" } });
    expectOk(join.status === 201, join.json, "加成员失败");
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const doc = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document");
    expectOk(!!doc, types.json, "默认 document 类型应存在");
    docTypeId = doc!.id;
    assetA = await mkAsset(`M31文档甲-${runId}`);
    assetB = await mkAsset(`M31文档乙-${runId}`);
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: {
        teamId, typeKey: "m31depends", version: "1.0.0", title: "M31 依赖",
        sourceKinds: ["asset"], targetKinds: ["asset"],
        sourceTypeKeys: ["document"], targetTypeKeys: ["document"],
        cyclic: false, isSymmetric: false, requiresRevision: false,
      },
    });
    expectOk(rt.status === 201, rt.json, "注册关系类型失败");
    relTypeId = rt.json.relationTypeVersionId;
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("防重：同（类型+源+目标）存活断言唯一，409 如实拒；修订限定不受约束；撤回后可重建", async () => {
    const mk = (extra: Record<string, unknown> = {}) => call("POST", "/relations", {
      session: admin,
      body: { teamId, relationTypeVersionId: relTypeId, sourceAssetId: assetA, targetAssetId: assetB, confirm: true, ...extra },
    });
    const first = await mk();
    expectOk(first.status === 201, first.json, "首次建断言应成功");
    const dup1 = await mk();
    expect(dup1.status === 409, `重复 confirmed 应 409，实际 ${dup1.status}`).toBe(true);
    expect(dup1.json?.error?.code === "DUPLICATE_ASSERTION", `应报 DUPLICATE_ASSERTION：${JSON.stringify(dup1.json)}`).toBe(true);
    const dup2 = await mk({ confirm: false });
    expect(dup2.status === 409 && dup2.json?.error?.code === "DUPLICATE_ASSERTION", "重复 proposed 同样拒绝").toBe(true);

    // 图谱视角：仍恰 1 条存活边（outgoing/incoming 在团队级查询会各含同一条边，按源端计）
    const graph = await call("GET", `/relations?teamId=${teamId}`, { session: admin });
    expect(graph.json.outgoing.length === 1, `防重后应恰 1 条边，实际 ${graph.json.outgoing.length}`).toBe(true);

    // 带修订限定的断言表达"对特定修订的事实"，同端点可多条
    const revB = await withRls(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT id FROM asset_revisions WHERE asset_id = $1 ORDER BY seq LIMIT 1`, [assetB]);
      return rows[0]!.id;
    });
    const revQualified = await mk({ targetRevisionId: revB });
    expectOk(revQualified.status === 201, revQualified.json, "带修订限定的断言应允许创建");
    const graph2 = await call("GET", `/relations?teamId=${teamId}`, { session: admin });
    expect(graph2.json.outgoing.length === 2, `修订限定断言不受唯一约束，应 2 条，实际 ${graph2.json.outgoing.length}`).toBe(true);

    // 撤回唯一的那条普通断言后，同端点可重建（withdrawn 不占用去重键）
    const plainId = (graph2.json.outgoing as { id: string; target_revision_id: string | null }[]).find((e) => e.target_revision_id === null)!.id;
    const wd = await call("POST", `/relations/${plainId}/withdraw`, {
      session: admin, body: { teamId, reason: "M31 测试：撤回以验证可重建" },
    });
    expectOk(wd.status === 200 && wd.json.status === "withdrawn", wd.json, "撤回应成功");
    const rebuilt = await mk();
    expectOk(rebuilt.status === 201, rebuilt.json, "撤回后同端点应可重建");
  });

  it("撤回权限与如实盖章：成员非提议人 403、重复撤回 409、审计 relation.withdraw 落库、动作标签同源下发", async () => {
    const edge = await call("GET", `/relations?teamId=${teamId}&assetId=${assetA}`, { session: admin });
    const plain = (edge.json.outgoing as { id: string; target_revision_id: string | null }[]).find((e) => e.target_revision_id === null)!;
    // 提议人是 admin；普通成员既非管理员也非提议人 → 403
    const denied = await call("POST", `/relations/${plain.id}/withdraw`, {
      session: member, body: { teamId, reason: "M31 成员尝试撤回他人断言" },
    });
    expect(denied.status === 403, `成员撤回他人断言应 403，实际 ${denied.status}`).toBe(true);
    // 管理员撤回 → 200 + 审计盖章
    const wd = await call("POST", `/relations/${plain.id}/withdraw`, {
      session: admin, body: { teamId, reason: "M31 测试：端点真实性验证" },
    });
    expectOk(wd.status === 200, wd.json, "管理员撤回应成功");
    const again = await call("POST", `/relations/${plain.id}/withdraw`, {
      session: admin, body: { teamId, reason: "M31 测试：重复撤回" },
    });
    expect(again.status === 409 && again.json?.error?.code === "ALREADY_WITHDRAWN", "重复撤回应 409 ALREADY_WITHDRAWN").toBe(true);
    // 审计盖章：action=relation.withdraw，object_id 指向断言，detail 带原因与端点可读信息
    const stamp = await withRls(async (c) => {
      const { rows } = await c.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE action = 'relation.withdraw' AND object_id = $1
          ORDER BY created_at DESC LIMIT 1`, [plain.id]);
      return rows[0] ?? null;
    });
    expectOk(!!stamp, plain.id, "relation.withdraw 审计应落库");
    expect(stamp!.detail.reason === "M31 测试：端点真实性验证", `盖章应带原因：${JSON.stringify(stamp!.detail)}`).toBe(true);
    expect(stamp!.detail.relationType === "m31depends", "盖章应带关系类型").toBe(true);
    // 动作标签随 /activity 同源下发（下拉可过滤）
    const act = await call("GET", `/activity?teamId=${teamId}&limit=5`, { session: admin });
    const actions = act.json.actions as { value: string; label: string }[];
    const lw = actions.find((a) => a.value === "relation.withdraw");
    expectOk(!!lw && lw.label === "撤回关系断言", actions, "relation.withdraw 标签应随 /activity 下发");
  });
});
