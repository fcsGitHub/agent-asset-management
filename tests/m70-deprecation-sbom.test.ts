// M70 调研吸收轮集成测试（两项）：
// ①资产弃用与继任治理（MLflow Model Registry Archived / Docker Hub deprecated images /
//   HF deprecated models + Dependabot deprecation alerts 锚点）：deprecate/undeprecate 端点
//   （权限同归档=创建者或管理员；审计盖章；幂等更新继任者；归档终态 409）；目录默认视图
//   含弃用资产（可见带警示不隐藏——修正基线起 CASE ELSE 'active' 把 deprecated 当归档
//   悄悄过滤的口径断链）；deprecated/archived 筛选；导出同源；Agent 工具如实可见
//   （search 附 lifecycle、getRevision 附 deprecation 告警与继任者）。
// ②SBOM 导出（OWASP CycloneDX 1.5 锚点）：主体 + confirmed 关系闭包 → 机器可读物料清单
//   （bom-ref 确定性、dependencies 就来自闭包边、制品 sha-256 进 hashes、弃用元数据进
//   properties）；孤立资产空 components；导出计 download 热度 + asset.sbom 审计；外团队 404。
// 纯函数（typeKeyToComponentType/buildSbom）单测同文件内先行。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import type { PoolClient } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { invokeTool, allAgentTools } from "../apps/api/src/agent/tools";
import { buildSbom, typeKeyToComponentType, type SbomAsset } from "@taw/domain/sbom";

