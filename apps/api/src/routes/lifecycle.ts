// /api/v1 需求与项目闭环（设计 15 章）。
// 核心不变量：
// - 需求内容为不可变修订；基线是固定快照（C02）
// - 任务完成 ≠ 需求验收（C03）；验收绑定精确需求修订与测试运行
// - 测试证据只对被测摘要有效；修订变化 → 证据不匹配（C04）
// - 关键需求未验证/未豁免 → 结题门 blocked（C05）；豁免留痕可见
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { stableStringify } from "@taw/domain/digest";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

const GATES = [
  "requirements_intake",
  "requirements_baseline",
  "design",
  "dev_integration",
  "test_verify",
  "accept_release",
  "closure",
] as const;

export async function projectLifecycleRoutes(app: FastifyInstance): Promise<void> {
  // ---------- 需求 ----------
  app.post("/projects/:projectId/requirements", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        reqKey: z.string().regex(/^R-[A-Za-z0-9-]{1,31}$/),
        title: z.string().min(1).max(200),
        description: z.string().max(8000).default(""),
        acceptanceCriteria: z.string().max(8000).default(""),
        priority: z.enum(["must", "should", "could"]).default("should"),
        isKey: z.boolean().default(true),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const reqId = newId();
    const revId = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(`INSERT INTO entities (team_id, id, kind) VALUES ($1, $2, 'requirement')`, [
        body.teamId, reqId,
      ]);
      await client.query(
        `INSERT INTO requirements (team_id, id, project_id, req_key, title, priority, is_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [body.teamId, reqId, projectId, body.reqKey, body.title, body.priority, body.isKey, auth.userId]
      );
      const contentDigest = createHash("sha256")
        .update(stableStringify({ d: body.description, a: body.acceptanceCriteria }))
        .digest("hex");
      await client.query(
        `INSERT INTO requirement_revisions (team_id, id, requirement_id, seq, content, content_digest, created_by)
         VALUES ($1,$2,$3,1,$4,$5,$6)`,
        [body.teamId, revId, reqId, JSON.stringify({ description: body.description, acceptanceCriteria: body.acceptanceCriteria }), contentDigest, auth.userId]
      );
    });
    return reply.code(201).send({ requirementId: reqId, revisionId: revId });
  });

  app.post("/requirements/:requirementId/revisions", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { requirementId } = req.params as { requirementId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        description: z.string().max(8000).default(""),
        acceptanceCriteria: z.string().max(8000).default(""),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const revId = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows: last } = await client.query<{ seq: number }>(
        `SELECT MAX(seq) AS seq FROM requirement_revisions WHERE team_id = $1 AND requirement_id = $2`,
        [body.teamId, requirementId]
      );
      const contentDigest = createHash("sha256")
        .update(stableStringify({ d: body.description, a: body.acceptanceCriteria }))
        .digest("hex");
      await client.query(
        `INSERT INTO requirement_revisions (team_id, id, requirement_id, seq, content, content_digest, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [body.teamId, revId, requirementId, (last[0]?.seq ?? 0) + 1, JSON.stringify({ description: body.description, acceptanceCriteria: body.acceptanceCriteria }), contentDigest, auth.userId]
      );
    });
    return reply.code(201).send({ revisionId: revId });
  });

  app.post("/projects/:projectId/requirement-baseline", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), name: z.string().min(1).max(128) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") {
      // 项目负责人也可建基线：检查 project lead
      const { rows: lead } = await q(`SELECT 1 FROM project_members WHERE team_id = $1 AND project_id = $2 AND user_id = $3 AND role = 'lead'`, [body.teamId, projectId, auth.userId]);
      if (!lead[0]) throw ERR.FORBIDDEN();
    }
    const baselineId = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(
        `INSERT INTO requirement_baselines (team_id, id, project_id, name, created_by) VALUES ($1,$2,$3,$4,$5)`,
        [body.teamId, baselineId, projectId, body.name, auth.userId]
      );
      // 快照每条需求的最新修订
      await client.query(
        `INSERT INTO requirement_baseline_items (team_id, baseline_id, requirement_id, revision_id)
         SELECT $1, $2, rr.requirement_id, rr.revision_id
           FROM (
             SELECT DISTINCT ON (rr0.requirement_id) rr0.requirement_id, rr0.id AS revision_id
               FROM requirement_revisions rr0
               JOIN requirements rq ON rq.team_id = rr0.team_id AND rq.id = rr0.requirement_id
              WHERE rr0.team_id = $3 AND rq.project_id = $4
              ORDER BY rr0.requirement_id, rr0.seq DESC
           ) rr
          JOIN requirements r2 ON r2.team_id = $3 AND r2.id = rr.requirement_id
          WHERE r2.status <> 'dropped'`,
        [body.teamId, baselineId, body.teamId, projectId]
      );
      await client.query(`UPDATE requirements SET status = 'baselined' WHERE team_id = $1 AND project_id = $2 AND status = 'draft'`, [body.teamId, projectId]);
    });
    return reply.code(201).send({ baselineId });
  });

  // ---------- 工作项 ----------
  app.post("/projects/:projectId/work-items", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        title: z.string().min(1).max(200),
        assigneeId: z.string().uuid().optional(),
        completionEvidence: z.string().max(2000).default(""),
        requirementRevisionIds: z.array(z.string().uuid()).max(20).default([]),
        dependsOnIds: z.array(z.string().uuid()).max(20).default([]),
        deliverables: z.array(z.object({
          assetId: z.string().uuid(),
          revisionId: z.string().uuid(),
        })).max(20).default([]),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      await client.query(
        `INSERT INTO work_items (team_id, id, project_id, title, assignee_id, completion_evidence, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [body.teamId, id, projectId, body.title, body.assigneeId ?? null, body.completionEvidence, auth.userId]
      );
      for (const revId of body.requirementRevisionIds) {
        const { rows } = await client.query<{ requirement_id: string }>(
          `SELECT requirement_id FROM requirement_revisions WHERE team_id = $1 AND id = $2`,
          [body.teamId, revId]
        );
        if (!rows[0]) throw ERR.INVALID(`需求修订 ${revId} 不存在`);
        await client.query(
          `INSERT INTO work_item_req_links (team_id, work_item_id, requirement_id, requirement_revision_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [body.teamId, id, rows[0].requirement_id, revId]
        );
      }
      for (const dep of body.dependsOnIds) {
        await client.query(
          `INSERT INTO work_item_deps (team_id, work_item_id, depends_on_id) VALUES ($1,$2,$3)`,
          [body.teamId, id, dep]
        );
      }
      for (const d of body.deliverables) {
        const { rows } = await client.query(
          `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 AND id = $3`,
          [body.teamId, d.assetId, d.revisionId]
        );
        if (!rows[0]) throw ERR.INVALID(`交付物修订与资产不匹配: ${d.assetId.slice(0, 8)}`);
        await client.query(
          `INSERT INTO work_item_deliverables (team_id, work_item_id, asset_id, revision_id) VALUES ($1,$2,$3,$4)
           ON CONFLICT (team_id, work_item_id, asset_id) DO UPDATE SET revision_id = EXCLUDED.revision_id`,
          [body.teamId, id, d.assetId, d.revisionId]
        );
      }
      // 依赖禁环检测（设计 15 章）：从本节点出发 DFS
      const { rows: edges } = await client.query<{ work_item_id: string; depends_on_id: string }>(
        `SELECT work_item_id, depends_on_id FROM work_item_deps WHERE team_id = $1`,
        [body.teamId]
      );
      const adj = new Map<string, string[]>();
      for (const e of edges) {
        const list = adj.get(e.work_item_id) ?? [];
        list.push(e.depends_on_id);
        adj.set(e.work_item_id, list);
      }
      const seen = new Set<string>();
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop()!;
        if (cur === id && seen.has(cur)) throw ERR.INVALID("依赖关系形成环");
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of adj.get(cur) ?? []) stack.push(next);
      }
    });
    return reply.code(201).send({ workItemId: id });
  });

  app.post("/work-items/:workItemId/status", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { workItemId } = req.params as { workItemId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        status: z.enum(["todo", "ready", "in_progress", "in_review", "blocked", "done", "cancelled"]),
        blockedReason: z.string().max(2000).default(""),
      }),
      req.body
    );
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ assignee_id: string; created_by: string }>(
        `SELECT assignee_id, created_by FROM work_items WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, workItemId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      // 负责人或创建人可更新状态（日常协作不需审批）
      if (rows[0].assignee_id !== auth.userId && rows[0].created_by !== auth.userId) {
        const role = await teamRole(auth.userId, body.teamId);
        if (role !== "admin") throw ERR.FORBIDDEN();
      }
      if (body.status === "blocked" && !body.blockedReason) throw ERR.INVALID("阻塞必须填写原因");
      await client.query(
        `UPDATE work_items SET status = $3, blocked_reason = $4, updated_at = now() WHERE team_id = $1 AND id = $2`,
        [body.teamId, workItemId, body.status, body.blockedReason]
      );
    });
    return { ok: true };
  });

  // ---------- 测试运行（记录真实执行结果，绑定精确修订） ----------
  app.post("/projects/:projectId/test-runs", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        testAssetId: z.string().uuid(),
        testRevisionId: z.string().uuid(),
        targetAssetId: z.string().uuid(),
        targetRevisionId: z.string().uuid(),
        environment: z.string().max(500).default(""),
        result: z.enum(["pass", "fail", "error", "skipped"]),
        summary: z.string().max(4000).default(""),
        logExcerpt: z.string().max(16000).default(""),
        config: z.object({}).passthrough().default({}),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows: target } = await client.query<{ content_digest: string }>(
        `SELECT content_digest FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 AND id = $3`,
        [body.teamId, body.targetAssetId, body.targetRevisionId]
      );
      if (!target[0]) throw ERR.INVALID("被测修订不存在或与资产不匹配");
      await client.query(
        `INSERT INTO test_runs (team_id, id, project_id, test_asset_id, test_revision_id, target_asset_id, target_revision_id,
          target_content_digest, config, environment, result, summary, log_excerpt, executed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [body.teamId, id, projectId, body.testAssetId, body.testRevisionId, body.targetAssetId, body.targetRevisionId,
         target[0].content_digest, JSON.stringify(body.config), body.environment, body.result, body.summary, body.logExcerpt, auth.userId]
      );
    });
    return reply.code(201).send({ testRunId: id });
  });

  // ---------- 验收记录 ----------
  app.post("/projects/:projectId/acceptance", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        requirementRevisionId: z.string().uuid(),
        verdict: z.enum(["pass", "blocked", "waived"]),
        evidenceRunId: z.string().uuid().optional(),
        reason: z.string().max(4000).default(""),
        waiverExpiresAt: z.string().datetime().optional(),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    const id = newId();
    const result = await withTeam(body.teamId, async (client) => {
      const { rows: rev } = await client.query<{ requirement_id: string }>(
        `SELECT requirement_id FROM requirement_revisions WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.requirementRevisionId]
      );
      if (!rev[0]) throw ERR.INVALID("需求修订不存在");
      let evidenceValid = false;
      if (body.evidenceRunId) {
        const { rows: run } = await client.query<{ result: string; target_content_digest: string }>(
          `SELECT result, target_content_digest FROM test_runs WHERE team_id = $1 AND id = $2`,
          [body.teamId, body.evidenceRunId]
        );
        if (!run[0]) throw ERR.INVALID("证据运行不存在");
        if (run[0].result !== "pass") throw ERR.INVALID("证据运行未通过，不能作为验收依据");
        evidenceValid = true;
      }
      if (body.verdict === "pass" && !evidenceValid) {
        throw ERR.INVALID("验收 pass 必须绑定一次通过的测试运行");
      }
      if (body.verdict === "waived") {
        if (role !== "admin") throw ERR.FORBIDDEN("豁免只能由管理员记录");
        if (!body.reason || !body.waiverExpiresAt) throw ERR.INVALID("豁免必须填写原因与期限");
      }
      await client.query(
        `INSERT INTO acceptance_records (team_id, id, project_id, requirement_id, requirement_revision_id,
          verdict, evidence_run_id, reason, waiver_approver_id, waiver_expires_at, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [body.teamId, id, projectId, rev[0].requirement_id, body.requirementRevisionId, body.verdict,
         body.evidenceRunId ?? null, body.reason, body.verdict === "waived" ? auth.userId : null,
         body.waiverExpiresAt ?? null, auth.userId]
      );
      if (body.verdict === "pass" || body.verdict === "waived") {
        await client.query(
          `UPDATE requirements SET status = 'accepted' WHERE team_id = $1 AND id = $2`,
          [body.teamId, rev[0].requirement_id]
        );
      } else {
        await client.query(
          `UPDATE requirements SET status = 'verified' WHERE team_id = $1 AND id = $2 AND status <> 'accepted'`,
          [body.teamId, rev[0].requirement_id]
        );
      }
      return { acceptanceId: id };
    });
    return reply.code(201).send(result);
  });

  // ---------- 追踪矩阵（由真实关系生成，C02） ----------
  app.get("/projects/:projectId/traceability", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: reqs } = await client.query(
        `SELECT r.id, r.req_key, r.title, r.status, r.is_key, r.priority,
                rr.id AS revision_id, rr.seq AS revision_seq, rr.content, rr.content_digest
           FROM requirements r
           JOIN LATERAL (SELECT id, seq, content, content_digest FROM requirement_revisions
                          WHERE team_id = r.team_id AND requirement_id = r.id ORDER BY seq DESC LIMIT 1) rr ON true
          WHERE r.team_id = $1 AND r.project_id = $2 ORDER BY r.req_key`,
        [teamId, projectId]
      );
      const matrix = [];
      for (const r of reqs) {
        const { rows: items } = await client.query(
          `SELECT w.id, w.title, w.status, l.coverage,
                  json_agg(json_build_object('assetId', d.asset_id, 'revisionId', d.revision_id)) FILTER (WHERE d.asset_id IS NOT NULL) AS deliverables
             FROM work_item_req_links l
             JOIN work_items w ON w.team_id = l.team_id AND w.id = l.work_item_id
             LEFT JOIN work_item_deliverables d ON d.team_id = l.team_id AND d.work_item_id = w.id
            WHERE l.team_id = $1 AND l.requirement_id = $2
            GROUP BY w.id, w.title, w.status, l.coverage`,
          [teamId, r.id]
        );
        const { rows: runs } = await client.query(
          `SELECT t.id, t.result, t.target_revision_id, t.target_content_digest, t.executed_at,
                  ta.name AS test_name,
                  (t.target_content_digest = head.digest) AS evidence_current
             FROM test_runs t
             JOIN assets ta ON ta.team_id = t.team_id AND ta.id = t.test_asset_id
             JOIN LATERAL (
               SELECT ar.content_digest AS digest FROM asset_revisions ar
                WHERE ar.team_id = t.team_id AND ar.asset_id = t.target_asset_id
                ORDER BY ar.seq DESC LIMIT 1
             ) head ON true
            WHERE t.team_id = $1
              AND t.target_asset_id IN (
                SELECT d.asset_id FROM work_item_req_links l
                  JOIN work_item_deliverables d ON d.team_id = l.team_id AND d.work_item_id = l.work_item_id
                 WHERE l.team_id = $1 AND l.requirement_id = $2
              )
            ORDER BY t.executed_at DESC`,
          [teamId, r.id]
        );
        const { rows: acceptance } = await client.query(
          `SELECT a.verdict, a.reason, a.waiver_expires_at, u.display_name AS decided_by, a.evidence_run_id
             FROM acceptance_records a JOIN users u ON u.id = a.decided_by
            WHERE a.team_id = $1 AND a.requirement_revision_id = $2
            ORDER BY a.created_at DESC LIMIT 1`,
          [teamId, r.revision_id]
        );
        matrix.push({
          requirement: { id: r.id, key: r.req_key, title: r.title, status: r.status, isKey: r.is_key, revisionSeq: r.revision_seq },
          workItems: items,
          testRuns: runs,
          acceptance: acceptance[0] ?? null,
        });
      }
      return matrix;
    });
  });

  // ---------- 阶段门 ----------
  app.post("/projects/:projectId/gate-reviews", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), gate: z.enum(GATES) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN("阶段门审查由管理员执行");
    const outcome = await withTeam(body.teamId, async (client) => {
      // 结题门规则（C05）：每条关键需求最新修订必须有 pass 验收，
      // 或有效豁免（审批人+原因+未过期）；pass 验收的证据必须匹配当前摘要（C04）。
      const blockers: Record<string, unknown>[] = [];
      if (body.gate === "closure" || body.gate === "accept_release") {
        const { rows: reqs } = await client.query(
          `SELECT r.id, r.req_key, r.title, rr.id AS revision_id, rr.content_digest
             FROM requirements r
             JOIN LATERAL (SELECT id, content_digest FROM requirement_revisions
                            WHERE team_id = r.team_id AND requirement_id = r.id ORDER BY seq DESC LIMIT 1) rr ON true
            WHERE r.team_id = $1 AND r.project_id = $2 AND r.is_key AND r.status <> 'dropped'`,
          [body.teamId, projectId]
        );
        for (const r of reqs) {
          const { rows: acc } = await client.query(
            `SELECT verdict, evidence_run_id, reason, waiver_expires_at FROM acceptance_records
              WHERE team_id = $1 AND requirement_revision_id = $2 ORDER BY created_at DESC LIMIT 1`,
            [body.teamId, r.revision_id]
          );
          const latest = acc[0];
          if (!latest) {
            blockers.push({ requirement: r.req_key, reason: "关键需求没有任何验收记录" });
            continue;
          }
          if (latest.verdict === "blocked") {
            blockers.push({ requirement: r.req_key, reason: "验收被阻塞", detail: latest.reason });
            continue;
          }
          if (latest.verdict === "waived") {
            if (!latest.waiver_expires_at || new Date(latest.waiver_expires_at) < new Date()) {
              blockers.push({ requirement: r.req_key, reason: "豁免已过期" });
            } else if (!latest.reason) {
              blockers.push({ requirement: r.req_key, reason: "豁免缺少原因记录" });
            }
            continue;
          }
          if (latest.verdict === "pass") {
            if (!latest.evidence_run_id) {
              blockers.push({ requirement: r.req_key, reason: "pass 验收缺少证据运行" });
              continue;
            }
            const { rows: run } = await client.query<{ target_content_digest: string; result: string }>(
              `SELECT target_content_digest, result FROM test_runs WHERE team_id = $1 AND id = $2`,
              [body.teamId, latest.evidence_run_id]
            );
            if (!run[0] || run[0].result !== "pass") {
              blockers.push({ requirement: r.req_key, reason: "证据运行无效" });
              continue;
            }
            // C04：证据只对被测摘要有效——被测资产当前头摘要与运行记录不一致 → 证据过期
            const { rows: head } = await client.query<{ content_digest: string }>(
              `SELECT ar.content_digest FROM test_runs t
                 JOIN LATERAL (SELECT content_digest FROM asset_revisions
                                WHERE team_id = t.team_id AND asset_id = t.target_asset_id
                                ORDER BY seq DESC LIMIT 1) ar ON true
                WHERE t.team_id = $1 AND t.id = $2`,
              [body.teamId, latest.evidence_run_id]
            );
            if (!head[0] || head[0].content_digest !== run[0].target_content_digest) {
              blockers.push({
                requirement: r.req_key,
                reason: "测试证据对应的制品已更新（修订变化后未重新验证），证据失效",
              });
            }
          }
        }
      }
      const verdict = blockers.length === 0 ? "pass" : "blocked";
      const id = newId();
      await client.query(
        `INSERT INTO gate_reviews (team_id, id, project_id, gate, verdict, blockers, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [body.teamId, id, projectId, body.gate, verdict, JSON.stringify(blockers), auth.userId]
      );
      return { gateReviewId: id, verdict, blockers };
    });
    return reply.code(201).send(outcome);
  });

  // ---------- 结题包（C06） ----------
  app.get("/projects/:projectId/closure-package", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: proj } = await client.query(`SELECT id, name, code, status FROM projects WHERE team_id = $1 AND id = $2`, [teamId, projectId]);
      const { rows: baseline } = await client.query(
        `SELECT b.id, b.name, b.created_at,
                json_agg(json_build_object('requirementId', i.requirement_id, 'revisionId', i.revision_id)) AS items
           FROM requirement_baselines b JOIN requirement_baseline_items i ON i.team_id = b.team_id AND i.baseline_id = b.id
          WHERE b.team_id = $1 AND b.project_id = $2
          GROUP BY b.id, b.name, b.created_at ORDER BY b.created_at`,
        [teamId, projectId]
      );
      const { rows: bindings } = await client.query(
        `SELECT b.usage_key, b.purpose, a.name AS asset_name, b.revision_id, r.content_digest, r.seq
           FROM project_asset_bindings b JOIN assets a ON a.team_id = b.team_id AND a.id = b.asset_id
           JOIN asset_revisions r ON r.team_id = b.team_id AND r.id = b.revision_id
          WHERE b.team_id = $1 AND b.project_id = $2`,
        [teamId, projectId]
      );
      const { rows: releases } = await client.query(
        `SELECT rs.id, rs.version_label, rs.created_at,
                json_agg(json_build_object('asset', ri.asset_id, 'revision', ri.revision_id)) AS items
           FROM release_sets rs
          JOIN release_items ri ON ri.team_id = rs.team_id AND ri.release_set_id = rs.id
          WHERE rs.team_id = $1
            AND rs.change_request_id IN (
              SELECT id FROM change_requests WHERE team_id = $1 AND project_id = $2
            )
          GROUP BY rs.id, rs.version_label, rs.created_at`,
        [teamId, projectId]
      );
      const { rows: openIssues } = await client.query(
        `SELECT id, title, status FROM issues WHERE team_id = $1 AND project_id = $2 AND status NOT IN ('closed', 'resolved')`,
        [teamId, projectId]
      );
      const { rows: gates } = await client.query(
        `SELECT g.gate, g.verdict, g.blockers, g.created_at, u.display_name AS decided_by
           FROM gate_reviews g JOIN users u ON u.id = g.decided_by
          WHERE g.team_id = $1 AND g.project_id = $2 ORDER BY g.created_at`,
        [teamId, projectId]
      );
      const { rows: waivers } = await client.query(
        `SELECT a.reason, a.waiver_expires_at, u.display_name AS approver, r.req_key
           FROM acceptance_records a
           JOIN requirements r ON r.team_id = a.team_id AND r.id = a.requirement_id
           JOIN users u ON u.id = a.waiver_approver_id
          WHERE a.team_id = $1 AND a.project_id = $2 AND a.verdict = 'waived'`,
        [teamId, projectId]
      );
      return {
        generatedAt: new Date().toISOString(),
        project: proj[0],
        requirementBaselines: baseline,
        assetBindings: bindings,
        releases,
        openIssues,
        gateReviews: gates,
        waivers,
        note: "本包由数据库实时生成：资产以精确修订+摘要列出；豁免与遗留问题完整保留。",
      };
    });
  });
}
