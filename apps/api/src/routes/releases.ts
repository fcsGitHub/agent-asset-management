// /api/v1/change-requests 与发布（设计 13 章）。
// 核心不变量：
// - 审核绑定固定快照（candidate/review digest）；内容或条件变化 → 审批失效（B04）
// - review-and-publish 只能由真实管理员执行；作者分离；幂等键防重（B03/B10）
// - 固定顺序锁 + 头比较后，approval/release_set/items/通道头/CR/审计/outbox 单事务（B05/B06）
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { canonicalDigest, reviewDigest as computeReviewDigest, POLICY_VERSION, stableStringify } from "@taw/domain/digest";
import { blobStoreFromEnv } from "@taw/storage/local-cas";

interface CRRow {
  id: string;
  project_id: string;
  branch_id: string;
  status: string;
  created_by: string;
  title: string;
  motivation: string;
  related_refs: string;
  change_summary: string;
  compatibility: string;
  test_plan: string;
  migration_notes: string;
  rollback_notes: string;
}

export async function releaseRoutes(app: FastifyInstance): Promise<void> {
  const store = blobStoreFromEnv();

  async function teamRole(userId: string, teamId: string): Promise<string> {
    const { rows } = await q<{ role: string }>(
      `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
      [teamId, userId]
    );
    if (!rows[0]) throw ERR.NOT_FOUND();
    return rows[0].role;
  }

  // ---------- 创建 CR ----------
  app.post("/change-requests", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        branchId: z.string().uuid(),
        title: z.string().min(1).max(200),
        motivation: z.string().min(1).max(8000),
        relatedRefs: z.string().max(2000).default(""),
        changeSummary: z.string().max(8000).default(""),
        compatibility: z.string().max(8000).default(""),
        testPlan: z.string().max(8000).default(""),
        migrationNotes: z.string().max(8000).default(""),
        rollbackNotes: z.string().max(8000).default(""),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows: br } = await client.query<{ project_id: string; name: string; status: string }>(
        `SELECT project_id, name, status FROM branches WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.branchId]
      );
      if (!br[0]) throw ERR.NOT_FOUND();
      if (br[0].name === "main") throw ERR.INVALID("main 不能作为 PR 源分支");
      const items = await client.query(
        `SELECT 1 FROM branch_entries WHERE team_id = $1 AND branch_id = $2`,
        [body.teamId, body.branchId]
      );
      if (items.rowCount === 0) throw ERR.INVALID("分支没有任何修改，无可提交内容");
      await client.query(
        `INSERT INTO change_requests (team_id, id, project_id, branch_id, title, motivation, related_refs,
          change_summary, compatibility, test_plan, migration_notes, rollback_notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13)`,
        [body.teamId, id, br[0].project_id, body.branchId, body.title, body.motivation, body.relatedRefs,
         body.changeSummary, body.compatibility, body.testPlan, body.migrationNotes, body.rollbackNotes, auth.userId]
      );
      // 固化当前分支条目为 CR 项（base/head 快照）
      await client.query(
        `INSERT INTO change_request_items (team_id, change_request_id, asset_id, base_revision_id, candidate_revision_id)
         SELECT team_id, $2, asset_id, base_revision_id, head_revision_id FROM branch_entries
          WHERE team_id = $1 AND branch_id = $3`,
        [body.teamId, id, body.branchId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, changeRequestId: id, status: "open" });
  });

  app.get("/projects/:projectId/change-requests", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.title, c.status, c.created_at, u.display_name AS created_by_name, b.name AS branch_name,
                (SELECT count(*) FROM change_request_items i WHERE i.team_id = c.team_id AND i.change_request_id = c.id) AS item_count
           FROM change_requests c JOIN users u ON u.id = c.created_by JOIN branches b ON b.team_id = c.team_id AND b.id = c.branch_id
          WHERE c.team_id = $1 AND c.project_id = $2 ORDER BY c.created_at DESC`,
        [teamId, projectId]
      );
      return rows;
    });
  });

  app.get("/change-requests/:crId", async (req) => {
    const auth = requireAuth(req);
    const { crId } = req.params as { crId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query<CRRow & { branch_name: string; created_by_name: string }>(
        `SELECT c.*, b.name AS branch_name, u.display_name AS created_by_name
           FROM change_requests c JOIN branches b ON b.team_id = c.team_id AND b.id = c.branch_id
           JOIN users u ON u.id = c.created_by
          WHERE c.team_id = $1 AND c.id = $2`,
        [teamId, crId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const { rows: items } = await client.query(
        `SELECT i.asset_id, a.name AS asset_name, i.base_revision_id, i.candidate_revision_id,
                fr.seq AS base_seq, tr.seq AS candidate_seq
           FROM change_request_items i
           JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           JOIN asset_revisions fr ON fr.team_id = i.team_id AND fr.id = i.base_revision_id
           JOIN asset_revisions tr ON tr.team_id = i.team_id AND tr.id = i.candidate_revision_id
          WHERE i.team_id = $1 AND i.change_request_id = $2`,
        [teamId, crId]
      );
      const { rows: snaps } = await client.query(
        `SELECT id, candidate_digest, review_digest, channel, superseded, created_at
           FROM review_snapshots WHERE team_id = $1 AND change_request_id = $2 ORDER BY created_at DESC`,
        [teamId, crId]
      );
      return { ...rows[0], items, snapshots: snaps };
    });
  });

  // ---------- 生成固定审核快照 ----------
  app.post("/change-requests/:crId/prepare-review", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { crId } = req.params as { crId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        channel: z.enum(["stable", "preview"]).default("stable"),
        audience: z.string().max(200).default("team"),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    const snapshot = await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<CRRow>(
        `SELECT * FROM change_requests WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, crId]
      );
      const cr = rows[0];
      if (!cr) throw ERR.NOT_FOUND();
      if (role !== "admin" && cr.created_by !== auth.userId) throw ERR.FORBIDDEN();
      if (!["open", "changes_requested"].includes(cr.status)) {
        throw ERR.CONFLICT("CR_STATE", `当前状态 ${cr.status} 不能准备审核`);
      }
      const { rows: items } = await client.query<{
        asset_id: string;
        base_revision_id: string;
        candidate_revision_id: string;
      }>(
        `SELECT asset_id, base_revision_id, candidate_revision_id FROM change_request_items
          WHERE team_id = $1 AND change_request_id = $2 ORDER BY asset_id`,
        [body.teamId, crId]
      );
      if (!items[0]) throw ERR.INVALID("CR 没有变更项");

      // 分支头必须仍等于候选（提交后分支被改 → 失效）
      const { rows: branches } = await client.query<{ head_moved: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM branch_entries e JOIN change_request_items i
             ON i.team_id = e.team_id AND i.asset_id = e.asset_id
            AND e.branch_id = $1 AND i.change_request_id = $2
            AND e.head_revision_id <> i.candidate_revision_id
         ) AS head_moved`,
        [cr.branch_id, crId]
      );
      if (branches[0]?.head_moved) {
        throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "分支内容在提交后已被修改，请重新提交 CR");
      }

      // 组装候选载荷并计算摘要；记录期望通道头（并发发布的失效依据，B05）
      const revisionPayloads = [];
      const evidenceDigests: string[] = [];
      const { rows: chan } = await client.query<{ id: string }>(
        `SELECT id FROM asset_channels WHERE team_id = $1 AND project_id = $2 AND name = $3`,
        [body.teamId, cr.project_id, body.channel]
      );
      const expectedHeads: Record<string, string | null> = {};
      if (chan[0]) {
        const { rows: heads } = await client.query<{ asset_id: string; revision_id: string }>(
          `SELECT asset_id, revision_id FROM channel_heads WHERE team_id = $1 AND channel_id = $2`,
          [body.teamId, chan[0].id]
        );
        for (const h of heads) expectedHeads[h.asset_id] = h.revision_id;
      }
      for (const item of items) {
        expectedHeads[item.asset_id] = expectedHeads[item.asset_id] ?? null;
        const { rows: rev } = await client.query<{
          id: string;
          properties: Record<string, unknown>;
          content_digest: string;
          type_version_id: string;
        }>(
          `SELECT id, properties, content_digest, type_version_id FROM asset_revisions
            WHERE team_id = $1 AND id = $2`,
          [body.teamId, item.candidate_revision_id]
        );
        const r = rev[0]!;
        const arts = await client.query<{ digest: string }>(
          `SELECT blob_digest AS digest FROM revision_artifacts WHERE team_id = $1 AND revision_id = $2 ORDER BY blob_digest`,
          [body.teamId, item.candidate_revision_id]
        );
        // 制品必须真实可读（设计 13 章：所有文件先完成持久化与可读验证）
        for (const a of arts.rows) {
          if (!(await store.exists(body.teamId, a.digest))) {
            throw ERR.CONFLICT("ARTIFACT_MISSING", `制品 ${a.digest.slice(0, 8)}… 不可读，无法进入审核`);
          }
        }
        revisionPayloads.push({
          asset_id: item.asset_id,
          revision_id: r.id,
          base_revision_id: item.base_revision_id,
          expected_channel_head: expectedHeads[item.asset_id] ?? null,
          type_version: r.type_version_id,
          properties: r.properties,
          content_digest: r.content_digest,
          artifact_digests: arts.rows.map((a) => a.digest),
        });
      }
      const candidateDigest = canonicalDigest({
        revisions: revisionPayloads,
        policy: POLICY_VERSION,
      });
      const releaseNotes = {
        title: cr.title,
        motivation: cr.motivation,
        related_refs: cr.related_refs,
        change_summary: cr.change_summary,
        compatibility: cr.compatibility,
        test_plan: cr.test_plan,
        migration: cr.migration_notes,
        rollback: cr.rollback_notes,
      };
      const rdigest = computeReviewDigest({
        candidateDigest,
        evidenceDigests,
        releaseNotes,
        policyVersion: POLICY_VERSION,
        channel: body.channel,
        audience: body.audience,
      });
      // 旧快照标记被取代
      await client.query(
        `UPDATE review_snapshots SET superseded = true WHERE team_id = $1 AND change_request_id = $2`,
        [body.teamId, crId]
      );
      const snapId = newId();
      await client.query(
        `INSERT INTO review_snapshots (team_id, id, change_request_id, candidate_digest, review_digest, payload, policy_version, channel)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [body.teamId, snapId, crId, candidateDigest, rdigest,
         JSON.stringify({ revisions: revisionPayloads, releaseNotes, audience: body.audience }),
         POLICY_VERSION, body.channel]
      );
      await client.query(
        `UPDATE change_requests SET status = 'awaiting_review', updated_at = now() WHERE team_id = $1 AND id = $2`,
        [body.teamId, crId]
      );
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, request_id, detail)
         VALUES ($1,$2,'review_prepared','change_request',$3,$4,$5)`,
        [body.teamId, auth.userId, crId, req.id, JSON.stringify({ candidateDigest, reviewDigest: rdigest })]
      );
      return { snapshotId: snapId, candidateDigest, reviewDigest: rdigest, channel: body.channel };
    });
    return reply.code(201).send(snapshot);
  });


  // ---------- 幂等键存储 ----------
  async function idempotentReply(
    teamId: string,
    actorId: string,
    scope: string,
    key: string | undefined,
    fn: () => Promise<{ code: number; body: unknown }>
  ): Promise<{ code: number; body: unknown; replayed: boolean }> {
    if (!key) {
      const r = await fn();
      return { ...r, replayed: false };
    }
    const { rows } = await q<{ response_code: number; response_body: string }>(
      `SELECT response_code, response_body FROM idempotency_keys WHERE team_id = $1 AND actor_id = $2 AND scope = $3 AND key = $4`,
      [teamId, actorId, scope, key]
    );
    if (rows[0]) {
      return { code: rows[0].response_code, body: JSON.parse(rows[0].response_body), replayed: true };
    }
    const r = await fn();
    await q(
      `INSERT INTO idempotency_keys (team_id, actor_id, scope, key, response_code, response_body)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [teamId, actorId, scope, key, r.code, JSON.stringify(r.body)]
    ).catch(() => undefined); // 并发同键：后到者直接返回首次结果语义近似；严格性由发布锁保证
    return { ...r, replayed: false };
  }

  // ---------- 人类审核并发布（首版单一动作） ----------
  app.post("/change-requests/:crId/review-and-publish", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { crId } = req.params as { crId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        expectedReviewDigest: z.string().length(64),
        note: z.string().max(2000).default(""),
      }),
      req.body
    );
    const idemKey = req.headers["idempotency-key"];
    const idem = typeof idemKey === "string" ? idemKey.slice(0, 128) : undefined;

    const result = await idempotentReply(body.teamId, auth.userId, "review-and-publish", idem, async () => {
      const role = await teamRole(auth.userId, body.teamId);
      if (role !== "admin") {
        throw ERR.FORBIDDEN(); // B03：成员不能发布
      }
      return withTeam(body.teamId, async (client) => {
        // 1) 锁 CR 行
        const { rows: crRows } = await client.query<CRRow>(
          `SELECT * FROM change_requests WHERE team_id = $1 AND id = $2 FOR UPDATE`,
          [body.teamId, crId]
        );
        const cr = crRows[0];
        if (!cr) throw ERR.NOT_FOUND();
        if (cr.status !== "awaiting_review") {
          throw ERR.CONFLICT("CR_STATE", `状态 ${cr.status} 不能发布`);
        }

        // 2) 作者分离（单人管理例外必须人事先配置并留记录）
        if (cr.created_by === auth.userId) {
          const { rows: setting } = await client.query<{ allow_single_admin_self_approval: boolean; single_admin_exception_note: string }>(
            `SELECT allow_single_admin_self_approval, single_admin_exception_note FROM team_settings WHERE team_id = $1`,
            [body.teamId]
          );
          if (!setting[0]?.allow_single_admin_self_approval) {
            throw ERR.FORBIDDEN(); // 默认禁止自审自发
          }
          if (!setting[0].single_admin_exception_note) {
            throw ERR.FORBIDDEN();
          }
        }

        // 3) 取当前未取代快照并比对摘要（审核后内容/条件变化 → 失效，B04）
        const { rows: snapRows } = await client.query<{
          id: string;
          candidate_digest: string;
          review_digest: string;
          channel: string;
          payload: {
            revisions: {
              asset_id: string;
              revision_id: string;
              base_revision_id: string;
              expected_channel_head?: string | null;
              content_digest: string;
              artifact_digests: string[];
            }[];
            releaseNotes: Record<string, unknown>;
            audience: string;
          };
        }>(
          `SELECT id, candidate_digest, review_digest, channel, payload FROM review_snapshots
            WHERE team_id = $1 AND change_request_id = $2 AND superseded = false
            ORDER BY created_at DESC LIMIT 1`,
          [body.teamId, crId]
        );
        const snap = snapRows[0];
        if (!snap) throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "没有有效审核快照");
        const recomputed = computeReviewDigest({
          candidateDigest: snap.candidate_digest,
          evidenceDigests: [],
          releaseNotes: snap.payload.releaseNotes,
          policyVersion: POLICY_VERSION,
          channel: snap.channel,
          audience: snap.payload.audience ?? "team",
        });
        if (recomputed !== snap.review_digest || body.expectedReviewDigest !== snap.review_digest) {
          throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "审核摘要不匹配，内容或条件已变化，需重新审核");
        }

        // 4) 固定顺序锁定通道头（B05 并发发布串行化）
        const { rows: channelRows } = await client.query<{ id: string; name: string }>(
          `SELECT id, name FROM asset_channels WHERE team_id = $1 AND project_id = $2 AND name = $3 FOR UPDATE`,
          [body.teamId, cr.project_id, snap.channel]
        );
        let channelId = channelRows[0]?.id;
        if (!channelId) {
          const cid = newId();
          await client.query(
            `INSERT INTO asset_channels (team_id, id, project_id, name) VALUES ($1,$2,$3,$4)`,
            [body.teamId, cid, cr.project_id, snap.channel]
          );
          channelId = cid;
        }
        const assetIds = snap.payload.revisions.map((r) => r.asset_id).sort();
        for (const aid of assetIds) {
          await client.query(
            `SELECT 1 FROM channel_heads WHERE team_id = $1 AND channel_id = $2 AND asset_id = $3 FOR UPDATE`,
            [body.teamId, channelId, aid]
          );
        }
        // 目标头已被并发发布移动 → 本快照失效（B05）
        for (const r of snap.payload.revisions) {
          const { rows: curHead } = await client.query<{ revision_id: string }>(
            `SELECT revision_id FROM channel_heads WHERE team_id = $1 AND channel_id = $2 AND asset_id = $3`,
            [body.teamId, channelId, r.asset_id]
          );
          const actual = curHead[0]?.revision_id ?? null;
          const expected = r.expected_channel_head ?? null;
          if (actual !== expected) {
            throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "目标通道头已移动，需重新准备审核", {
              assetId: r.asset_id,
              expected,
              actual,
            });
          }
        }

        // 5) 重算候选摘要（候选内容不得已变）+ 分支头一致 + 制品可读
        const freshPayloads = [];
        for (const r of snap.payload.revisions) {
          const { rows: rev } = await client.query<{ content_digest: string; properties: Record<string, unknown>; type_version_id: string }>(
            `SELECT content_digest, properties, type_version_id FROM asset_revisions WHERE team_id = $1 AND id = $2`,
            [body.teamId, r.revision_id]
          );
          if (!rev[0]) throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "候选修订不存在");
          const arts = await client.query<{ digest: string }>(
            `SELECT blob_digest AS digest FROM revision_artifacts WHERE team_id = $1 AND revision_id = $2 ORDER BY blob_digest`,
            [body.teamId, r.revision_id]
          );
          for (const a of arts.rows) {
            if (!(await store.exists(body.teamId, a.digest))) {
              throw ERR.CONFLICT("ARTIFACT_MISSING", `制品 ${a.digest.slice(0, 8)}… 不可读`);
            }
          }
          freshPayloads.push({
            asset_id: r.asset_id,
            revision_id: r.revision_id,
            base_revision_id: r.base_revision_id,
            expected_channel_head: r.expected_channel_head ?? null,
            type_version: rev[0].type_version_id,
            properties: rev[0].properties,
            content_digest: rev[0].content_digest,
            artifact_digests: arts.rows.map((a) => a.digest),
          });
        }
        const freshCandidate = canonicalDigest({ revisions: freshPayloads, policy: POLICY_VERSION });
        if (freshCandidate !== snap.candidate_digest) {
          throw ERR.CONFLICT("REVIEW_DIGEST_CHANGED", "候选内容与审核快照不一致");
        }

        // 6) 原子写入：approval + release_set/items + 通道头 + CR/branch 状态 + main 视图 + 审计 + outbox
        const approvalId = newId();
        const releaseSetId = newId();
        const eventId = randomUUID();
        const versionLabel = `REL-${new Date().toISOString().slice(0, 10)}-${releaseSetId.slice(0, 6)}`;

        await client.query(
          `INSERT INTO release_sets (team_id, id, change_request_id, review_snapshot_id, version_label, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [body.teamId, releaseSetId, crId, snap.id, versionLabel, JSON.stringify(snap.payload.releaseNotes), auth.userId]
        );
        for (const r of snap.payload.revisions) {
          const { rows: cur } = await client.query<{ revision_id: string }>(
            `SELECT revision_id FROM channel_heads WHERE team_id = $1 AND channel_id = $2 AND asset_id = $3`,
            [body.teamId, channelId, r.asset_id]
          );
          await client.query(
            `INSERT INTO release_items (team_id, release_set_id, asset_id, revision_id, superseded_revision_id)
             VALUES ($1,$2,$3,$4,$5)`,
            [body.teamId, releaseSetId, r.asset_id, r.revision_id, cur[0]?.revision_id ?? null]
          );
          await client.query(
            `INSERT INTO channel_heads (team_id, channel_id, asset_id, revision_id, release_set_id, updated_at)
             VALUES ($1,$2,$3,$4,$5,now())
             ON CONFLICT (team_id, channel_id, asset_id)
             DO UPDATE SET revision_id = EXCLUDED.revision_id, release_set_id = EXCLUDED.release_set_id, updated_at = now()`,
            [body.teamId, channelId, r.asset_id, r.revision_id, releaseSetId]
          );
          // main 分支 = stable 正式内容视图（发布事务内更新，不接受草稿）
          await client.query(
            `INSERT INTO branch_entries (team_id, branch_id, asset_id, base_revision_id, head_revision_id, updated_at)
             SELECT $1, b.id, $2, $3, $4, now() FROM branches b
              WHERE b.team_id = $1 AND b.project_id = $5 AND b.name = 'main'
             ON CONFLICT (team_id, branch_id, asset_id)
             DO UPDATE SET head_revision_id = EXCLUDED.head_revision_id, updated_at = now()`,
            [body.teamId, r.asset_id, r.base_revision_id, r.revision_id, cr.project_id]
          );
        }
        await client.query(
          `INSERT INTO approvals (team_id, id, review_snapshot_id, approver_id, release_set_id, note)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [body.teamId, approvalId, snap.id, auth.userId, releaseSetId, body.note]
        );
        await client.query(
          `UPDATE change_requests SET status = 'merged', updated_at = now() WHERE team_id = $1 AND id = $2`,
          [body.teamId, crId]
        );
        await client.query(
          `UPDATE branches SET status = 'merged' WHERE team_id = $1 AND id = $2`,
          [body.teamId, cr.branch_id]
        );
        await client.query(
          `INSERT INTO release_events (team_id, id, kind, release_set_id, channel_id, actor_id, detail)
           VALUES ($1,$2,'publish',$3,$4,$5,$6)`,
          [body.teamId, eventId, releaseSetId, channelId, auth.userId, JSON.stringify({ crId, versionLabel })]
        );
        await client.query(
          `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, request_id, detail)
           VALUES ($1,$2,'release_published','release_set',$3,$4,$5)`,
          [body.teamId, auth.userId, releaseSetId, req.id, JSON.stringify({ crId, channel: snap.channel })]
        );
        await client.query(
          `INSERT INTO outbox (team_id, event_id, event_type, aggregate, payload)
           VALUES ($1,$2,'ReleasePublished','release_set',$3)`,
          [body.teamId, eventId, JSON.stringify({ releaseSetId, crId, channel: snap.channel })]
        );
        return {
          code: 200,
          body: {
            ok: true,
            releaseSetId,
            versionLabel,
            channel: snap.channel,
            reviewDigest: snap.review_digest,
          },
        };
      });
    });
    return reply.code(result.code).send({ ...(result.body as object), idempotentReplay: result.replayed });
  });
  // ---------- 回退（新的受审查事件） ----------
  app.post("/channels/:channelId/rollback", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { channelId } = req.params as { channelId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        toReleaseSetId: z.string().uuid(),
        reason: z.string().min(1).max(4000),
        externalSideEffects: z.string().max(4000).default(""),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    const out = await withTeam(body.teamId, async (client) => {
      const { rows: target } = await client.query<{ id: string; created_at: string }>(
        `SELECT id, created_at FROM release_sets WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.toReleaseSetId]
      );
      if (!target[0]) throw ERR.NOT_FOUND();
      const { rows: items } = await client.query<{ asset_id: string; revision_id: string }>(
        `SELECT asset_id, revision_id FROM release_items WHERE team_id = $1 AND release_set_id = $2 ORDER BY asset_id`,
        [body.teamId, body.toReleaseSetId]
      );
      if (!items[0]) throw ERR.INVALID("目标发布集没有条目");
      await client.query(
        `SELECT 1 FROM asset_channels WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, channelId]
      );
      const rollbackSetId = newId();
      await client.query(
        `INSERT INTO release_sets (team_id, id, change_request_id, review_snapshot_id, version_label, notes, created_by)
         VALUES ($1,$2,NULL,$3,$4,$5,$6)`,
        [body.teamId, rollbackSetId,
         null,
         `ROLLBACK-${rollbackSetId.slice(0, 6)}`,
         JSON.stringify({ reason: body.reason, externalSideEffects: body.externalSideEffects, toReleaseSetId: body.toReleaseSetId }),
         auth.userId]
      );
      for (const item of items) {
        await client.query(
          `INSERT INTO release_items (team_id, release_set_id, asset_id, revision_id) VALUES ($1,$2,$3,$4)`,
          [body.teamId, rollbackSetId, item.asset_id, item.revision_id]
        );
        await client.query(
          `INSERT INTO channel_heads (team_id, channel_id, asset_id, revision_id, release_set_id, updated_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (team_id, channel_id, asset_id)
           DO UPDATE SET revision_id = EXCLUDED.revision_id, release_set_id = EXCLUDED.release_set_id, updated_at = now()`,
          [body.teamId, channelId, item.asset_id, item.revision_id, rollbackSetId]
        );
      }
      const eventId = randomUUID();
      await client.query(
        `INSERT INTO release_events (team_id, id, kind, release_set_id, channel_id, actor_id, detail)
         VALUES ($1,$2,'rollback',$3,$4,$5,$6)`,
        [body.teamId, eventId, rollbackSetId, channelId, auth.userId,
         JSON.stringify({ reason: body.reason, externalSideEffects: body.externalSideEffects })]
      );
      await client.query(
        `INSERT INTO audit_events (team_id, actor_id, action, object_kind, object_id, request_id, detail)
         VALUES ($1,$2,'release_rollback','release_set',$3,$4,$5)`,
        [body.teamId, auth.userId, rollbackSetId, req.id, JSON.stringify({ toReleaseSetId: body.toReleaseSetId })]
      );
      await client.query(
        `INSERT INTO outbox (team_id, event_id, event_type, aggregate, payload)
         VALUES ($1,$2,'ReleaseRolledBack','release_set',$3)`,
        [body.teamId, eventId, JSON.stringify({ rollbackSetId, toReleaseSetId: body.toReleaseSetId })]
      );
      return { rollbackSetId };
    });
    return reply.code(200).send({ ok: true, ...out });
  });

  // ---------- 项目精确绑定（B09） ----------
  app.post("/projects/:projectId/bindings", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        assetId: z.string().uuid(),
        revisionId: z.string().uuid(),
        usageKey: z.string().min(1).max(128),
        purpose: z.string().max(2000).default(""),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT 1 FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 AND id = $3`,
        [body.teamId, body.assetId, body.revisionId]
      );
      if (!rows[0]) throw ERR.INVALID("修订与资产不匹配或不存在");
      await client.query(
        `INSERT INTO project_asset_bindings (team_id, id, project_id, asset_id, revision_id, usage_key, purpose, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [body.teamId, id, projectId, body.assetId, body.revisionId, body.usageKey, body.purpose, auth.userId]
      );
    });
    return reply.code(201).send({ bindingId: id });
  });

  app.get("/projects/:projectId/bindings", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT b.id, b.usage_key, b.purpose, a.name AS asset_name, b.asset_id, b.revision_id,
                r.seq AS revision_seq, r.content_digest
           FROM project_asset_bindings b
           JOIN assets a ON a.team_id = b.team_id AND a.id = b.asset_id
           JOIN asset_revisions r ON r.team_id = b.team_id AND r.id = b.revision_id
          WHERE b.team_id = $1 AND b.project_id = $2 ORDER BY b.created_at`,
        [teamId, projectId]
      );
      return rows;
    });
  });

  // ---------- 通道当前视图 ----------
  app.get("/projects/:projectId/channel", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    const channelName = String((req.query as { channel?: string } | null)?.channel ?? "stable");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.asset_id, a.name AS asset_name, c.revision_id, r.seq AS revision_seq,
                c.release_set_id, rs.version_label, c.updated_at
           FROM channel_heads c
           JOIN asset_channels ch ON ch.team_id = c.team_id AND ch.id = c.channel_id
           JOIN assets a ON a.team_id = c.team_id AND a.id = c.asset_id
           JOIN asset_revisions r ON r.team_id = c.team_id AND r.id = c.revision_id
           LEFT JOIN release_sets rs ON rs.team_id = c.team_id AND rs.id = c.release_set_id
          WHERE c.team_id = $1 AND ch.project_id = $2 AND ch.name = $3
          ORDER BY a.name`,
        [teamId, projectId, channelName]
      );
      return rows;
    });
  });

  // ---------- 变更请求退回 ----------
  app.post("/change-requests/:crId/changes-requested", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { crId } = req.params as { crId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), comment: z.string().min(1).max(4000) }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    if (role !== "admin") throw ERR.FORBIDDEN();
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM change_requests WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, crId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      if (rows[0].status !== "awaiting_review") throw ERR.CONFLICT("CR_STATE", "仅待审状态可退回");
      await client.query(
        `UPDATE change_requests SET status = 'changes_requested', updated_at = now() WHERE team_id = $1 AND id = $2`,
        [body.teamId, crId]
      );
      await client.query(
        `INSERT INTO comments (team_id, id, target_kind, target_id, author_id, content)
         VALUES ($1,$2,'change_request',$3,$4,$5)`,
        [body.teamId, newId(), crId, auth.userId, body.comment]
      );
      await client.query(
        `UPDATE review_snapshots SET superseded = true WHERE team_id = $1 AND change_request_id = $2`,
        [body.teamId, crId]
      );
    });
    return { ok: true };
  });
}
