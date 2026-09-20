// C07 + C08 补强验收：ETag 并发保护与 Session 分享来源检查。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";

const PORT = 4106;
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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown; ifMatch?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.ifMatch) headers["if-match"] = opts.ifMatch;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

describe("C07/C08 补强（真实集成）", () => {
  let app: FastifyInstance;
  let admin: Session, member: Session, other: Session;
  let teamId = "", projectId = "";
  let assetId = "", sessionId = "", secretSessionId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `c7-${runId}@t.dev`, password: "password-123", displayName: "并发管理员", teamName: `并发团队-${runId}` }),
    });
    admin = sessionOf(a); teamId = ((await a.json()) as { teamId: string }).teamId;
    const m = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `c7m-${runId}@t.dev`, password: "password-123", displayName: "并发成员", teamName: `旁-${runId}` }),
    });
    member = sessionOf(m);
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `c7o-${runId}@t.dev`, password: "password-123", displayName: "第三人", teamName: `外-${runId}` }),
    });
    other = sessionOf(o);
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `c7m-${runId}@t.dev`, role: "member" } });
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "并发验证项目", code: `c7-${runId}` } });
    projectId = proj.json.projectId;
    await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docType = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;
    const asset = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: "并发编辑文档", typeVersionId: docType.id,
        properties: { docRole: "manual", format: "txt", language: "zh-CN", confidentiality: "internal", scope: "x" }, labels: ["初始"] },
    });
    assetId = asset.json.assetId;
    const s1 = await call("POST", `/projects/${projectId}/sessions`, {
      session: member, body: { teamId, title: "普通分享会话", visibility: "private" },
    });
    sessionId = s1.json.sessionId;
    const s2 = await call("POST", `/projects/${projectId}/sessions`, {
      session: member, body: { teamId, title: "含密会话", visibility: "private" },
    });
    secretSessionId = s2.json.sessionId;
  });

  afterAll(async () => { await app.close(); });

  it("C07：无 If-Match 拒绝；过期 ETag 409；正确 ETag 成功且版本前移", async () => {
    // 缺 If-Match
    const noEtag = await call("PATCH", `/assets/${assetId}/meta`, {
      session: admin, body: { teamId, name: "改个名" },
    });
    expect(noEtag.status === 422, "缺 If-Match 应 422").toBe(true);

    // 获取当前 ETag（meta_version=1）
    const stale = await call("PATCH", `/assets/${assetId}/meta`, {
      session: admin, body: { teamId, name: "并发写入者A" }, ifMatch: '"meta-1"',
    });
    expect(stale.status === 200, "首次修改应成功").toBe(true);
    const newEtag = stale.json.etag as string;

    // 持旧 ETag 的并发写入者 B → 409，不静默覆盖
    const conflict = await call("PATCH", `/assets/${assetId}/meta`, {
      session: member, body: { teamId, name: "并发写入者B" }, ifMatch: '"meta-1"',
    });
    expect(conflict.status === 409 && conflict.json.error.code === "STALE_HEAD", "过期 ETag 应 409").toBe(true);
    expect(conflict.json.error.details.currentEtag === newEtag, "应返回当前 ETag 供恢复").toBe(true);

    // B 拿新 ETag 重试 → 成功（先合并再写）
    const retry = await call("PATCH", `/assets/${assetId}/meta`, {
      session: member, body: { teamId, name: "并发写入者B（合并后）" }, ifMatch: newEtag,
    });
    expect(retry.status === 200, "新 ETag 重试应成功").toBe(true);
  });

  it("C08：可分享会话——检查通过后分享，第三人可见；检查过期拒绝", async () => {
    await call("POST", `/sessions/${sessionId}/messages`, {
      session: member, body: { teamId, role: "user", content: "请参考 @并发编辑文档 的最新修订做整理" },
    });
    const check = await call("POST", `/sessions/${sessionId}/share-check`, {
      session: member, body: { teamId },
    });
    expect(check.status === 200 && check.json.shareable === true, "应可分享").toBe(true);

    // 第三人（非创建者、同团队成员）不能分享他人会话
    const notOwner = await call("POST", `/sessions/${sessionId}/share`, {
      session: admin, body: { teamId, confirmCheckDigest: check.json.checkDigest },
    });
    expect(notOwner.status === 403, "非创建者分享应 403").toBe(true);

    const share = await call("POST", `/sessions/${sessionId}/share`, {
      session: member, body: { teamId, confirmCheckDigest: check.json.checkDigest },
    });
    expect(share.status === 200 && share.json.visibility === "project", "分享应成功").toBe(true);
    // 项目成员（管理员）现在能看到该私有转共享会话
    const list = await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin });
    expect(list.json.some((s: any) => s.sessionId === sessionId), "分享后项目成员应可见").toBe(true);
  });

  it("C08：含密引用会话被来源检查阻止，不泄露内容", async () => {
    // 引用一条 secret 级资产
    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docType = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;
    const secretDoc = await call("POST", "/assets", {
      session: admin,
      body: { teamId, name: `绝密接口说明-${runId}`, typeVersionId: docType.id,
        properties: { docRole: "interface-spec", format: "txt", language: "zh-CN", confidentiality: "secret", scope: "x" } },
    });
    await call("POST", `/sessions/${secretSessionId}/messages`, {
      session: member,
      body: { teamId, role: "user", content: `对照 @绝密接口说明-${runId} 检查：${secretDoc.json.assetId}` },
    });
    const check = await call("POST", `/sessions/${secretSessionId}/share-check`, {
      session: member, body: { teamId },
    });
    expect(check.status === 200 && check.json.shareable === false, "含密会话不可分享").toBe(true);
    expect(JSON.stringify(check.json.blockers)).toContain("secret", check.json);

    // 绕过检查直接分享 → 403（摘要不匹配或阻断）
    const bypass = await call("POST", `/sessions/${secretSessionId}/share`, {
      session: member, body: { teamId, confirmCheckDigest: "0000000000000000" },
    });
    expect(bypass.status === 409 || bypass.status === 403, "绕过检查应被拒").toBe(true);

    // 用真实（阻断态）摘要分享 → 403 且会话保持 private
    const share = await call("POST", `/sessions/${secretSessionId}/share`, {
      session: member, body: { teamId, confirmCheckDigest: check.json.checkDigest },
    });
    expect(share.status === 403, "阻断态分享应 403").toBe(true);
    const list = await call("GET", `/projects/${projectId}/sessions?teamId=${teamId}`, { session: admin });
    expect(!list.json.some((s: any) => s.sessionId === secretSessionId && s.visibility === "project"), "会话应保持私有").toBe(true);
  });
});
