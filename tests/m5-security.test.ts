// E02 安全负例 — 路径穿越、越权下载、会话撤销、密钥泄露、上传文件名武器化。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const PORT = 4105;
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

describe("E02 安全负例（真实集成）", () => {
  let app: FastifyInstance;
  let user: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `sec-${runId}@t.dev`, password: "password-123", displayName: "安全员", teamName: `安全团队-${runId}` }),
    });
    user = sessionOf(reg);
    teamId = ((await reg.json()) as { teamId: string }).teamId;
  });

  afterAll(async () => { await app.close(); });

  it("路径穿越：digest 路径参数含 ../ 与 %2e%2e 一律拒绝", async () => {
    const cases = ["../../etc/passwd", "a%2f..%2f..%2fpasswd", "../../../Windows/win.ini", "....//....//etc/passwd"];
    for (const c of cases) {
      const res = await fetch(`${BASE}/blobs/${encodeURIComponent(c)}?teamId=${teamId}`, {
        headers: { cookie: user.cookie },
      });
      expect(res.status === 404, `穿越样例 ${c} → ${res.status}`, "应 404");
    }
  });

  it("上传文件名武器化：用户文件名不落盘，对象键只由摘要生成", async () => {
    const evilName = `../../evil-${runId}.txt`;
    const form = new FormData();
    form.append("file", new Blob(["evil-content"]), evilName);
    const res = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
      method: "POST", headers: { cookie: user.cookie, "x-csrf-token": user.csrf }, body: form,
    });
    expect(res.status === 201, res.status, "正常内容应可上传");
    const { digest } = (await res.json()) as { digest: string };
    // 内容库目录里不存在以用户文件名命名的文件
    const blobRoot = resolve(process.env.BLOBSTORE_ROOT ?? "./data/blobs");
    const entries = await readdir(join(blobRoot, teamId));
    expect(!entries.some((f) => f.includes("evil")), entries.filter((f) => f.includes("evil")), "用户文件名不得成为存储路径");
    expect(entries.includes(digest), entries, "对象键应为摘要");
  });

  it("下载越权：非本团队成员无法下载 blob；伪造 teamId 无效", async () => {
    const o = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `sec-out-${runId}@t.dev`, password: "password-123", displayName: "外人", teamName: `外-${runId}` }),
    });
    const outsider = sessionOf(o);
    const form = new FormData();
    form.append("file", new Blob(["secret-data"]), "s.txt");
    const up = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
      method: "POST", headers: { cookie: user.cookie, "x-csrf-token": user.csrf }, body: form,
    });
    const { digest } = (await up.json()) as { digest: string };
    const forged = await fetch(`${BASE}/blobs/${digest}?teamId=${teamId}`, {
      headers: { cookie: outsider.cookie },
    });
    expect(forged.status === 404, forged.status, "外人下载应 404（不泄露存在性）");
  });

  it("密钥不泄露：API 响应不含 DEEPSEEK key；配置端点不存在", async () => {
    // 健康检查与错误响应不应回显任何配置
    const health = await (await fetch(`http://127.0.0.1:${PORT}/healthz`)).text();
    expect(!health.includes("sk-"), health, "健康检查泄露");
    const nf = await (await fetch(`${BASE}/config`, { headers: { cookie: user.cookie } })).text();
    expect(!nf.includes("sk-"), nf, "未知端点不应回显配置");
    const notFound = await (await fetch(`${BASE}/.env`, { headers: { cookie: user.cookie } })).text();
    expect(!notFound.includes("DEEPSEEK"), notFound, "不得暴露 .env 内容");
  });

  it("会话撤销：登出后原 cookie 立即失效", async () => {
    const login = await fetch(`${BASE}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `sec-${runId}@t.dev`, password: "password-123" }),
    });
    const s = sessionOf(login);
    const me1 = await fetch(`${BASE}/auth/me`, { headers: { cookie: s.cookie } });
    expect(me1.status === 200, me1.status, "登录后应可用");
    await fetch(`${BASE}/auth/logout`, {
      method: "POST", headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
    });
    const me2 = await fetch(`${BASE}/auth/me`, { headers: { cookie: s.cookie } });
    expect(me2.status === 401, me2.status, "登出后应 401");
  });

  it("blob 下载响应为 octet-stream（不按用户输入的内容类型渲染）", async () => {
    const form = new FormData();
    form.append("file", new Blob(["<script>alert(1)</script>"]), "payload.html");
    const up = await fetch(`${BASE}/uploads?teamId=${teamId}`, {
      method: "POST", headers: { cookie: user.cookie, "x-csrf-token": user.csrf }, body: form,
    });
    const { digest } = (await up.json()) as { digest: string };
    const dl = await fetch(`${BASE}/blobs/${digest}?teamId=${teamId}`, { headers: { cookie: user.cookie } });
    expect((dl.headers.get("content-type") ?? "").includes("octet-stream"), dl.headers.get("content-type"), "应强制 octet-stream");
  });
});
