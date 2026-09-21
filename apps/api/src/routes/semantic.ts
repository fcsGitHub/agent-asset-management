// /api/v1/semantic — 语义能力代理（设计 19 章）。
// worker 故障时明确 503 DEPENDENCY_UNAVAILABLE；核心资产流程不依赖本路由（D09）。
// 候选审核队列（0020）：抽取是纯分析；用户显式"入队"后候选持久化，
// 团队任何成员都可映射端点并确认（走与 POST /relations 完全相同的断言路径）或忽略。
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { z } from "zod";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { createRelationAssertion } from "./catalog.js";

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

  // ---------- 候选审核队列（0020） ----------

  const candidateImportSchema = z.object({
    teamId: z.string().uuid(),
    assetId: z.string().uuid(),
    revisionId: z.string().uuid().optional(),
    candidates: z.array(z.object({
      relationType: z.string().min(1).max(64),
      sourceText: z.string().min(1).max(300),
      sourceStart: z.number().int().min(0).default(0),
      sourceEnd: z.number().int().min(0).default(0),
      targetText: z.string().min(1).max(300),
      targetStart: z.number().int().min(0).default(0),
      targetEnd: z.number().int().min(0).default(0),
      evidenceSegment: z.string().max(2000).default(""),
      confidence: z.number().min(0).max(1).default(0),
      llmProposed: z.boolean().default(false),
      extractorVersion: z.string().max(120).default(""),
    })).min(1).max(50),
  });

  app.post("/semantic/candidates/import", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(candidateImportSchema, req.body);
    await teamRole(auth.userId, body.teamId);
    const ids: string[] = [];
    const duplicateIndexes: number[] = [];
    await withTeam(body.teamId, async (client) => {
      const plan = await planImport(client, body.teamId, body.assetId, body.candidates);
      for (let i = 0; i < body.candidates.length; i++) {
        if (!plan[i]!.importable) {
          duplicateIndexes.push(i);
          continue;
        }
        const c = body.candidates[i]!;
        const id = newId();
        await client.query(
          `INSERT INTO semantic_candidates (team_id, id, asset_id, revision_id, relation_type,
             source_text, source_start, source_end, target_text, target_start, target_end,
             evidence_segment, confidence, llm_proposed, extractor_version, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [body.teamId, id, body.assetId, body.revisionId ?? null, c.relationType,
            c.sourceText, c.sourceStart, c.sourceEnd, c.targetText, c.targetStart, c.targetEnd,
            c.evidenceSegment, c.confidence, c.llmProposed, c.extractorVersion, auth.userId]
        );
        ids.push(id);
      }
    });
    return reply.code(201).send({
      teamId: body.teamId,
      imported: ids.length,
      skipped: duplicateIndexes.length,
      candidateIds: ids,
      duplicateIndexes,
    });
  });

  // 入队预演（M23）：与真实入队共用 planImport 判定核心，只判不写——
  // 供入队前展示"哪些会入队、哪些会因队列已有/批内重复被跳过"。
  // 预演基于当前队列状态，真实入队以服务端逐条回执为准。
  app.post("/semantic/candidates/import/preview", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(candidateImportSchema, req.body);
    await teamRole(auth.userId, body.teamId);
    return withTeam(body.teamId, async (client) => {
      const plan = await planImport(client, body.teamId, body.assetId, body.candidates);
      const duplicates: Array<{ index: number; reason: "queue" | "batch"; relationType: string; sourceText: string; targetText: string }> = [];
      plan.forEach((p, i) => {
        if (!p.importable && p.reason) {
          const c = body.candidates[i]!;
          duplicates.push({ index: i, reason: p.reason, relationType: c.relationType, sourceText: c.sourceText, targetText: c.targetText });
        }
      });
      return reply.code(200).send({
        teamId: body.teamId,
        assetId: body.assetId,
        total: body.candidates.length,
        wouldImport: plan.filter((p) => p.importable).length,
        duplicates,
      });
    });
  });

  app.get("/semantic/candidates", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; status?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const status = query.status === "confirmed" || query.status === "dismissed" ? query.status : "pending";
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.relation_type, c.source_text, c.source_start, c.source_end,
                c.target_text, c.target_start, c.target_end, c.evidence_segment,
                c.confidence::float8 AS confidence, c.llm_proposed, c.extractor_version,
                c.status, c.created_at, u.display_name AS created_by_name,
                a.name AS asset_name
           FROM semantic_candidates c
           LEFT JOIN users u ON u.id = c.created_by
           LEFT JOIN assets a ON a.team_id = c.team_id AND a.id = c.asset_id
          WHERE c.team_id = $1 AND c.status = $2
          ORDER BY c.created_at DESC LIMIT 100`,
        [teamId, status]
      );
      return rows;
    });
  });

  app.post("/semantic/candidates/:candidateId/confirm", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { candidateId } = req.params as { candidateId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), sourceAssetId: z.string().uuid(), targetAssetId: z.string().uuid() }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    // 候选状态更新与关系断言同一事务：确认原子生效；断言违规时候选保持 pending
    const result = await withTeam(body.teamId, async (client) =>
      confirmCandidate(client, body.teamId, auth.userId, candidateId, body.sourceAssetId, body.targetAssetId)
    );
    return reply.code(200).send({ teamId: body.teamId, candidateId, ...result });
  });

  // 批量确认：逐条独立判定——一条失败（未注册类型、domain/range、成环等）不影响其他条目。
  // 每条用 SAVEPOINT 隔离，失败回滚到保存点后继续，结果逐条如实回执（部分成功不伪装全成功）。
  app.post("/semantic/candidates/batch-confirm", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        items: z.array(z.object({
          candidateId: z.string().uuid(),
          sourceAssetId: z.string().uuid(),
          targetAssetId: z.string().uuid(),
        })).min(1).max(50),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const results = await withTeam(body.teamId, async (client) => {
      const out: Array<{ candidateId: string; ok: boolean; relationId?: string; code?: string; message?: string }> = [];
      for (let i = 0; i < body.items.length; i++) {
        const item = body.items[i]!;
        const sp = `bc${i}`;
        await client.query(`SAVEPOINT ${sp}`);
        try {
          const r = await confirmCandidate(client, body.teamId, auth.userId, item.candidateId, item.sourceAssetId, item.targetAssetId);
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          out.push({ candidateId: item.candidateId, ok: true, relationId: r.relationId });
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
          const e = err as { code?: string; message?: string };
          out.push({ candidateId: item.candidateId, ok: false, code: e.code ?? "INTERNAL", message: e.message });
        }
      }
      return out;
    });
    return reply.code(200).send({
      teamId: body.teamId,
      confirmed: results.filter((r) => r.ok).length,
      results,
    });
  });

  app.post("/semantic/candidates/:candidateId/dismiss", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { candidateId } = req.params as { candidateId: string };
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    await teamRole(auth.userId, body.teamId);
    return withTeam(body.teamId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE semantic_candidates SET status = 'dismissed', decided_by = $3, decided_at = now()
          WHERE team_id = $1 AND id = $2 AND status = 'pending'`,
        [body.teamId, candidateId, auth.userId]
      );
      if (!rowCount) throw ERR.CONFLICT("CANDIDATE_NOT_PENDING", "候选不存在或已处理");
      return { teamId: body.teamId, candidateId, status: "dismissed" };
    });
  });

  // 批量忽略：同样逐条回执；已处理/不存在的条目如实标记，不中断其余条目
  app.post("/semantic/candidates/batch-dismiss", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        candidateIds: z.array(z.string().uuid()).min(1).max(50),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const results = await withTeam(body.teamId, async (client) => {
      const out: Array<{ candidateId: string; ok: boolean; code?: string }> = [];
      for (const candidateId of body.candidateIds) {
        const { rowCount } = await client.query(
          `UPDATE semantic_candidates SET status = 'dismissed', decided_by = $3, decided_at = now()
            WHERE team_id = $1 AND id = $2 AND status = 'pending'`,
          [body.teamId, candidateId, auth.userId]
        );
        out.push(rowCount ? { candidateId, ok: true } : { candidateId, ok: false, code: "CANDIDATE_NOT_PENDING" });
      }
      return out;
    });
    return reply.code(200).send({
      teamId: body.teamId,
      dismissed: results.filter((r) => r.ok).length,
      results,
    });
  });

  // 候选详情：全字段 + 决策留痕 + 已解析关系摘要（含 spans 与断言去向）
  app.get("/semantic/candidates/:candidateId", async (req) => {
    const auth = requireAuth(req);
    const { candidateId } = req.params as { candidateId: string };
    const query = (req.query ?? {}) as { teamId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.asset_id, c.revision_id, c.relation_type,
                c.source_text, c.source_start, c.source_end,
                c.target_text, c.target_start, c.target_end,
                c.evidence_segment, c.confidence::float8 AS confidence,
                c.llm_proposed, c.extractor_version, c.status,
                c.created_at, cu.display_name AS created_by_name,
                c.decided_at, du.display_name AS decided_by_name,
                c.resolved_relation_id,
                a.name AS asset_name,
                rtv.type_key AS resolved_type_key, rtv.version AS resolved_type_version
           FROM semantic_candidates c
           LEFT JOIN users cu ON cu.id = c.created_by
           LEFT JOIN users du ON du.id = c.decided_by
           LEFT JOIN assets a ON a.team_id = c.team_id AND a.id = c.asset_id
           LEFT JOIN relation_assertions r ON r.team_id = c.team_id AND r.id = c.resolved_relation_id
           LEFT JOIN relation_type_versions rtv ON rtv.team_id = c.team_id AND rtv.id = r.relation_type_version_id
          WHERE c.team_id = $1 AND c.id = $2`,
        [teamId, candidateId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      return rows[0];
    });
  });

  // 受控单位词表（语义结构校验的同源定义）：worker 不可达时如实 503
  app.get("/semantic/units", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    try {
      const res = await fetch(`${workerUrl()}/units`, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw ERR.DEPENDENCY(`语义 worker 返回 HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if ((err as { code?: string }).code) throw err;
      throw ERR.DEPENDENCY("语义 worker 不可达（单位词表暂不可用；核心流程不受影响）");
    }
  });
}

/** 共享确认核心：候选锁 + 状态机 + 关系类型解析 + 断言（同一事务内执行）。
 *  单条端点与批量端点共用；抛出的 AppError 由调用方决定 HTTP 语义或逐条回执。 */
async function confirmCandidate(
  client: PoolClient,
  teamId: string,
  userId: string,
  candidateId: string,
  sourceAssetId: string,
  targetAssetId: string
): Promise<{ relationId: string }> {
  const { rows: cand } = await client.query<{
    id: string; relation_type: string; extractor_version: string; evidence_segment: string; status: string;
  }>(
    `SELECT id, relation_type, extractor_version, evidence_segment, status FROM semantic_candidates
      WHERE team_id = $1 AND id = $2 FOR UPDATE`,
    [teamId, candidateId]
  );
  const cand0 = cand[0];
  if (!cand0) throw ERR.NOT_FOUND();
  if (cand0.status !== "pending") throw ERR.CONFLICT("CANDIDATE_NOT_PENDING", `候选已处于 ${cand0.status} 状态`);
  // 关系类型：候选 type 键 → 最新版本
  const { rows: rt } = await client.query<{ id: string }>(
    `SELECT id FROM relation_type_versions WHERE team_id = $1 AND type_key = $2
      ORDER BY created_at DESC LIMIT 1`,
    [teamId, cand0.relation_type]
  );
  if (!rt[0]) {
    throw ERR.CONFLICT("RELATION_TYPE_UNREGISTERED", `关系类型 ${cand0.relation_type} 未注册，请先在本体治理台登记`);
  }
  const assertion = await createRelationAssertion(teamId, userId, {
    relationTypeVersionId: rt[0].id,
    sourceAssetId,
    targetAssetId,
    confirm: true,
    evidenceNote: `语义候选确认（${cand0.extractor_version || "semantic"}）${cand0.evidence_segment ? `：${cand0.evidence_segment.slice(0, 200)}` : ""}`,
  }, client);
  await client.query(
    `UPDATE semantic_candidates SET status = 'confirmed', decided_by = $3, decided_at = now(),
       resolved_relation_id = $4 WHERE team_id = $1 AND id = $2`,
    [teamId, candidateId, userId, assertion.relationId]
  );
  return assertion;
}

/** 共享入队预演核心（M23）：入队端点与预演端点同源判定，杜绝预演与真实入队口径漂移。
 *  队列卫生（M21）：同（类型 + 端点文本）已有 pending/confirmed 候选跳过（reason=queue）；
 *  dismissed 不算——被否决过的候选允许重新入队重审。
 *  批内重复（reason=batch）：同批前序可入队条目占用去重键——真实入队同事务内
 *  后条的去重 SELECT 能看到前条未提交的插入，预演必须以批内记忆补齐同一口径。 */
async function planImport(
  client: PoolClient,
  teamId: string,
  assetId: string,
  candidates: Array<{ relationType: string; sourceText: string; targetText: string }>
): Promise<Array<{ importable: boolean; reason: "queue" | "batch" | null }>> {
  const { rows: asset } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [
    teamId, assetId,
  ]);
  if (!asset[0]) throw ERR.INVALID("来源资产不存在于本团队");
  const seen = new Set<string>();
  const plan: Array<{ importable: boolean; reason: "queue" | "batch" | null }> = [];
  for (const c of candidates) {
    const { rows: dup } = await client.query(
      `SELECT 1 FROM semantic_candidates
        WHERE team_id = $1 AND relation_type = $2 AND source_text = $3 AND target_text = $4
          AND status IN ('pending','confirmed')
        LIMIT 1`,
      [teamId, c.relationType, c.sourceText, c.targetText]
    );
    if (dup[0]) {
      plan.push({ importable: false, reason: "queue" });
      continue;
    }
    const key = `${c.relationType}\u0000${c.sourceText}\u0000${c.targetText}`;
    if (seen.has(key)) {
      plan.push({ importable: false, reason: "batch" });
      continue;
    }
    seen.add(key);
    plan.push({ importable: true, reason: null });
  }
  return plan;
}
