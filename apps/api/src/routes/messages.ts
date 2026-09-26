// /api/v1/sessions/:sessionId/messages — 会话消息（M1 存取；M4 接入 Agent 回复）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

export async function messageRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions/:sessionId/messages", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), role: z.enum(["user", "system"]).default("user"), content: z.string().min(1).max(16000) }),
      req.body
    );
    // 响应必须在事务提交之后发出：在 withTeam 处理器内调用 reply.send() 会让
    // Fastify 立即开始响应（不等 COMMIT），紧跟着的读请求可能读不到刚写入的行
    // （read-your-writes 竞态，C08 含密分享检查曾因此偶发漏检）。
    const created = await withTeam(body.teamId, async (client) => {
      const { rows: sess } = await client.query<{ created_by: string; visibility: string }>(
        `SELECT created_by, visibility FROM sessions WHERE team_id = $1 AND id = $2`,
        [body.teamId, sessionId]
      );
      if (!sess[0]) throw ERR.NOT_FOUND();
      if (sess[0].visibility === "private" && sess[0].created_by !== auth.userId) throw ERR.FORBIDDEN();
      const { rows: last } = await client.query<{ seq: string }>(
        `SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE team_id = $1 AND session_id = $2`,
        [body.teamId, sessionId]
      );
      const id = newId();
      const seq = Number(last[0]!.seq) + 1;
      await client.query(
        `INSERT INTO messages (team_id, id, session_id, role, content, seq) VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.teamId, id, sessionId, body.role, body.content, seq]
      );
      return { messageId: id, seq };
    });
    return reply.code(201).send(created);
  });

  app.get("/sessions/:sessionId/messages", async (req) => {
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    return withTeam(teamId, async (client) => {
      const { rows: sess } = await client.query<{ created_by: string; visibility: string }>(
        `SELECT created_by, visibility FROM sessions WHERE team_id = $1 AND id = $2`,
        [teamId, sessionId]
      );
      const s = sess[0];
      if (!s) throw ERR.NOT_FOUND();
      if (s.visibility === "private" && s.created_by !== auth.userId) throw ERR.FORBIDDEN();
      const { rows: msgs } = await client.query(
        `SELECT id, role, content, seq, created_at FROM messages
          WHERE team_id = $1 AND session_id = $2 ORDER BY seq`,
        [teamId, sessionId]
      );
      return msgs;
    });
  });
}
