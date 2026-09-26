// M43 CR 冻结差异测试 — GET /change-requests/:id 的 items 携带
// 绑定固化 base/candidate 修订的差异（属性逐字段 / 制品文本行补丁 / 关系），
// 复用 @taw/domain/diff 的 diffRevisions。全部真实集成：真实 PG/HTTP/文件。无 mock。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { loadEnvFile } from "@taw/agent-adapter/env";

const runId = randomBytes(4).toString("hex");
loadEnvFile();
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";

const PORT = 4141;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;

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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown } = {}): Promise<{ status: number; json: any }> {
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
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

async function upload(session: Session, teamId: string, content: string, name: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content]), name);
  const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
    method: "POST",
    headers: { cookie: session.cookie, "x-csrf-token": session.csrf },
    body: form,
  });
  const json = (await res.json()) as { digest?: string };
  expect(res.status === 201 && !!json.digest, "上传失败").toBe(true);
  return json.digest!;
}

describe("M43 CR 详情冻结差异（属性/制品文本补丁/关系）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";
  let crId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m43-${runId}@t.dev`, password: "password-123", displayName: "M43管理员", teamName: `M43团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M43项目-${runId}`, code: `m43${runId.slice(0, 6)}` } });
    expectOk(proj.status === 201, proj.json, "建项目失败");
    const projectId = proj.json.projectId as string;

    const types = await call("GET", `/types?teamId=${teamId}`, { session: admin });
    const docType = (types.json as { id: string; type_key: string }[]).find((t) => t.type_key === "document")!;

    // 基线资产 r1：summary=初版 + 文本制品 v1
    const d1 = await upload(admin, teamId, `alpha\nbeta\n`, `spec-${runId}.md`);
    const asset = await call("POST", "/assets", {
      session: admin,
      body: {
        teamId, name: `差异验证文档-${runId}`, typeVersionId: docType.id,
        properties: { docRole: "report", format: "md", language: "zh-CN", confidentiality: "internal", scope: "M43", summary: "初版" },
        artifacts: [{ digest: d1, role: "implementation", originalName: `spec-${runId}.md`, mediaType: "text/markdown", size: 11 }],
      },
    });
    expectOk(asset.status === 201, asset.json, "登记资产失败");
    const assetId = asset.json.assetId as string;

    // 分支草稿 r2：summary 改为「补充结论」+ 制品 v2（beta → gamma）
    const br = await call("POST", `/projects/${projectId}/branches`, { session: admin, body: { teamId, name: `diff-${runId}` } });
    expectOk(br.status === 201, br.json, "建分支失败");
    const d2 = await upload(admin, teamId, `alpha\ngamma\n`, `spec-${runId}.md`);
    const save = await call("POST", `/branches/${br.json.branchId}/revisions`, {
      session: admin,
      body: {
        teamId, assetId, properties: { summary: "补充结论" },
        artifacts: [{ digest: d2, role: "implementation", originalName: `spec-${runId}.md`, mediaType: "text/markdown", size: 12 }],
      },
    });
    expectOk(save.status === 201, save.json, "保存草稿失败");

    const cr = await call("POST", "/change-requests", {
      session: admin,
      body: { teamId, branchId: br.json.branchId, title: "补充结论", motivation: "验证冻结差异" },
    });
    expectOk(cr.status === 201, cr.json, "建 CR 失败");
    crId = cr.json.changeRequestId as string;
  }, 60000);

  afterAll(async () => {
    await app.close();
  });

  it("items 携带冻结差异：属性 changed + 制品 textPatch（del beta / add gamma）+ 未变字段不出现", async () => {
    const got = await call("GET", `/change-requests/${crId}?teamId=${teamId}`, { session: admin });
    expectOk(got.status === 200, got.json, "读取 CR 详情失败");
    const item = (got.json.items as any[])[0];
    expectOk(!!item, got.json, "CR 应有一个变更项");
    expect(item.base_seq === 1 && item.candidate_seq === 2, `修订序号应为 r1→r2：${JSON.stringify(item)}`).toBe(true);

    const diff = item.diff as {
      properties: { key: string; kind: string; from?: unknown; to?: unknown }[];
      artifacts: { name: string; binary: boolean; textPatch?: { type: string; line: string }[] }[];
      relations: { added: unknown[]; removed: unknown[] };
    };
    expectOk(!!diff, item, "变更项应携带 diff");
    const summary = diff.properties.find((p) => p.key === "summary");
    expect(!!summary && summary.kind === "changed" && summary.from === "初版" && summary.to === "补充结论",
      `summary 应为 changed：${JSON.stringify(diff.properties)}`).toBe(true);
    expect(diff.properties.some((p) => p.key === "format"), "未变更字段不应出现在差异中").toBe(false);

    expect(diff.artifacts.length === 1, `应有一个制品差异：${JSON.stringify(diff.artifacts)}`).toBe(true);
    const art = diff.artifacts[0]!;
    expect(art.binary === false, "text/markdown 应视为文本").toBe(true);
    const patch = art.textPatch ?? [];
    expect(patch.some((l) => l.type === "del" && l.line === "beta"), `补丁应删 beta：${JSON.stringify(patch)}`).toBe(true);
    expect(patch.some((l) => l.type === "add" && l.line === "gamma"), `补丁应增 gamma：${JSON.stringify(patch)}`).toBe(true);
    expect(Array.isArray(diff.relations.added) && Array.isArray(diff.relations.removed), "关系差异结构应存在").toBe(true);
  });

  it("退回留痕：changes-requested 的评论进入详情（含作者），快照随之全部失效", async () => {
    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, {
      session: admin, body: { teamId, channel: "stable" },
    });
    expectOk(prep.status === 201 || prep.status === 200, prep.json, "prepare-review 失败");
    const rej = await call("POST", `/change-requests/${crId}/changes-requested`, {
      session: admin, body: { teamId, comment: "结论段落缺少数据支撑，请补充后重新送审" },
    });
    expectOk(rej.status === 200, rej.json, "退回失败");
    const got = await call("GET", `/change-requests/${crId}?teamId=${teamId}`, { session: admin });
    expectOk(got.status === 200, got.json, "读取详情失败");
    expect(got.json.status === "changes_requested", `状态应为已退回：${got.json.status}`).toBe(true);
    const comments = got.json.comments as { content: string; author_name: string | null }[] | undefined;
    expect(
      Array.isArray(comments) && comments.length === 1 && comments[0]!.content.includes("数据支撑") && !!comments[0]!.author_name,
      `留痕应含退回原因与作者：${JSON.stringify(comments)}`
    ).toBe(true);
    expect(
      (got.json.snapshots as { superseded: boolean }[]).every((s) => s.superseded),
      "退回后审核快照应全部失效"
    ).toBe(true);
  });
});
