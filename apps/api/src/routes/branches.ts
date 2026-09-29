// /api/v1/branches — 项目工作分支（设计 12 章）。
// 分支仅存被修改资产的 base→head；每次保存产生不可变修订并移动分支头。
// main 为受保护分支：不承担未审草稿，只能由发布事务更新。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { stableStringify } from "@taw/domain/digest";
import { diffRevisions } from "@taw/domain/diff";
import { blobStoreFromEnv } from "@taw/storage/local-cas";
import { loadTypeChain, validateAgainstChain } from "../ontology.js";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

export async function branchRoutes(app: FastifyInstance): Promise<void> {
  const store = blobStoreFromEnv();

  app.post("/projects/:projectId/branches", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const body = parseBody(
      z.object({ teamId: z.string().uuid(), name: z.string().regex(/^[a-z0-9][a-z0-9.\-_/]{1,63}$/) }),
      req.body
    );
    if (body.name === "main") throw ERR.INVALID("main 为受保护分支，不能手动创建");
    await teamRole(auth.userId, body.teamId);
    const id = newId();
    await withTeam(body.teamId, async (client) => {
      const dup = await client.query(`SELECT 1 FROM branches WHERE team_id = $1 AND project_id = $2 AND name = $3`, [
        body.teamId, projectId, body.name,
      ]);
      if (dup.rowCount) throw ERR.CONFLICT("BRANCH_EXISTS", "同名分支已存在");
      await client.query(
        `INSERT INTO branches (team_id, id, project_id, name, created_by) VALUES ($1, $2, $3, $4, $5)`,
        [body.teamId, id, projectId, body.name, auth.userId]
      );
    });
    return reply.code(201).send({ teamId: body.teamId, branchId: id, name: body.name });
  });

  app.get("/projects/:projectId/branches", async (req) => {
    const auth = requireAuth(req);
    const { projectId } = req.params as { projectId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT b.id, b.name, b.status, b.created_at, u.display_name AS created_by_name,
                (SELECT count(*) FROM branch_entries e WHERE e.team_id = b.team_id AND e.branch_id = b.id) AS changed_assets
           FROM branches b JOIN users u ON u.id = b.created_by
          WHERE b.team_id = $1 AND b.project_id = $2 ORDER BY b.created_at`,
        [teamId, projectId]
      );
      return rows;
    });
  });

  // 保存候选修订（草稿写入）：新不可变修订 + 移动分支头
  app.post("/branches/:branchId/revisions", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { branchId } = req.params as { branchId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        assetId: z.string().uuid(),
        properties: z.object({}).passthrough().optional(),
        artifacts: z
          .array(
            z.object({
              digest: z.string().length(64),
              role: z.string().min(1).max(32).default("implementation"),
              originalName: z.string().min(1).max(255),
              mediaType: z.string().min(1).max(128),
              size: z.number().int().nonnegative(),
            })
          )
          .max(20)
          .default([]),
        expectedHeadRevisionId: z.string().uuid().optional(),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const revisionId = newId();
    const result = await withTeam(body.teamId, async (client) => {
      const { rows: br } = await client.query<{ name: string; status: string; project_id: string }>(
        `SELECT name, status, project_id FROM branches WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, branchId]
      );
      const branch = br[0];
      if (!branch) throw ERR.NOT_FOUND();
      if (branch.name === "main") throw ERR.FORBIDDEN();
      if (branch.status !== "open") throw ERR.CONFLICT("BRANCH_CLOSED", "分支已合并或放弃，不能写入");

      const { rows: assetRows } = await client.query<{ id: string; current_type_version_id: string; lifecycle: string }>(
        `SELECT id, current_type_version_id, lifecycle FROM assets WHERE team_id = $1 AND id = $2`,
        [body.teamId, body.assetId]
      );
      const asset = assetRows[0];
      if (!asset) throw ERR.NOT_FOUND();
      if (asset.lifecycle === "archived") {
        throw ERR.CONFLICT("ASSET_ARCHIVED", "资产已归档，不能写入新草稿修订；先恢复资产再操作");
      }

      // 解析当前头：分支已有条目 → 其 head；否则 main/stable 头（最新修订）
      const { rows: entry } = await client.query<{ base_revision_id: string; head_revision_id: string }>(
        `SELECT base_revision_id, head_revision_id FROM branch_entries
          WHERE team_id = $1 AND branch_id = $2 AND asset_id = $3 FOR UPDATE`,
        [body.teamId, branchId, body.assetId]
      );
      let baseRevisionId: string;
      let currentHeadId: string;
      if (entry[0]) {
        baseRevisionId = entry[0].base_revision_id;
        currentHeadId = entry[0].head_revision_id;
      } else {
        const { rows: latest } = await client.query<{ id: string }>(
          `SELECT id FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT 1`,
          [body.teamId, body.assetId]
        );
        if (!latest[0]) throw ERR.INVALID("资产尚无任何修订");
        baseRevisionId = latest[0].id;
        currentHeadId = latest[0].id;
      }
      if (body.expectedHeadRevisionId && body.expectedHeadRevisionId !== currentHeadId) {
        throw ERR.CONFLICT("STALE_HEAD", "分支头已移动，请刷新后重试", {
          expected: body.expectedHeadRevisionId,
          actual: currentHeadId,
        });
      }

      // 基于当前头修订生成新修订（属性覆盖、制品追加替换）
      const { rows: headRows } = await client.query<{
        properties: Record<string, unknown>;
        type_version_id: string;
        seq: number;
      }>(
        `SELECT properties, type_version_id, seq FROM asset_revisions WHERE team_id = $1 AND id = $2`,
        [body.teamId, currentHeadId]
      );
      const head = headRows[0]!;
      const newProperties = { ...head.properties, ...(body.properties ?? {}) };
      // 更新必须经过设定的 schema（M59）：草稿保存与登记共用同一类型链关卡——
      // 子类型资产同时满足链上全部祖先定义，错误带 [typeKey vN] 前缀。
      const chain = await loadTypeChain(client, body.teamId, head.type_version_id);
      validateAgainstChain(chain, newProperties);
      const canonical = stableStringify({
        p: newProperties,
        arts: body.artifacts.map((a) => a.digest).sort(),
        type: asset.current_type_version_id,
      });
      const contentDigest = createHash("sha256").update(canonical).digest("hex");

      await client.query(
        `INSERT INTO asset_revisions (team_id, id, asset_id, type_version_id, properties, content_digest, seq, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [body.teamId, revisionId, body.assetId, head.type_version_id, JSON.stringify(newProperties), contentDigest, head.seq + 1, auth.userId]
      );
      for (const art of body.artifacts) {
        const { rows: blob } = await client.query(`SELECT 1 FROM blobs WHERE team_id = $1 AND digest = $2`, [
          body.teamId,
          art.digest,
        ]);
        if (!blob[0]) throw ERR.INVALID(`制品摘要 ${art.digest.slice(0, 8)}… 未在本团队上传`);
        await client.query(
          `INSERT INTO revision_artifacts (team_id, revision_id, blob_digest, artifact_role, original_name, media_type, size)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (team_id, revision_id, artifact_role, blob_digest) DO NOTHING`,
          [body.teamId, revisionId, art.digest, art.role, art.originalName, art.mediaType, art.size]
        );
      }
      if (entry[0]) {
        await client.query(
          `UPDATE branch_entries SET head_revision_id = $3, updated_at = now()
            WHERE team_id = $1 AND branch_id = $2 AND asset_id = $4`,
          [body.teamId, branchId, revisionId, body.assetId]
        );
      } else {
        await client.query(
          `INSERT INTO branch_entries (team_id, branch_id, asset_id, base_revision_id, head_revision_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [body.teamId, branchId, body.assetId, baseRevisionId, revisionId]
        );
      }
      return { revisionId, seq: head.seq + 1, contentDigest };
    });
    return reply.code(201).send({ teamId: body.teamId, branchId, assetId: body.assetId, ...result });
  });

  // 分支差异：被修改资产 base→head 的文本/属性/关系/二进制对照（B02）
  app.get("/branches/:branchId/diff", async (req) => {
    const auth = requireAuth(req);
    const { branchId } = req.params as { branchId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows: entries } = await client.query<{ asset_id: string; base_revision_id: string; head_revision_id: string; name: string }>(
        `SELECT e.asset_id, e.base_revision_id, e.head_revision_id, a.name
           FROM branch_entries e JOIN assets a ON a.team_id = e.team_id AND a.id = e.asset_id
          WHERE e.team_id = $1 AND e.branch_id = $2`,
        [teamId, branchId]
      );
      const out = [];
      for (const e of entries) {
        const revLoader = async (id: string) => {
          const { rows } = await client.query<{
            properties: Record<string, unknown>;
          }>(`SELECT properties FROM asset_revisions WHERE team_id = $1 AND id = $2`, [teamId, id]);
          const props = rows[0]?.properties ?? {};
          const arts = await client.query<{ role: string; original_name: string; blob_digest: string; media_type: string }>(
            `SELECT artifact_role AS role, original_name, blob_digest, media_type FROM revision_artifacts WHERE team_id = $1 AND revision_id = $2`,
            [teamId, id]
          );
          const rels = await client.query<{ type_key: string; target: string }>(
            `SELECT rt.type_key, ta.name AS target FROM relation_assertions ra
               JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
               JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
              WHERE ra.team_id = $1 AND ra.source_revision_id = $2 AND ra.status <> 'withdrawn'`,
            [teamId, id]
          );
          return {
            properties: props,
            artifacts: arts.rows.map((a) => ({ role: a.role, originalName: a.original_name, digest: a.blob_digest, mediaType: a.media_type })),
            relations: rels.rows.map((r) => ({ typeKey: r.type_key, target: r.target })),
          };
        };
        const [from, to] = await Promise.all([revLoader(e.base_revision_id), revLoader(e.head_revision_id)]);
        const diff = await diffRevisions({
          from,
          to,
          fetchText: async (digest: string) => {
            try {
              return (await store.get(teamId, digest)).toString("utf8");
            } catch {
              return "<二进制或不可读内容>";
            }
          },
        });
        out.push({ assetId: e.asset_id, assetName: e.name, baseRevisionId: e.base_revision_id, headRevisionId: e.head_revision_id, diff });
      }
      return out;
    });
  });
}