const PORT = 4180;
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
  return { status: res.status, json: text ? JSON.parse(text) : null, text };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 600)}`);
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

// ---------- 纯函数 ----------

describe("M70 纯函数：typeKeyToComponentType / buildSbom（CycloneDX 1.5）", () => {
  it("七类资产类型键映射到 CycloneDX 组件类型（1.5 含 machine-learning-model/data）", () => {
    expect(typeKeyToComponentType("simulation.model")).toBe("machine-learning-model");
    expect(typeKeyToComponentType("simulation.engine")).toBe("application");
    expect(typeKeyToComponentType("software")).toBe("application");
    expect(typeKeyToComponentType("test.suite")).toBe("library");
    expect(typeKeyToComponentType("document")).toBe("file");
    expect(typeKeyToComponentType("data")).toBe("data");
    expect(typeKeyToComponentType("agent.template")).toBe("application");
    // 自定义类型按首段回落，不抛错（原键如实保留在 properties）
    expect(typeKeyToComponentType("orbit.custom.thing")).toBe("application");
  });

  const A: SbomAsset = {
    id: "11111111-1111-4111-8111-111111111111", name: "主体资产", typeKey: "simulation.model",
    typeVersion: "1.0.0", lifecycle: "deprecated", revisionSeq: 3, contentDigest: "cafe01",
    artifacts: [{ digest: "aa11", originalName: "m.bin", mediaType: "application/octet-stream", size: 10 }],
    deprecatedAt: "2026-10-01T00:00:00Z", deprecationNote: "已由新版替代", successor: { id: "22222222-2222-4222-8222-222222222222", name: "继任资产" },
  };
  const B: SbomAsset = {
    id: "22222222-2222-4222-8222-222222222222", name: "继任资产", typeKey: "document",
    typeVersion: "1.0.0", lifecycle: "active", revisionSeq: 1, contentDigest: "cafe02",
    artifacts: [], deprecatedAt: null, deprecationNote: null, successor: null,
  };
  const input = {
    subject: A, assets: [A, B],
    edges: [{ fromAssetId: A.id, toAssetId: B.id, predicate: "partOf" }],
    generatedAt: "2026-10-06T00:00:00Z", serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
  };

  it("buildSbom：结构（bomFormat/主体/组件/依赖/hashes/弃用 properties）与确定性", () => {
    const doc = buildSbom(input);
    expect(doc.bomFormat).toBe("CycloneDX");
    expect(doc.specVersion).toBe("1.5");
    expect(doc.serialNumber).toBe(input.serialNumber);
    // 主体进 metadata.component，不重复出现在 components
    expect(doc.metadata.component["bom-ref"]).toBe(`urn:taw:asset:${A.id}@r3`);
    expect(doc.metadata.component.type).toBe("machine-learning-model");
    expect(doc.components.map((c) => c.name)).toEqual([B.name]);
    // 主体制品 sha-256 进 hashes
    expect(doc.metadata.component.hashes).toEqual([{ alg: "SHA-256", content: "aa11" }]);
    // 依赖图：主体 dependsOn 继任者；继任者无出边 → 空数组（显式无依赖）
    const bRef = `urn:taw:asset:${B.id}@r1`;
    expect(doc.dependencies).toEqual([
      { ref: `urn:taw:asset:${A.id}@r3`, dependsOn: [bRef] },
      { ref: bRef, dependsOn: [] },
    ]);
    // 弃用元数据进 properties（供应链消费方可告警）
    const props = Object.fromEntries((doc.metadata.component.properties ?? []).map((p) => [p.name, p.value]));
    expect(props["taw:lifecycle"]).toBe("deprecated");
    expect(props["taw:deprecationNote"]).toBe("已由新版替代");
    expect(props["taw:successor"]).toContain("继任资产");
    // 纯函数确定性：同输入同输出
    expect(JSON.stringify(buildSbom(input))).toBe(JSON.stringify(doc));
  });

  it("buildSbom：闭包外的边不虚报 dependsOn（截断如实收窄）", () => {
    const doc = buildSbom({
      ...input,
      edges: [
        { fromAssetId: A.id, toAssetId: B.id, predicate: "partOf" },
        { fromAssetId: B.id, toAssetId: "99999999-9999-4999-8999-999999999999", predicate: "partOf" }, // 目标不在闭包内
      ],
    });
    expect(doc.dependencies.find((d) => d.ref.endsWith("@r1"))?.dependsOn).toEqual([]);
  });
});

// ---------- 端到端 ----------

describe("M70 资产弃用与继任 + SBOM 导出（端到端）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let teamId = "";
  let adminUserId = "";
  let typeVersionId = "";
  let assetOld = "", assetNew = "", assetLone = "";
  let sessionId = "", projectId = "", runRowId = "";
  const nameOld = `M70旧引擎-${runId}`;
  const nameNew = `M70新引擎-${runId}`;
  const nameLone = `M70孤立资产-${runId}`;
  const aliasNew = `m70new-${runId.slice(0, 4)}`;

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m70admin-${runId}@t.dev`, password: "password-123", displayName: "M70管理员", teamName: `M70团队-${runId}` }),
    });
    admin = sessionOf(a);
    teamId = ((await a.json()) as { teamId: string }).teamId;
    const me = await call("GET", "/auth/me", { session: admin });
    adminUserId = me.json.userId as string;
    // 第二名成员（权限负例：非创建者非管理员）与外人（跨租户 404）
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m70member-${runId}@t.dev`, password: "password-123", displayName: "M70成员", teamName: `M70成员临时团队-${runId}` }),
    });
    member = sessionOf(m);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m70member-${runId}@t.dev`, role: "member" } });
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m70other-${runId}@t.dev`, password: "password-123", displayName: "M70外人", teamName: `M70外团队-${runId}` }),
    });
    outsider = sessionOf(o);

    const typeKey = `m70.engine.${runId.slice(0, 4)}`;
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey, version: "1.0.0", title: "M70引擎", jsonSchema: { type: "object", properties: { owner: { type: "string" } } } },
    });
    typeVersionId = typeReg.json.typeVersionId;
    const mk = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId, properties: { owner: "m70-owner" } } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
      return r.json.assetId as string;
    };
    assetOld = await mk(nameOld);
    assetNew = await mk(nameNew);
    assetLone = await mk(nameLone);
    // 继任者别名（别名精确解析路径）
    const al = await call("POST", `/assets/${assetNew}/aliases`, { session: admin, body: { teamId, alias: aliasNew } });
    expectOk(al.status === 201, al.json, "加别名失败");
    // 依赖边：旧引擎 partOf 新引擎（旧依赖新——SBOM dependsOn 的出边）
    const relTypes = await call("GET", `/relation-types?teamId=${teamId}`, { session: admin });
    const partOf = relTypes.json.find((r: { type_key: string }) => r.type_key === "partOf");
    const rel = await call("POST", "/relations", { session: admin, body: { teamId, relationTypeVersionId: partOf.id, sourceAssetId: assetOld, targetAssetId: assetNew } });
    expectOk(rel.status === 201, rel.json, "建关系失败");

    // Agent 工具断言用的运行行（tool_invocations 外键，同 m50）
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M70项目-${runId}`, code: `m70${runId.slice(0, 6)}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M70工具验证", visibility: "project" } });
    sessionId = sess.json.sessionId;
    runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [teamId, runRowId, sessionId, projectId, "M70 工具验证",
         JSON.stringify([]), JSON.stringify(["asset.search", "asset.getRevision"]),
         JSON.stringify({ maxToolCalls: 4, maxTokens: 20000 }), adminUserId]
      );
    });
  });
  afterAll(async () => { await app.close(); });

  const ctx = () => ({ teamId, userId: adminUserId, projectId, runId: runRowId });
  const invoke = (name: string, args: unknown) =>
    seedInTeam(teamId, (c) => invokeTool(c as unknown as PoolClient, ctx(), allAgentTools(), `m70-${name}-${randomUUID().slice(0, 8)}`, name, JSON.stringify(args)));

  it("①弃用治理：deprecate（继任者名称精确）→ 详情横幅数据 → 重复弃用幂等更新（别名解析）→ 负例", async () => {
    // 名称精确解析继任者
    const d1 = await call("POST", `/assets/${assetOld}/deprecate`, { session: admin, body: { teamId, note: "性能不足，已由新引擎替代", successorRef: nameNew } });
    expectOk(d1.status === 200 && d1.json.lifecycle === "deprecated", d1.json, "弃用失败");
    expectOk(d1.json.successor?.id === assetNew, d1.json, "继任者应按名称解析到新引擎");
    // 详情：横幅数据齐全（deprecatedAt/note/successor）
    const det = await call("GET", `/assets/${assetOld}?teamId=${teamId}`, { session: admin });
    expectOk(det.status === 200 && det.json.deprecatedAt && det.json.deprecationNote === "性能不足，已由新引擎替代", det.json.deprecationNote, "详情缺弃用元数据");
    expectOk(det.json.successor?.name === nameNew && det.json.successor?.lifecycle === "active", det.json.successor, "详情继任者错误");
    // 重复弃用 = 更新（幂等管理动作，repeated 如实标注；继任者走别名精确解析）
    const d2 = await call("POST", `/assets/${assetOld}/deprecate`, { session: admin, body: { teamId, note: "更新原因：全面切换新引擎", successorRef: aliasNew } });
    expectOk(d2.status === 200 && d2.json.repeated === true && d2.json.successor?.id === assetNew, d2.json, "重复弃用应幂等更新并按别名解析");
    // 继任者未解析 → 422；继任者=自身 → 409；归档态 → 409
    const bad = await call("POST", `/assets/${assetOld}/deprecate`, { session: admin, body: { teamId, note: "试一下解析失败", successorRef: `不存在-${runId}` } });
    expectOk(bad.status === 422, bad.json, "未解析继任者应 422");
    const selfRef = await call("POST", `/assets/${assetOld}/deprecate`, { session: admin, body: { teamId, note: "试一下自身继任", successorRef: assetOld } });
    expectOk(selfRef.status === 409 && selfRef.json.error.code === "SUCCESSOR_SELF", selfRef.json, "继任者=自身应 409");
    const arc = await call("POST", `/assets/${assetLone}/archive`, { session: admin, body: { teamId, reason: "M70 归档终态负例" } });
    expectOk(arc.status === 200, arc.json, "归档失败");
    const depArc = await call("POST", `/assets/${assetLone}/deprecate`, { session: admin, body: { teamId, note: "归档后弃用应被拒" } });
    expectOk(depArc.status === 409 && depArc.json.error.code === "ARCHIVED_STATE", depArc.json, "归档态弃用应 409");
    // 权限：成员（非创建者非管理员）403；外人 404
    const mem = await call("POST", `/assets/${assetNew}/deprecate`, { session: member, body: { teamId, note: "成员无权弃用他人资产" } });
    expectOk(mem.status === 403, mem.json, "成员弃用他人资产应 403");
    const out = await call("POST", `/assets/${assetOld}/deprecate`, { session: outsider, body: { teamId, note: "外人跨租户应 404" } });
    expectOk(out.status === 404, out.json, "外人应 404");
    // 审计进动态：action=asset.deprecate 可过滤（两次弃用两条）
    const act = await call("GET", `/activity?teamId=${teamId}&action=asset.deprecate&limit=10`, { session: admin });
    expectOk(act.status === 200 && (act.json.items ?? []).length === 2, (act.json.items ?? []).length, "弃用审计应恰两条");
    const actions = (act.json.actions ?? []) as { value: string; label: string }[];
    expectOk(actions.some((x) => x.value === "asset.deprecate" && x.label.includes("弃用")), actions, "动作过滤下拉应有「弃用资产」");
  });

  it("①目录可见性：默认视图含弃用资产（修正口径断链）→ deprecated/archived 筛选 → 导出同源", async () => {
    // 默认（active）= 进行中 + 已弃用：旧引擎在列且 lifecycle 如实标注
    const def = await call("GET", `/assets/search?teamId=${teamId}&q=${encodeURIComponent(`M70旧引擎-${runId}`)}`, { session: admin });
    expectOk(def.status === 200 && def.json.length === 1 && def.json[0].lifecycle === "deprecated", def.json, "默认视图应含弃用资产并标注 lifecycle");
    // 仅已弃用：只有旧引擎
    const onlyDep = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=deprecated`, { session: admin });
    const depNames = (onlyDep.json as { name: string }[]).map((r) => r.name);
    expectOk(depNames.includes(nameOld) && !depNames.includes(nameNew) && !depNames.includes(nameLone), depNames, "deprecated 筛选应只剩旧引擎");
    // 已归档：孤立资产在、旧引擎不在（归档≠弃用，两态分层）
    const onlyArc = await call("GET", `/assets/search?teamId=${teamId}&lifecycle=archived`, { session: admin });
    const arcNames = (onlyArc.json as { name: string }[]).map((r) => r.name);
    expectOk(arcNames.includes(nameLone) && !arcNames.includes(nameOld), arcNames, "archived 筛选应含孤立资产且不含弃用资产");
    // 导出与目录同一套语义（M69 导出管线自动继承）
    const exp = await call("GET", `/assets/export?teamId=${teamId}&format=json`, { session: admin });
    const names = ((exp.json as { items: { name: string; lifecycle: string }[] }).items ?? []).map((i) => i.name);
    expectOk(names.includes(nameOld) && !names.includes(nameLone), names, "导出默认视图应含弃用、不含归档");
  });

  it("①取消弃用：undeprecate → 回进行中、继任者清空 → 非弃用态 409 → 再弃用（SBOM 用例准备）", async () => {
    const u = await call("POST", `/assets/${assetOld}/undeprecate`, { session: admin, body: { teamId, reason: "恢复验证：回滚弃用标记" } });
    expectOk(u.status === 200 && u.json.lifecycle === "active", u.json, "取消弃用失败");
    const det = await call("GET", `/assets/${assetOld}?teamId=${teamId}`, { session: admin });
    expectOk(det.json.successor === null && det.json.deprecatedAt === null, det.json.successor, "取消弃用应清空继任者与弃用元数据");
    const again = await call("POST", `/assets/${assetOld}/undeprecate`, { session: admin, body: { teamId, reason: "非弃用态再取消应 409" } });
    expectOk(again.status === 409 && again.json.error.code === "NOT_DEPRECATED", again.json, "非弃用态取消应 409");
    // SBOM 用例需要弃用态 + 继任者
    const re = await call("POST", `/assets/${assetOld}/deprecate`, { session: admin, body: { teamId, note: "SBOM 弃用属性用例", successorRef: nameNew } });
    expectOk(re.status === 200, re.json, "再弃用失败");
  });

  it("②SBOM：CycloneDX 1.5 结构（闭包/依赖/hashes/弃用属性）→ 孤立资产空组件 → 热度+审计 → 外团队 404", async () => {
    const before = await call("GET", `/assets/${assetOld}?teamId=${teamId}`, { session: admin });
    const dlBefore = (before.json.usage?.download ?? 0) as number;
    const res = await fetch(`${BASE}/assets/${assetOld}/sbom?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    expectOk(res.status === 200, res.status, "SBOM 导出失败");
    expectOk((res.headers.get("content-disposition") ?? "").includes("attachment"), res.headers.get("content-disposition"), "应带 attachment");
    expectOk((res.headers.get("content-disposition") ?? "").includes(".cdx.json"), res.headers.get("content-disposition"), "文件名应为 .cdx.json");
    const doc = (await res.json()) as {
      bomFormat: string; specVersion: string;
      metadata: { component: { "bom-ref": string; name: string; properties?: { name: string; value: string }[] } };
      components: { "bom-ref": string; name: string }[];
      dependencies: { ref: string; dependsOn: string[] }[];
    };
    expectOk(doc.bomFormat === "CycloneDX" && doc.specVersion === "1.5", `${doc.bomFormat}/${doc.specVersion}`, "应为 CycloneDX 1.5");
    expectOk(doc.metadata.component.name === nameOld, doc.metadata.component.name, "主体应为旧引擎");
    const subjRef = doc.metadata.component["bom-ref"];
    const dep = doc.components.filter((c) => c.name === nameNew);
    expectOk(dep.length === 1 && doc.components.every((c) => c.name !== nameOld), doc.components, "components 应含继任者且不含主体");
    const subjDep = doc.dependencies.find((d) => d.ref === subjRef);
    expectOk(subjDep?.dependsOn.length === 1 && subjDep.dependsOn[0] === dep[0]["bom-ref"], subjDep, "主体 dependsOn 应指向继任者（闭包出边）");
    // 弃用元数据进主体 properties（供应链消费方可告警）
    const props = Object.fromEntries((doc.metadata.component.properties ?? []).map((p) => [p.name, p.value]));
    expectOk(props["taw:lifecycle"] === "deprecated" && props["taw:deprecationNote"] === "SBOM 弃用属性用例", props, "弃用属性缺失");
    expectOk(String(props["taw:successor"] ?? "").includes(nameNew), props, "继任者属性缺失");
    // 孤立资产（已归档）：闭包只有自己，components 空、dependencies 显式空数组
    const lone = await fetch(`${BASE}/assets/${assetLone}/sbom?teamId=${teamId}`, { headers: { cookie: admin.cookie } });
    const loneDoc = (await lone.json()) as { components: unknown[]; dependencies: { ref: string; dependsOn: string[] }[] };
    expectOk(lone.status === 200 && loneDoc.components.length === 0, loneDoc.components, "孤立资产 components 应为空");
    expectOk(loneDoc.dependencies.length === 1 && loneDoc.dependencies[0].dependsOn.length === 0, loneDoc.dependencies, "孤立资产应显式空依赖");
    // 使用热度：主体计一次 download（孤立资产那次计入孤立资产自身）
    const after = await call("GET", `/assets/${assetOld}?teamId=${teamId}`, { session: admin });
    expectOk(((after.json.usage?.download ?? 0) as number) === dlBefore + 1, { before: dlBefore, after: after.json.usage }, "SBOM 导出应计一次 download");
    // 审计：asset.sbom 盖章
    const act = await call("GET", `/activity?teamId=${teamId}&action=asset.sbom&limit=10`, { session: admin });
    expectOk((act.json.items ?? []).length === 2, (act.json.items ?? []).length, "SBOM 审计应恰两条");
    // 外团队 404
    const out = await call("GET", `/assets/${assetOld}/sbom?teamId=${teamId}`, { session: outsider });
    expectOk(out.status === 404, out.json, "外人应 404");
  });

  it("①Agent 如实可见：search 含弃用资产并标注 lifecycle；getRevision 附弃用告警与继任者", async () => {
    const s = await invoke("asset.search", { q: `M70旧引擎-${runId}` });
    expectOk(s.status === "ok", s, "工具执行失败");
    const rows = (s.result as { id: string; name: string; lifecycle: string }[]) ?? [];
    expectOk(rows.length === 1 && rows[0].id === assetOld && rows[0].lifecycle === "deprecated", rows, "Agent 搜索应含弃用资产并标注");
    const g = await invoke("asset.getRevision", { assetId: assetOld });
    expectOk(g.status === "ok", g, "getRevision 失败");
    const result = g.result as { deprecation: { warning: string; note: string; successor: string | null } | null };
    expectOk(result.deprecation !== null, result.deprecation, "弃用资产读取应附告警");
    expectOk(result.deprecation!.successor === nameNew && result.deprecation!.note === "SBOM 弃用属性用例", result.deprecation, "告警应带继任者与原因");
    // 未弃用资产读取：deprecation=null（不误报）
    const g2 = await invoke("asset.getRevision", { assetId: assetNew });
    expectOk((g2.result as { deprecation: unknown }).deprecation === null, g2.result, "未弃用资产不应误报");
  });
});
