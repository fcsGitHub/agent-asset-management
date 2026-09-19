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
    return withTeam(body.teamId, async (client) => {
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
      await client.query(
        `INSERT INTO messages (team_id, id, session_id, role, content, seq) VALUES ($1, $2, $3, $4, $5, $6)`,
        [body.teamId, id, sessionId, body.role, body.content, Number(last[0]!.seq) + 1]
      );
      return reply.code(201).send({ messageId: id, seq: Number(last[0]!.seq) + 1 });
    });
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
