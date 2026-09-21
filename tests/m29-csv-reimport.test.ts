// M29 CSV 回导 + 解析健壮性测试 — 导出件 CSV 与 JSON 回导同管线（planImportDedup
// 同源判定）；宽容解析覆盖 BOM、#截断说明行、双引号转义往返；缺列/坏字段如实 422。
// 全部真实集成，无 mock。
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

const PORT = 4136;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

describe("M29 导出件 CSV 回导", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let assetA = "";
  let csvAll = "";
  let csvBom = "";
  const call = caller(BASE);
  const srcName = `M29模型说明书-${runId}`;
  const tgtName = `M29接口文档-${runId}`;
  const quotedEvidence = '证据含"引号"，及，逗号';

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m29-${runId}@t.dev`, password: "password-123", displayName: "M29队长", teamName: `M29团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M29项目-${runId}`, code: `m29${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docTypeId = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!.id;
    const mk = async (name: string): Promise<string> => {
      const r = await call("POST", "/assets", {
        session: admin,
        body: { teamId, name, typeVersionId: docTypeId, properties: { docRole: "interface-spec", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M29" } },
      });
      expectOk(r.status === 201, r.json, `建资产失败：${name}`);
      return r.json.assetId;
    };
    assetA = await mk(srcName);
    await mk(tgtName);
    const rt = await call("POST", "/relation-types", {
      session: admin,
      body: { teamId, typeKey: "m29rel", version: "1.0.0", title: "M29关系", sourceTypeKeys: ["document"], targetTypeKeys: ["document"], requiresRevision: false },
    });
    expectOk(rt.status === 201, rt.json, "注册关系类型失败");
    const list = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=all&limit=10`, { session: admin });
    const assetB = (list.json as { id: string; name: string }[]).find((x) => x.name === tgtName)!.id;
    // 3 条：确认 / 忽略（证据带引号+逗号，考验 CSV 转义往返）/ 待审
    const imp = await call("POST", "/semantic/candidates/import", {
      session: admin,
      body: {
        teamId, assetId: assetA,
        candidates: [
          { relationType: "m29rel", sourceText: srcName, targetText: tgtName, confidence: 0.9, extractorVersion: "m29-test" },
          { relationType: "documentedBy", sourceText: srcName, targetText: tgtName, confidence: 0.7, extractorVersion: "m29-test", evidenceSegment: quotedEvidence },
          { relationType: "related_to", sourceText: tgtName, targetText: srcName, confidence: 0.5, extractorVersion: "m29-test" },
        ],
      },
    });
    expectOk(imp.status === 201, imp.json, "入队失败");
    const [c1, c2] = imp.json.candidateIds as string[];
    const conf = await call("POST", `/semantic/candidates/${c1}/confirm`, { session: admin, body: { teamId, sourceAssetId: assetA, targetAssetId: assetB } });
    expectOk(conf.status === 200, conf.json, "确认失败");
    const dis = await call("POST", `/semantic/candidates/${c2}/dismiss`, { session: admin, body: { teamId } });
    expectOk(dis.status === 200, dis.json, "忽略失败");

    const csvRes = await fetch(`${BASE}/semantic/candidates/export?teamId=${teamId}&status=all`, { headers: { cookie: admin.cookie } });
    expect(csvRes.status === 200, "CSV 导出应 200").toBe(true);
    const raw = new Uint8Array(await csvRes.arrayBuffer());
    expect(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, "导出应带 BOM（字节级）").toBe(true);
    csvAll = new TextDecoder().decode(raw.slice(3));
    csvBom = "\uFEFF" + csvAll;
  }, 60000);

  afterAll(async () => { await app.close(); });

  it("CSV 回导与 JSON 同管线：已忽略放行、确认/待审跳过，转义引号证据完整往返", async () => {
    const r1 = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, csv: csvAll } });
    expectOk(r1.status === 201, r1.json, "CSV 回导失败");
    expect(r1.json.imported === 1 && r1.json.skipped === 2, `应 1 入 2 跳：${JSON.stringify(r1.json)}`).toBe(true);
    expect(r1.json.unresolvedIndexes.length === 0, "asset_name 列应全部解析").toBe(true);

    // 放行条目的证据（含双引号与逗号）应经 CSV 转义完整往返
    const pend = await call("GET", `/semantic/candidates?teamId=${teamId}&status=pending`, { session: admin });
    const reentered = (pend.json as { relation_type: string; evidence_segment: string }[]).find((c) => c.relation_type === "documentedBy");
    expect(!!reentered, "被忽略候选应重新待审").toBe(true);
    expect(reentered!.evidence_segment === quotedEvidence, `证据应完整往返：${JSON.stringify(reentered!.evidence_segment)}`).toBe(true);

    // 幂等：带 BOM 与 # 截断说明行的同一份件再回导 → 全跳过
    const again = csvBom + "\r\n# 已达导出上限 20000 条，更早的记录未包含";
    const r2 = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, csv: again } });
    expectOk(r2.status === 201, r2.json, "带 BOM/#行回导失败");
    expect(r2.json.imported === 0 && r2.json.skipped === 3, `二次回导应全跳过：${JSON.stringify(r2.json)}`).toBe(true);
  });

  it("解析健壮性：缺列/坏字段/空数据如实 422，非成员 404", async () => {
    const headerOnly = csvAll.split("\r\n")[0]!;
    const missing = await call("POST", "/semantic/candidates/reimport", {
      session: admin, body: { teamId, csv: headerOnly + "\r\n\"x\",\"y\",\"z\"" },
    });
    expect(missing.status === 422 && String(missing.json?.error?.message).includes("必需"), `缺列/缺字段应 422：${JSON.stringify(missing.json)}`).toBe(true);

    const badConf = csvAll.replace(/"0\.7"/, `"0.9x"`);
    const bad = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, csv: badConf } });
    expect(bad.status === 422 && String(bad.json?.error?.message).includes("confidence"), `坏 confidence 应 422：${JSON.stringify(bad.json)}`).toBe(true);

    const empty = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId, csv: headerOnly } });
    expect(empty.status === 422 && String(empty.json?.error?.message).includes("CSV"), `空数据应 422：${JSON.stringify(empty.json)}`).toBe(true);

    const neither = await call("POST", "/semantic/candidates/reimport", { session: admin, body: { teamId } });
    expect(neither.status === 422, `items/csv 均缺应 422：${neither.status}`).toBe(true);

    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m29other-${runId}@t.dev`, password: "password-123", displayName: "M29外团队", teamName: `M29外团队-${runId}` }),
    });
    const foreign = await call("POST", "/semantic/candidates/reimport", { session: sessionOf(o), body: { teamId, csv: csvAll } });
    expect(foreign.status === 404, `非成员应 404：${foreign.status}`).toBe(true);
  });
});
