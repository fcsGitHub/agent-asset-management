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
    const { rows } = await q<{ id: string; password_hash: string; is_active: boolean }>(
      `SELECT id, password_hash, is_active FROM users WHERE email = $1`,
      [body.email]
    );
    const user = rows[0];
    if (!user || !user.is_active || !verifyPassword(body.password, user.password_hash)) {
      throw ERR.UNAUTHORIZED();
    }
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
    await q(`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`, [
      teamId,
      user[0].id,
      body.role,
    ]);
    return reply.code(201).send({ teamId, userId: user[0].id, role: body.role });
  });
}
