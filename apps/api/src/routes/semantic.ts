// /api/v1/semantic — 语义能力代理（设计 19 章）。
// worker 故障时明确 503 DEPENDENCY_UNAVAILABLE；核心资产流程不依赖本路由（D09）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

function workerUrl(): string {
  return process.env.SEMANTIC_WORKER_URL ?? "http://127.0.0.1:8100";
}

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

export async function semanticRoutes(app: FastifyInstance): Promise<void> {
  app.post("/semantic/extract", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        revisionRef: z.string().min(3).max(200),
        text: z.string().min(1).max(60000),
        entityHints: z.array(z.object({ text: z.string().min(1).max(100), label: z.string().min(1).max(40).default("ENTITY") })).max(50).default([]),
        // true 时 worker 叠加真实 LLM 候选（仍是候选，需人工确认）
        enhanceLlm: z.boolean().default(false),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    try {
      const res = await fetch(`${workerUrl()}/extract_candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          revision_ref: body.revisionRef,
          text: body.text,
          entity_hints: body.entityHints.map((h) => ({ text: h.text, label: h.label })),
          enhance_llm: body.enhanceLlm,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) {
        throw ERR.DEPENDENCY(`语义 worker 返回 HTTP ${res.status}`);
      }
      return reply.code(200).send(await res.json());
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      throw ERR.DEPENDENCY("语义 worker 不可达（语义增强降级；核心流程不受影响）");
    }
  });

  app.post("/semantic/validate", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        candidates: z.array(z.object({
          entityId: z.string().min(1),
          name: z.string().min(1),
          properties: z.object({}).passthrough().default({}),
          relationType: z.string().optional(),
          targetName: z.string().optional(),
        })).max(200),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    try {
      const res = await fetch(`${workerUrl()}/validate_candidates`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidates: body.candidates.map((c) => ({
            entity_id: c.entityId, name: c.name, properties: c.properties,
            relation_type: c.relationType ?? null, target_name: c.targetName ?? null,
          })),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw ERR.DEPENDENCY(`语义 worker 返回 HTTP ${res.status}`);
      return reply.code(200).send(await res.json());
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      throw ERR.DEPENDENCY("语义 worker 不可达（语义增强降级；核心流程不受影响）");
    }
  });
}
