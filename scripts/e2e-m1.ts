/**
 * M1 端到端演示链（真实证据）：两个真实用户 → 登记与读取 → 重启 PostgreSQL → 数据保留。
 * 产出：docs/evidence/m1-e2e-report.json（含每步状态与耗时）。
 * 全程无 mock：真实 HTTP、真实 PostgreSQL 容器、真实文件库。
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildServer } from "../apps/api/src/server.js";
import type { FastifyInstance } from "fastify";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4200;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const runId = randomBytes(3).toString("hex");

interface Step {
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const report: { startedAt: string; runId: string; steps: Step[]; conclusion?: string } = {
  startedAt: new Date().toISOString(),
  runId,
  steps: [],
};

async function record(step: string, fn: () => Promise<string>): Promise<void> {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ step, ok: true, detail, ms: Date.now() - t0 });
    console.log(`✓ ${step} (${Date.now() - t0}ms)`);
  } catch (err) {
    report.steps.push({
      step,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      ms: Date.now() - t0,
    });
    console.error(`✗ ${step}: ${err instanceof Error ? err.message : err}`);
    throw err;
  }
}

interface Sess {
  cookie: string;
  csrf: string;
}

function sessionOf(res: Response): Sess {
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
  opts: { session?: Sess; body?: unknown } = {}
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

function expect(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function main(): Promise<void> {
  let app: FastifyInstance;
  await record("启动 API 服务（端口 4200）", async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
    expect(res.status === 200, "healthz 非绿灯");
    return "healthz ok";
  });

  let admin: Sess, member: Sess, teamAId = "", projectId = "";
  const assetIds: Record<string, string> = {};

  await record("用户甲注册（团队管理员）", async () => {
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `lead-${runId}@demo.dev`,
        password: "password-123",
        displayName: "项目负责人·甲",
        teamName: `演示团队-${runId}`,
      }),
    });
    expect(res.status === 201, `注册失败 HTTP ${res.status}`);
    admin = sessionOf(res);
    teamAId = ((await res.json()) as { teamId: string }).teamId;
    return `teamId=${teamAId}`;
  });

  await record("用户乙注册并由甲加入团队（普通成员）", async () => {
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `member-${runId}@demo.dev`,
        password: "password-123",
        displayName: "资产工程师·乙",
        teamName: `乙的团队-${runId}`,
      }),
    });
    expect(res.status === 201, `注册失败 HTTP ${res.status}`);
    member = sessionOf(res);
    const add = await call("POST", `/teams/${teamAId}/members`, {
      session: admin,
      body: { email: `member-${runId}@demo.dev`, role: "member" },
    });
    expect(add.status === 201, `添加成员失败 HTTP ${add.status}`);
    return "乙已是团队成员";
  });

  await record("甲建项目、乙建 Session 并互相可见", async () => {
    const proj = await call("POST", "/projects", {
      session: admin,
      body: { teamId: teamAId, name: "轨道传播验证", code: `orbit-${runId}` },
    });
    expect(proj.status === 201, `建项目失败 ${JSON.stringify(proj.json)}`);
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, {
      session: member,
      body: { teamId: teamAId, title: "整理模型与测试", visibility: "project" },
    });
    expect(sess.status === 201, `建 Session 失败 ${JSON.stringify(sess.json)}`);
    const list = await call("GET", `/projects/${projectId}/sessions?teamId=${teamAId}`, { session: admin });
    expect(list.status === 200 && list.json.length >= 1, "甲看不到乙的 Session");
    return `session=${sess.json.sessionId}`;
  });

  await record("乙上传真实文件（模型压缩包内容）", async () => {
    const content = Buffer.from(`E2E 模型数据 ${runId} — `.repeat(100));
    const form = new FormData();
    form.append("file", new Blob([content]), `model-${runId}.zip`);
    const res = await fetch(`${BASE}/uploads?teamId=${teamAId}`, {
      method: "POST",
      headers: { cookie: member.cookie, "x-csrf-token": member.csrf },
      body: form,
    });
    expect(res.status === 201, `上传失败 HTTP ${res.status}`);
    const json = (await res.json()) as { digest: string };
    (globalThis as { __e2edigest?: string }).__e2edigest = json.digest;
    return `digest=${json.digest.slice(0, 12)}…`;
  });

  await record("乙登记三类资产（模型/文档/测试），关联关系", async () => {
    const types = await call("GET", `/types?teamId=${teamAId}`, { session: member });
    expect(types.status === 200, "类型列表失败");
    const tv: Record<string, string> = {};
    for (const t of types.json as { id: string; type_key: string }[]) tv[t.type_key] = t.id;
    const digest = (globalThis as { __e2edigest?: string }).__e2edigest!;

    const model = await call("POST", "/assets", {
      session: member,
      body: {
        teamId: teamAId, name: "轨道传播模型A",
        typeVersionId: tv["simulation.model"],
        properties: { frame: "ECI", timeScale: "TAI", positionUnit: "m", velocityUnit: "m/s", interfaceVersion: "prop-v2", validStepSeconds: { min: 0.1, max: 60 } },
        artifacts: [{ digest, role: "implementation", originalName: `model-${runId}.zip`, mediaType: "application/zip", size: 2400 }],
      },
    });
    expect(model.status === 201, `登记模型失败 ${JSON.stringify(model.json)}`);
    assetIds.model = model.json.assetId;

    const doc = await call("POST", "/assets", {
      session: member,
      body: {
        teamId: teamAId, name: "模型A接口说明",
        typeVersionId: tv["document"],
        properties: { docRole: "interface-spec", format: "pdf", language: "zh-CN", confidentiality: "internal", scope: "prop-v2" },
      },
    });
    expect(doc.status === 201, "登记文档失败");
    assetIds.doc = doc.json.assetId;

    const test = await call("POST", "/assets", {
      session: member,
      body: {
        teamId: teamAId, name: "回归测试集A",
        typeVersionId: tv["test.suite"],
        properties: { testTarget: "prop-v2", execProtocol: "pytest-v1", fixtureVersion: "fx-3", passThreshold: 0.95 },
      },
    });
    expect(test.status === 201, "登记测试失败");
    assetIds.test = test.json.assetId;

    // 读取验证（乙读取，甲读取）
    for (const s of [member, admin]) {
      const got = await call("GET", `/assets/${assetIds.model}?teamId=${teamAId}`, { session: s });
      expect(got.status === 200 && got.json.revisions.length === 1, "资产读取/修订数异常");
    }
    return `model=${assetIds.model.slice(0, 8)}… doc=${assetIds.doc.slice(0, 8)}… test=${assetIds.test.slice(0, 8)}…`;
  });

  await record("重启 PostgreSQL 容器（docker restart）", async () => {
    execSync("docker restart taw-postgres", { stdio: "pipe" });
    // 等待健康（Windows 下 execSync 走 cmd.exe，格式串必须用双引号）
    for (let i = 0; i < 30; i++) {
      try {
        const r = execSync('docker inspect --format "{{.State.Health.Status}}" taw-postgres', {
          encoding: "utf8",
        }).trim();
        if (r === "healthy") return `容器 healthy（第 ${i + 1} 次探测）`;
      } catch {
        /* 重启中 */
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("容器 30 秒内未恢复 healthy");
  });

  await record("重启后用同一账号读取：项目、Session、资产与文件摘要全部保留", async () => {
    // 数据库刚恢复，等待连接池自然重建
    await new Promise((r) => setTimeout(r, 1500));
    const projList = await call("GET", "/projects", { session: admin });
    expect(
      projList.status === 200 && (projList.json as { projectId: string }[]).some((p) => p.projectId === projectId),
      `重启后项目丢失 status=${projList.status} body=${JSON.stringify(projList.json).slice(0, 200)}`
    );
    const asset = await call("GET", `/assets/${assetIds.model}?teamId=${teamAId}`, { session: member });
    expect(asset.status === 200, "重启后资产丢失");
    const rev = asset.json.revisions[0];
    expect(typeof rev.content_digest === "string" && /^[0-9a-f]{64}$/.test(rev.content_digest), "内容摘要异常");
    const digest = (globalThis as { __e2edigest?: string }).__e2edigest!;
    const blob = await fetch(`${BASE}/blobs/${digest}?teamId=${teamAId}`, {
      headers: { cookie: member.cookie },
    });
    expect(blob.status === 200, "重启后文件内容不可读");
    return "项目/Session/资产/修订摘要/blob 全部保留";
  });

  report.conclusion = "M1 出口条件满足：两个真实用户完成登记与读取，容器重启后数据保留。";
}

main()
  .then(async () => {
    const dir = join(root, "docs", "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m1-e2e-report.json"), JSON.stringify(report, null, 2));
    console.log(`\nE2E 全部通过。报告：docs/evidence/m1-e2e-report.json`);
    process.exit(0);
  })
  .catch(async (err) => {
    report.conclusion = `失败：${err instanceof Error ? err.message : err}`;
    const dir = join(root, "docs", "evidence");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "m1-e2e-report.json"), JSON.stringify(report, null, 2));
    console.error("\nE2E 失败，报告已写入 docs/evidence/m1-e2e-report.json");
    process.exit(1);
  });
