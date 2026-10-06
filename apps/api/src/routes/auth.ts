// /api/v1/auth — 注册/登录/登出/当前用户。
// 首个注册用户创建团队并成为管理员；后续成员由管理员添加（设计 16 章）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q, withTx } from "../db.js";
import { ERR } from "../errors.js";
import {
  checkCsrf,
  clearAuthCookies,
  createAuthSession,
  csrfToken,
  hashPassword,
  newId,
  requireAuth,
  revokeAuthSession,
  setAuthCookies,
  verifyPassword,
} from "../auth.js";

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(64),
  teamName: z.string().min(1).max(64),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

// 登录失败限速（M72，OWASP Authentication Cheat Sheet 防爆破锚点）：进程内滑动窗，
// 键 = 请求 IP + 邮箱小写（同 IP 下不同账号互不影响）。诚实边界：单实例内存态，
// 多实例部署需共享存储（Redis 等）——与 activityHub 实时通道同口径，不做分布式声称。
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_FAILURES = 10;
const loginFailures = new Map<string, { n: number; resetAt: number }>();
const loginFailKey = (ip: string, email: string) => `${ip}|${email.trim().toLowerCase()}`;

function loginThrottled(key: string): boolean {
  const rec = loginFailures.get(key);
  if (!rec) return false;
  if (rec.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return rec.n >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(key: string): void {
  const rec = loginFailures.get(key);
  if (!rec || rec.resetAt <= Date.now()) {
    loginFailures.set(key, { n: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
    return;
  }
  rec.n += 1;
}

export function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw ERR.INVALID("请求体不满足约束", result.error.flatten());
  }
  return result.data;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/register", { config: { exemptAuth: true } }, async (req, reply) => {
    const body = parseBody(registerSchema, req.body);
    const exists = await q(`SELECT 1 FROM users WHERE email = $1`, [body.email]);
    if (exists.rowCount) throw ERR.CONFLICT("EMAIL_TAKEN", "该邮箱已注册");
    const userId = newId();
    const teamId = newId();

    // 注册跨 users/teams/team_members；三张全局表同一事务。
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, $3, $4)`,
        [userId, body.email, body.displayName, hashPassword(body.password)]
      );
      await client.query(`INSERT INTO teams (id, name) VALUES ($1, $2)`, [teamId, body.teamName]);
      await client.query(
        `INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin')`,
        [teamId, userId]
      );
      // 团队治理设置默认行：单人例外等开关的文档化 UPDATE 路径依赖该行存在。
      // team_settings 是租户 RLS 表，先在本事务内建立租户上下文再插入。
      await client.query(`SELECT set_config('app.team_id', $1, true)`, [teamId]);
      await client.query(
        `INSERT INTO team_settings (team_id) VALUES ($1) ON CONFLICT (team_id) DO NOTHING`,
        [teamId]
      );
    });

    const sessionId = await createAuthSession(userId);
    setAuthCookies(reply, sessionId, csrfToken());
    return reply.code(201).send({ userId, teamId, email: body.email, displayName: body.displayName });
  });

  app.post("/auth/login", { config: { exemptAuth: true } }, async (req, reply) => {
    const body = parseBody(loginSchema, req.body);
    const failKey = loginFailKey(req.ip ?? "unknown", body.email);
    if (loginThrottled(failKey)) {
      throw ERR.TOO_MANY("登录失败次数过多，请 15 分钟后再试");
    }
    const { rows } = await q<{ id: string; password_hash: string; is_active: boolean }>(
      `SELECT id, password_hash, is_active FROM users WHERE email = $1`,
      [body.email]
    );
    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      recordLoginFailure(failKey);
      throw ERR.UNAUTHORIZED();
    }
    loginFailures.delete(failKey); // 成功登录清零计数（正常用户偶失手不被累积锁死）
    const sessionId = await createAuthSession(user.id);
    setAuthCookies(reply, sessionId, csrfToken());
    return { userId: user.id, email: body.email };
  });

  app.post("/auth/logout", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    await revokeAuthSession(auth.sessionId);
    clearAuthCookies(reply);
    return { ok: true };
  });

  app.get("/auth/me", async (req) => {
    const auth = requireAuth(req);
    const { rows } = await q<{ team_id: string; role: string; name: string }>(
      `SELECT tm.team_id, tm.role, t.name
         FROM team_members tm JOIN teams t ON t.id = tm.team_id
        WHERE tm.user_id = $1 ORDER BY tm.team_id`,
      [auth.userId]
    );
    return {
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      teams: rows.map((r) => ({ teamId: r.team_id, role: r.role, name: r.name })),
    };
  });

  // 管理员添加已有用户为本团队成员
  app.post("/teams/:teamId/members", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { teamId } = req.params as { teamId: string };
    const body = parseBody(z.object({ email: z.string().email(), role: z.enum(["member", "admin"]).default("member") }), req.body);
    const { rows: teamRole } = await q<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, auth.userId]
    );
    if (!teamRole[0] || teamRole[0].role !== "admin") throw ERR.FORBIDDEN();
    const { rows: user } = await q<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [
      body.email,
    ]);
    if (!user[0]) throw ERR.NOT_FOUND();
    try {
      await q(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
        teamId,
        user[0].id,
        body.role,
      ]);
    } catch (err) {
      // 并发/重复添加：团队内 (team_id, user_id) 唯一——报 409 契约而非 500 INTERNAL
      if ((err as { code?: string }).code === "23505") {
        throw ERR.CONFLICT("MEMBER_EXISTS", "该用户已是团队成员");
      }
      throw err;
    }
    return reply.code(201).send({ teamId, userId: user[0].id, role: body.role });
  });
}
