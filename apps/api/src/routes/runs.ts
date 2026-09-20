// /api/v1/runs — Agent 运行：创建（预算/幂等）、SSE 可续接事件流、取消、恢复。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { executeRun, requestCancel } from "../agent/runner.js";
import { DeepSeekProvider, LlmError } from "@taw/agent-adapter/deepseek";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "blocked", "unknown_reconcile"]);

export async function runRoutes(app: FastifyInstance): Promise<void> {
  app.post("/sessions/:sessionId/runs", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        prompt: z.string().min(1).max(8000),
        contextRefs: z.array(z.string().max(400)).max(20).default([]),
        budget: z
          .object({ maxToolCalls: z.number().int().min(1).max(50).default(8), maxTokens: z.number().int().min(200).max(200000).default(20000) })
          .partial()
          .default({}),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);

    // 真实模型连接：未配置时直接拒绝（不提供 mock 答复，D01 边界）
    try {
      new DeepSeekProvider();
    } catch (err) {
      throw new (await import("../errors.js")).AppError(
        (err as LlmError).code ?? "LLM_NOT_CONFIGURED",
        503,
        (err as Error).message,
        true
      );
    }

    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows: sess } = await client.query<{ created_by: string; visibility: string; project_id: string }>(
        `SELECT created_by, visibility, project_id FROM sessions WHERE team_id = $1 AND id = $2`,
        [body.teamId, sessionId]
      );
      if (!sess[0]) throw ERR.NOT_FOUND();
      if (sess[0].visibility === "private" && sess[0].created_by !== auth.userId) throw ERR.FORBIDDEN();
      await client.query(
        `INSERT INTO agent_runs (team_id, id, session_id, project_id, prompt, context_refs, allowed_tools, budget, model_provider, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'deepseek',$9)`,
        [body.teamId, id, sessionId, sess[0].project_id, body.prompt,
         JSON.stringify(body.contextRefs),
         JSON.stringify(["asset.search", "asset.getRevision", "relation.query", "issue.create", "proposal.create", "external.notify"]),
         JSON.stringify(body.budget), auth.userId]
      );
      await client.query(
        `INSERT INTO messages (team_id, id, session_id, role, content, seq)
         SELECT $1, $2, $3, 'user', $4, COALESCE(MAX(seq), 0) + 1 FROM messages WHERE team_id = $1 AND session_id = $3`,
        [body.teamId, randomUUID(), sessionId, body.prompt]
      );
      // 恢复索引：执行器崩溃后由此定位 team（见 runner.readTeamIdBypassingRls）
      await client.query(
        `INSERT INTO run_team_index (run_id, team_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, body.teamId]
      );
    });
    executeRun(id);
    return reply.code(201).send({ teamId: body.teamId, runId: id, status: "queued" });
  });

  app.get("/runs/:runId", async (req) => {
    const auth = requireAuth(req);
    const { runId } = req.params as { runId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, session_id, status, prompt, budget, used, result, error, model_provider, created_at, updated_at
           FROM agent_runs WHERE team_id = $1 AND id = $2`,
        [teamId, runId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const { rows: invocations } = await client.query(
        `SELECT call_id, name, args, result, status, error, created_at FROM tool_invocations
          WHERE team_id = $1 AND run_id = $2 ORDER BY created_at`,
        [teamId, runId]
      );
      return { ...rows[0], invocations };
    });
  });

  // 会话级运行历史：界面重建对话中的 Agent 运行（含工具调用轨迹）
  app.get("/sessions/:sessionId/runs", async (req) => {
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: sess } = await client.query(
        `SELECT 1 FROM sessions WHERE team_id = $1 AND id = $2`,
        [teamId, sessionId]
      );
      if (!sess[0]) throw ERR.NOT_FOUND();
      const { rows: runs } = await client.query(
        `SELECT id, status, prompt, result, error, used, created_at
           FROM agent_runs WHERE team_id = $1 AND session_id = $2 ORDER BY created_at DESC LIMIT 20`,
        [teamId, sessionId]
      );
      const runIds = runs.map((r) => r.id);
      const { rows: invocations } = await client.query(
        `SELECT run_id, call_id, name, args, result, status, error, created_at
           FROM tool_invocations WHERE team_id = $1 AND run_id = ANY($2::uuid[]) ORDER BY created_at`,
        [teamId, runIds]
      );
      return runs.map((r) => ({
        ...r,
        invocations: invocations.filter((i: { run_id: string }) => i.run_id === r.id),
      }));
    });
  });

  // SSE 可续接：Last-Event-ID 之后继续，事件已落库；断线重连不重触发任务
  app.get("/runs/:runId/events", async (req, reply) => {
    const auth = requireAuth(req);
    const { runId } = req.params as { runId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const lastHeader = req.headers["last-event-id"];
    const lastEventId = Number(
      (req.query as { lastEventId?: string } | null)?.lastEventId ??
      (typeof lastHeader === "string" ? lastHeader : 0) ?? 0
    );

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    reply.raw.write(`retry: 1000\n\n`);
    let cursor = Number(lastEventId) || 0;
    const open = { closed: false };
    req.raw.on("close", () => { open.closed = true; });
    const push = (seq: number, type: string, payload: unknown) => {
      reply.raw.write(`id: ${seq}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    // 先重放历史
    let history = await withTeam(teamId, async (client) =>
      client.query<{ seq: string; type: string; payload: unknown }>(
        `SELECT seq, type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND seq > $3 ORDER BY seq`,
        [teamId, runId, cursor]
      )
    );
    for (const row of history.rows) {
      push(Number(row.seq), row.type, row.payload);
      cursor = Number(row.seq);
    }

    // 轮询新事件直至运行结束且事件取尽
    while (!open.closed) {
      const state = await withTeam(teamId, async (client) => {
        const ev = await client.query<{ seq: string; type: string; payload: unknown }>(
          `SELECT seq, type, payload FROM run_events WHERE team_id = $1 AND run_id = $2 AND seq > $3 ORDER BY seq`,
          [teamId, runId, cursor]
        );
        const { rows: runRows } = await client.query<{ status: string }>(
          `SELECT status FROM agent_runs WHERE team_id = $1 AND id = $2`,
          [teamId, runId]
        );
        return { events: ev.rows, status: runRows[0]?.status ?? "unknown" };
      });
      for (const row of state.events) {
        push(Number(row.seq), row.type, row.payload);
        cursor = Number(row.seq);
      }
      if (state.events.length === 0 && TERMINAL.has(state.status)) {
        reply.raw.write(`event: done\ndata: {"status":"${state.status}"}\n\n`);
        break;
      }
      if (state.events.length === 0) {
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    reply.raw.end();
  });

  app.post("/runs/:runId/cancel", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { runId } = req.params as { runId: string };
    const body = parseBody(z.object({ teamId: z.string().uuid(), reason: z.string().max(500).default("") }), req.body);
    await teamRole(auth.userId, body.teamId);
    const { rows: run } = await withTeam(body.teamId, async (client) =>
      client.query<{ status: string; created_by: string }>(
        `SELECT status, created_by FROM agent_runs WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, runId]
      )
    );
    if (!run[0]) throw ERR.NOT_FOUND();
    // 创建人或被授权操作人（管理员）可取消
    if (run[0].created_by !== auth.userId) {
      const role = await teamRole(auth.userId, body.teamId);
      if (role !== "admin") throw ERR.FORBIDDEN();
    }
    if (TERMINAL.has(run[0].status)) {
      return reply.code(409).send({ error: { code: "ALREADY_TERMINAL", message: `运行已结束（${run[0].status}）`, retryable: false } });
    }
    requestCancel(body.teamId, runId);
    return { ok: true, requested: "cancel" };
  });

  // 恢复：崩溃/断线后检查运行，未知状态进对账，不盲目重跑
  app.post("/runs/:runId/recover", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { runId } = req.params as { runId: string };
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    const out = await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ status: string; error: string }>(
        `SELECT status, error FROM agent_runs WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, runId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const run = rows[0];
      if (run.status === "running" || run.status === "queued") {
        // 执行器失联（崩溃/进程消失）→ 未知状态对账；不重新触发
        await client.query(
          `UPDATE agent_runs SET status = 'unknown_reconcile', error = $3, updated_at = now() WHERE team_id = $1 AND id = $2`,
          [body.teamId, runId, "执行器失联（恢复检查时仍在运行态），副作用需对账"]
        );
        const { rows: ev } = await client.query<{ seq: string }>(
          `SELECT MAX(seq) AS seq FROM run_events WHERE team_id = $1 AND run_id = $2`,
          [body.teamId, runId]
        );
        return { status: "unknown_reconcile", lastEventSeq: Number(ev[0]?.seq ?? 0), requeued: false };
      }
      return { status: run.status, requeued: false, note: run.status === "unknown_reconcile" ? run.error : "运行已终结，无需恢复" };
    });
    return out;
  });
}
