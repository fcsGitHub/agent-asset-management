// M28 队列导出件回导测试 — 导出 → 回导闭环：判定复用 planImportDedup（M21/M23/M28
// 同源口径：确认/待审跳过、已忽略放行、批内重复跳过）；资产逐条按 assetName 解析
// （跨团队同名资产可复用评审成果），无法定位的条目如实标记不中断整批；回导一律
// pending，不继承原状态。全部真实集成，无 mock。
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

const PORT = 4135;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M28 导出件回导（幂等闭环 + 跨团队复用）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamB: Session;
  let teamId = "";
  let teamIdB = "";
  let assetA = "";
  let exportItems: Array<Record<string, unknown>> = [];
  const call = caller(BASE);
  const srcName = `M28模型说明书-${runId}`;
  const tgtName = `M28接口文档-${runId}`;

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
    const a = await reg(`m28-${runId}@t.dev`, "M28队长", `M28团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const b = await reg(`m28b-${runId}@t.dev`, "M28乙队长", `M28乙团队-${runId}`);
    teamB = b.session; teamIdB = b.teamId;

    const setupTeam = async (sess: Session, tid: string) => {
      const proj = await call("POST", "/projects", { session: sess, body: { teamId: tid, name: `M28项目-${tid.slice(0, 6)}`, code: `m28${tid.slice(0, 6)}` } });
      expectOk(proj.status === 201, proj.json, "建项目失败");
      const types = await call("GET", `/types?teamId=${tid}`, { session: sess });
      const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
      const mk = async (name: string): Promise<string> => {
        const r = await call("POST", "/assets", {
          session: sess,
          body: { teamId: tid, name, typeVersionId: docTypeId, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M28" } },
        });
        expectOk(r.status === 201, r.json, `建资产失败：${name}`);
        return r.json.assetId;
      };
      await mk(srcName);
      await mk(tgtName);
    };
    await setupTeam(admin, teamId);
    await setupTeam(teamB, teamIdB);

    // 团队甲：入队 3 条 → 确认 1、忽略 1、待审 1
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const list = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=all&limit=10`, { session: admin });
    assetA = (list.json as { id: string; name: string }[]).find((x) => x.name === srcName)!.id;
    void docTypeId;
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [
          { relationType: "m28rel", sourceText: srcName, targetText: tgtName, confidence: 0.9, extractorVersion: "m28-test" },
          { relationType: "documentedBy", sourceText: srcName, targetText: tgtName, confidence: 0.7, extractorVersion: "m28-test" },
          { relationType: "related_to", sourceText: tgtName, targetText: srcName, confidence: 0.5, extractorVersion: "m28-test" },
        ],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    const [c1, c2] = imp.json.candidateIds as string[];
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m28rel", version: "1.0.0", title: "M28关系", sourceTypeKeys: ["document"], targetTypeKeys: ["document"], requiresRevision: false },
    });
    expectOk(rt.status === 201, rt.json, "注册关系类型失败");
    const l2 = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=all&limit=10`, { session: admin });
    const assetB = (l2.json as { id: string; name: string }[]).find((x) => x.name === tgtName)!.id;
    const conf = await call("POST", `/semantic/candidates/${c1}/confirm`, { session: admin, body: { teamId, sourceAssetId: assetA, targetAssetId: assetB } });
    expectOk(conf.status === 200, conf.json, "确认失败");
    const dis = await call("POST", `/semantic/candidates/${c2}/dismiss`, { session: admin, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略失败");

    // 导出（团队甲全量）→ 回导输入
    const exp = await call("GET", `/semantic/candidates/export?teamId=${teamId}&status=all&format=json`, { session: admin });
    expectOk(exp.status === 200, exp.json, "导出失败");
    exportItems = exp.json.items;
    expect(exportItems.length === 3, `导出应 3 条：${exportItems.length}`).toBe(true);
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("同团队回导：确认/待审跳过、已忽略放行重新待审，二次回导完全幂等", async () => {
    const r1 = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, items: exportItems } });
    expectOk(r1.status === 201, r1.json, "回导失败");
    expect(r1.json.imported === 1, `应只放行已忽略的 1 条：${JSON.stringify(r1.json)}`).toBe(true);
    expect(r1.json.skipped === 2 && r1.json.duplicateIndexes.length === 2, `确认/待审应跳过：${JSON.stringify(r1.json)}`).toBe(true);
    expect(r1.json.unresolvedIndexes.length === 0, "同团队应全部解析资产").toBe(true);

    // 放行的条目以 pending 重新入队（不继承 dismissed），队列待审可见
    const pend = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    const pendTexts = (pend.json as { source_text: string; relation_type: string }[]).map((c) => `${c.relation_type}:${c.source_text}`);
    expect(pendTexts.includes(`related_to:${tgtName}`), `被忽略候选应重新待审：${JSON.stringify(pendTexts)}`).toBe(true);

    // 二次回导：三条全部是队列重复 → 完全幂等
    const r2 = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, items: exportItems } });
    expectOk(r2.status === 201, r2.json, "二次回导失败");
    expect(r2.json.imported === 0 && r2.json.skipped === 3, `二次回导应全跳过：${JSON.stringify(r2.json)}`).toBe(true);

    // 批内重复：同一文件里两条同键 → 前者入队后者 batch 跳过（文件来自外部场景）
    const dupFile = [
      { relationType: "extra_rel", sourceText: "甲", targetText: "乙", assetName: srcName },
      { relationType: "extra_rel", sourceText: "甲", targetText: "乙", assetName: srcName },
    ];
    const r3 = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, items: dupFile } });
    expect(r3.json.imported === 1 && r3.json.skipped === 1, `批内重复应 1 入 1 跳：${JSON.stringify(r3.json)}`).toBe(true);
  });

  it("跨团队回导：同名资产解析成功则全部入队；缺名且无回退资产则如实标记不中断", async () => {
    // 乙团队有同名资产：3 条（含甲团队已确认的）在乙团队都不是重复 → 全部入队
    const r1 = await call("POST", "/semantic/candidates/reimport", { session: teamB, body: { teamId: teamIdB, items: exportItems } });
    expectOk(r1.status === 201, r1.json, "跨团队回导失败");
    expect(r1.json.imported === 3 && r1.json.skipped === 0 && r1.json.unresolvedIndexes.length === 0,
      `同名资产应全部入队：${JSON.stringify(r1.json)}`).toBe(true);
    const pend = await call("GET", `/semantic/candidates?teamId=${teamIdB}&status=pending`, { session: teamB });
    expect((pend.json as { asset_name: string }[]).every((c) => c.asset_name === srcName || c.asset_name === tgtName),
      `乙团队候选应锚定到自己的同名资产：${JSON.stringify(pend.json)}`).toBe(true);

    // 缺 assetName 且无回退 assetId 的条目：unresolved 如实标记，其余条目不受影响
    const mixed = [
      { relationType: "orphan_rel", sourceText: "无主甲", targetText: "无主乙" },
      { relationType: "ok_rel", sourceText: "有主甲", targetText: "有主乙", assetName: srcName },
    ];
    const r2 = await call("POST", "/semantic/candidates/reimport", { session: teamB, body: { teamId: teamIdB, items: mixed } });
    expectOk(r2.status === 201, r2.json, "混合回导失败");
    expect(r2.json.unresolvedIndexes.length === 1 && r2.json.unresolvedIndexes[0] === 0, `缺名条目应如实标记：${JSON.stringify(r2.json)}`).toBe(true);
    expect(r2.json.imported === 1, `有名条目应正常入队：${JSON.stringify(r2.json)}`).toBe(true);

    // 校验：空 items 422；非成员 404
    const empty = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, items: [] } });
    expect(empty.status === 422, `空 items 应 422：${empty.status}`).toBe(true);
    const foreign = await call("POST", "/semantic/candidates/reimport", { session: teamB, body: { teamId, items: exportItems } });
    expect(foreign.status === 404, `非成员应 404：${foreign.status}`).toBe(true);
  });
});
