// 认证：scrypt 口令散列 + 服务端会话（auth_sessions）+ HttpOnly Cookie + CSRF 双提交。
// 设计 16 章：登录后直接使用；退出/移除使服务端会话失效。
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { q } from "./db.js";
import { ERR } from "./errors.js";

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const SESSION_COOKIE = "taw_session";
export const CSRF_COOKIE = "taw_csrf";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(":");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
}

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

export function newId(): string {
  return randomUUID();
}

export function csrfToken(): string {
  return createHash("sha256").update(randomBytes(32)).digest("hex").slice(0, 40);
}

export async function createAuthSession(userId: string): Promise<string> {
  const id = newId();
  await q(
    `INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`,
    [id, userId]
  );
  return id;
}

export async function revokeAuthSession(sessionId: string): Promise<void> {
  await q(`UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [
    sessionId,
  ]);
}

export async function loadAuth(req: FastifyRequest): Promise<void> {
  const cookie = (req.headers.cookie ?? "") as string;
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([a-f0-9-]+)`));
  req.auth = undefined;
  if (!match) return;
  const sessionId = match[1] as string;
  const { rows } = await q<{
    user_id: string;
    email: string;
    display_name: string;
  }>(
    `SELECT s.user_id, u.email, u.display_name
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
    [sessionId]
  );
  if (rows.length === 1) {
    const row = rows[0]!;
    req.auth = {
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      sessionId,
    };
  }
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw ERR.UNAUTHORIZED();
  return req.auth;
}

/** 变更请求的 CSRF 校验：头 x-csrf-token 必须匹配 cookie。登录/注册豁免。 */
export function checkCsrf(req: FastifyRequest): void {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const cookie = (req.headers.cookie ?? "") as string;
  const m = cookie.match(new RegExp(`${CSRF_COOKIE}=([a-f0-9]+)`));
  const header = req.headers["x-csrf-token"];
  if (!m || typeof header !== "string" || m[1] !== header) {
    throw ERR.CSRF();
  }
}

export function setAuthCookies(reply: FastifyReply, sessionId: string, csrf: string): void {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  reply.header(
    "set-cookie",
    [
      `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${SESSION_TTL_MS / 1000}`,
      `${CSRF_COOKIE}=${csrf}; Path=/; SameSite=Lax${secure}; Max-Age=${SESSION_TTL_MS / 1000}`,
    ]
  );
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    [
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      `${CSRF_COOKIE}=; Path=/; SameSite=Lax; Max-Age=0`,
    ]
  );
}
