// M72 安全与缺陷收口轮集成测试（十一项）：
// ①CSV 公式注入防护（OWASP CSV Injection 锚点）：csvEscape 对 = + - @ 等危险开头
//   前缀单引号；普通名不受影响；BOM/表头回归由 m69 保证。
// ②LIKE 通配符转义：q 按字面量匹配——`_`/`%` 不再充当通配符（纯函数 + 端到端）。
// ③work-items 状态变更补成员校验：被移出团队的旧 assignee 403（修复前 200）。
// ④proposals 单条 review 项目归属：团队成员但非项目成员 403（与批量端点对齐）。
// ⑤releases 先鉴权后回放：已缓存的幂等键不再让被移出成员重放发布回执。
// ⑥弃用自继守卫：successorRef 按自身名称/别名解析命中自身 → 409 SUCCESSOR_SELF。
// ⑦重复加团队成员 409 MEMBER_EXISTS（原 500 INTERNAL）。
// ⑧lead 基线通道复活：项目创建者（lead，非团队 admin）可建基线（原恒 403 死代码）。
// ⑨messages 并发 seq：advisory lock 串行化分配——并发 POST 全 201 且 seq 互异。
// ⑩登录失败限速：同 (ip, email) 连败 10 次后 429 RATE_LIMITED（正确密码也被拒），
//   其他邮箱不受影响（OWASP Authentication Cheat Sheet 锚点）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes, randomUUID } from "node:crypto";
import { likeContains } from "../apps/api/src/like";

const PORT = 4192;
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

async function call(method: string, path: string, opts: { session?: Session; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, json, text };
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

describe("M72 纯函数：likeContains（LIKE 通配符转义）", () => {
  it("转义 \\ % _ 三个元字符并包裹 %", () => {
    expect(likeContains("100%")).toBe("%100\\%%");
    expect(likeContains("a_b")).toBe("%a\\_b%");
    expect(likeContains("path\\to")).toBe("%path\\\\to%");
    expect(likeContains("plain")).toBe("%plain%");
  });
});

describe("M72 端到端：安全与缺陷收口", () => {
  let app: FastifyInstance;
  let admin: Session;
  let member: Session;
  let outsider: Session;
  let teamId = "";
  let adminUserId = "", memberUserId = "", outsiderUserId = "";
  let projectId = "", sessionId = "";
  const N = runId.slice(0, 6);

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const mk = async (label: string, teamName: string) => {
      const r = await fetch(`${BASE}/auth/register`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: `m72-${label}-${runId}@t.dev`, password: "password-123", displayName: `M72${label}`, teamName }),
      });
      return { session: sessionOf(r), body: (await r.json()) as { teamId: string; userId: string } };
    };
    const a = await mk("admin", `M72团队-${runId}`);
    admin = a.session; teamId = a.body.teamId; adminUserId = a.body.userId;
    const m = await mk("member", `M72成员临时团队-${runId}`);
    member = m.session; memberUserId = m.body.userId;
    const o = await mk("outsider", `M72外团队-${runId}`);
    outsider = o.session; outsiderUserId = o.body.userId;
    const add = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m72-member-${runId}@t.dev`, role: "member" } });
    expectOk(add.status === 201, add.json, "加成员失败");
    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: `M72项目-${runId}`, code: `m72a${N}` } });
    projectId = proj.json.projectId;
    const sess = await call("POST", `/projects/${projectId}/sessions`, { session: admin, body: { teamId, title: "M72并发会话", visibility: "project" } });
    sessionId = sess.json.sessionId;
  });
  afterAll(async () => { await app.close(); });

  it("①CSV 公式注入防护：= 与 - 开头的资产名导出时前缀单引号，普通名不变", async () => {
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m72.doc.${N}`, version: "1.0.0", title: "M72文档", jsonSchema: { type: "object", properties: {} } },
    });
    expectOk(typeReg.status === 201, typeReg.json, "注册类型失败");
    const mk = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: typeReg.json.typeVersionId, properties: {} } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
    };
    await mk(`=1+1|cmd-${N}`);
    await mk(`-滚珠规格-${N}`);
    await mk(`普通资产-${N}`);
    const exp = await fetch(`${BASE}/assets/export?teamId=${teamId}&format=csv&q=${encodeURIComponent(N)}`, { headers: { cookie: admin.cookie } });
    const text = (await exp.text()).replace(/^\uFEFF/, "");
    expectOk(text.includes(`"'=1+1|cmd-${N}"`), text.split("\r\n").slice(0, 4), "= 开头单元格应有 ' 前缀");
    expectOk(text.includes(`"'-滚珠规格-${N}"`), null, "- 开头单元格应有 ' 前缀");
    expectOk(text.includes(`"普通资产-${N}"`), null, "普通名不应有前缀");
    // 表头仍以 # 无关的首行正常存在（BOM/表头回归由 m69 保证）
    expectOk(text.split("\r\n")[0]!.startsWith("name,type_key"), text.split("\r\n")[0], "表头应完好");
  });

  it("②LIKE 转义端到端：下划线按字面量匹配，不再充当单字符通配符", async () => {
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m72.like.${N}`, version: "1.0.0", title: "M72Like", jsonSchema: { type: "object", properties: {} } },
    });
    const mk = async (name: string) => {
      const r = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: typeReg.json.typeVersionId, properties: {} } });
      expectOk(r.status === 201, r.json, `登记 ${name} 失败`);
    };
    await mk(`m72_a-${N}`);  // 字面量含下划线
    await mk(`m72ab-${N}`);  // 会被未转义的 m72_b 通配命中（修复前）
    const hit = await call("GET", `/assets/search?teamId=${teamId}&q=${encodeURIComponent(`m72_a-${N}`)}`, { session: admin });
    expectOk(hit.json.length === 1 && hit.json[0].name === `m72_a-${N}`, hit.json, "字面量下划线应精确匹配（修复前通配会双命中）");
    const miss = await call("GET", `/assets/search?teamId=${teamId}&q=${encodeURIComponent(`m72_b-${N}`)}`, { session: admin });
    expectOk(miss.status === 200 && miss.json.length === 0, miss.json, "下划线不应再充当通配符");
  });

  it("③work-items：被移出团队的旧 assignee 不能再改状态（403），admin 仍可", async () => {
    // seed 直接插一条 assignee=outsider 的工单（模拟「曾是成员被移出」的状态残留）
    const wiId = await seedInTeam(teamId, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO work_items (team_id, id, project_id, title, assignee_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [teamId, id, projectId, `M72越权工单-${N}`, outsiderUserId, adminUserId]
      );
      return id;
    });
    const denied = await call("POST", `/work-items/${wiId}/status`, {
      session: outsider, body: { teamId, status: "done" },
    });
    // 404 而非 403：teamRole 对非成员按项目惯例报「不存在」不泄露团队存在性——
    // 关键断言是「不再是 200」（修复前旧 assignee 直接 200 改状态）
    expectOk(denied.status === 404, denied.json, "外团队旧 assignee 应被成员门槛拦下（修复前 200）");
    const ok = await call("POST", `/work-items/${wiId}/status`, {
      session: admin, body: { teamId, status: "done" },
    });
    expectOk(ok.status === 200, ok.json, "admin 应可改状态");
  });

  it("④proposals 单条 review 项目归属：团队成员但非项目成员 403，项目成员 admin 200", async () => {
    // 成员建自己的项目（成为 lead）→ 造一条属于该项目外（admin 项目）的提案
    const runRowId = randomUUID();
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [teamId, runRowId, sessionId, projectId, "M72提案验证", JSON.stringify([]), JSON.stringify([]),
         JSON.stringify({ maxToolCalls: 2, maxTokens: 8000 }), adminUserId]
      );
    });
    const proposalId = await seedInTeam(teamId, async (c) => {
      const id = randomUUID();
      await c.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'issue_triage',$5)`,
        [teamId, id, runRowId, projectId, JSON.stringify({ title: "M72提案" })]
      );
      return id;
    });
    const denied = await call("POST", `/proposals/${proposalId}/review`, {
      session: member, body: { teamId, decision: "accepted" },
    });
    expectOk(denied.status === 403, denied.json, "非项目成员的团队成员应 403（修复前可跨项目审核）");
    const ok = await call("POST", `/proposals/${proposalId}/review`, {
      session: admin, body: { teamId, decision: "accepted", note: "通过" },
    });
    expectOk(ok.status === 200 && ok.json.status === "accepted", ok.json, "项目成员（lead/admin）应可审核");
  });

  it("⑤releases 先鉴权后回放：已缓存的幂等键不能让非 admin 重放发布回执", async () => {
    const key = `m72-idem-${N}`;
    // 造「该成员自己的历史发布缓存」（修复前：回放先于权限 → 200 replayed）
    await seedInTeam(teamId, async (c) => {
      await c.query(
        `INSERT INTO idempotency_keys (team_id, actor_id, scope, key, response_code, response_body)
         VALUES ($1,$2,'review-and-publish',$3,200,$4)`,
        [teamId, memberUserId, key, JSON.stringify({ fake: "cached-release" })]
      );
    });
    const r1 = await call("POST", `/change-requests/nonexistent/review-and-publish`, {
      session: member,
      headers: { "idempotency-key": key },
      body: { teamId, expectedReviewDigest: "0".repeat(64) },
    });
    expectOk(r1.status === 403, r1.json, "非 admin 带已缓存键应 403（修复前回放 200）");
    const cached = await seedInTeam(teamId, async (c) => {
      const { rows } = await c.query(`SELECT 1 FROM idempotency_keys WHERE team_id = $1 AND actor_id = $2 AND key = $3 AND scope = 'review-and-publish'`, [teamId, memberUserId, key]);
      return rows.length;
    });
    expectOk(cached === 1, cached, "403 不应清除/写入幂等键（键仍只是不被回放）");
  });

  it("⑥弃用自继守卫：successorRef 解析命中自身（名称/别名）→ 409 SUCCESSOR_SELF", async () => {
    const typeReg = await call("POST", "/types", {
      session: admin,
      body: { teamId, typeKey: `m72.self.${N}`, version: "1.0.0", title: "M72自继", jsonSchema: { type: "object", properties: {} } },
    });
    const name = `自继资产-${N}`;
    const a = await call("POST", "/assets", { session: admin, body: { teamId, name, typeVersionId: typeReg.json.typeVersionId, properties: {} } });
    const assetId = a.json.assetId as string;
    await call("POST", `/assets/${assetId}/aliases`, { session: admin, body: { teamId, alias: `selfalias-${N}` } });
    const byName = await call("POST", `/assets/${assetId}/deprecate`, {
      session: admin, body: { teamId, note: "试图自己继任自己", successorRef: name },
    });
    expectOk(byName.status === 409 && byName.json.error?.code === "SUCCESSOR_SELF", byName.json, "自身名称解析应 409（修复前 UUID 比对恒假被绕过）");
    const byAlias = await call("POST", `/assets/${assetId}/deprecate`, {
      session: admin, body: { teamId, note: "别名路径同样拦截", successorRef: `selfalias-${N}` },
    });
    expectOk(byAlias.status === 409 && byAlias.json.error?.code === "SUCCESSOR_SELF", byAlias.json, "自身别名解析应 409");
    // 资产未被误弃用
    const det = await call("GET", `/assets/${assetId}?teamId=${teamId}`, { session: admin });
    expectOk(det.json.lifecycle === "active", det.json.lifecycle, "被拦截的弃用不应落库");
  });

  it("⑦重复添加团队成员 → 409 MEMBER_EXISTS（修复前 500）", async () => {
    const dup = await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m72-member-${runId}@t.dev`, role: "member" } });
    expectOk(dup.status === 409 && dup.json.error?.code === "MEMBER_EXISTS", dup.json, "重复添加应 409");
  });

  it("⑧lead 基线通道复活：非 admin 的项目创建者（lead）可建基线；纯成员仍 403", async () => {
    // member 建自己的项目 → 自动成为该项目 lead（非团队 admin）
    const p2 = await call("POST", "/projects", { session: member, body: { teamId, name: `M72成员项目-${runId}`, code: `m72b${N}` } });
    expectOk(p2.status === 201, p2.json, "成员建项目失败");
    const bl = await call("POST", `/projects/${p2.json.projectId}/requirement-baseline`, {
      session: member, body: { teamId, name: `M72Lead基线-${N}` },
    });
    expectOk(bl.status === 201, bl.json, "lead（非团队 admin）应可建基线（修复前恒 403 死代码）");
    // 纯成员（非任何 lead）对 admin 的项目建基线仍 403
    const denied = await call("POST", `/projects/${projectId}/requirement-baseline`, {
      session: member, body: { teamId, name: "越权基线" },
    });
    expectOk(denied.status === 403, denied.json, "非 lead 成员仍应 403");
  });

  it("⑨messages 并发 seq：advisory lock 串行化——10 条并发全 201 且 seq 互异", async () => {
    const posts = Array.from({ length: 10 }, (_, i) =>
      call("POST", `/sessions/${sessionId}/messages`, {
        session: admin, body: { teamId, role: "user", content: `并发消息 ${i}-${N}` },
      })
    );
    const rs = await Promise.all(posts);
    const allOk = rs.every((r) => r.status === 201);
    const seqs = rs.map((r) => (r.json as { seq: number }).seq).sort((x, y) => x - y);
    expectOk(allOk, rs.map((r) => r.status), "并发写消息应全部成功（无唯一约束 500）");
    expectOk(new Set(seqs).size === 10, seqs, "seq 应互不相同（advisory lock 串行化分配）");
  });

  it("⑩登录失败限速：同 (ip,email) 连败 10 次后 429；其他邮箱不受影响（放最后避免干扰）", async () => {
    const email = `m72-lockout-${runId}@t.dev`;
    // 先注册一个真实账号（密码正确也应在锁死后被拒）
    const reg = await fetch(`${BASE}/auth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password-123", displayName: "M72限速", teamName: `M72限速团队-${runId}` }),
    });
    expectOk(reg.status === 201, null, "注册失败");
    for (let i = 0; i < 10; i++) {
      const r = await call("POST", "/auth/login", { body: { email, password: "wrong-password" } });
      expectOk(r.status === 401, r.status, `第 ${i + 1} 次失败应 401`);
    }
    const locked = await call("POST", "/auth/login", { body: { email, password: "password-123" } });
    expectOk(locked.status === 429 && locked.json.error?.code === "RATE_LIMITED", locked.json, "正确密码也应 429（锁死窗口）");
    const other = await call("POST", "/auth/login", { body: { email: `m72-admin-${runId}@t.dev`, password: "password-123" } });
    expectOk(other.status === 200, other.status, "其他邮箱不受同 IP 影响");
  });
});
