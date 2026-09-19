// /api/v1 资产元数据编辑（可变业务状态）与 Session 分享检查。
// C07：ETag 乐观并发——If-Match 不匹配 → 409 STALE_HEAD，不静默覆盖。
// C08：分享前核对来源许可与产出受众；不满足给出阻断清单，不直接开放。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash } from "node:crypto";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

function metaEtag(metaVersion: number): string {
  return `"meta-${metaVersion}"`;
}

export async function assetMetaRoutes(app: FastifyInstance): Promise<void> {
  // 元数据编辑（展示名/标签），ETag 乐观并发
  app.patch("/assets/:assetId/meta", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { assetId } = req.params as { assetId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().min(1).max(256).optional(),
        labels: z.array(z.string().min(1).max(32)).max(16).optional(),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const ifMatch = req.headers["if-match"];
    if (typeof ifMatch !== "string" || !/^"meta-\d+"$/.test(ifMatch)) {
      throw ERR.INVALID("缺少 If-Match ETag（先 GET /assets/:id 获取）");
    }
    return withTeam(body.teamId, async (client) => {
      const { rows } = await client.query<{ meta_version: number }>(
        `SELECT meta_version FROM assets WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, assetId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const current = rows[0].meta_version;
      if (ifMatch !== metaEtag(current)) {
        throw ERR.CONFLICT("STALE_HEAD", "他人已先修改该元数据（ETag 过期），请刷新后合并重试", {
          currentEtag: metaEtag(current),
          yours: ifMatch,
        });
      }
      await client.query(
        `UPDATE assets SET meta_version = meta_version + 1,
            name = COALESCE($3, name)
          WHERE team_id = $1 AND id = $2`,
        [body.teamId, assetId, body.name ?? null]
      );
      if (body.labels) {
        await client.query(`DELETE FROM asset_labels WHERE team_id = $1 AND asset_id = $2`, [
          body.teamId,
          assetId,
        ]);
        for (const label of body.labels) {
          await client.query(
            `INSERT INTO asset_labels (team_id, asset_id, label) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [body.teamId, assetId, label]
          );
        }
      }
      return { ok: true, etag: metaEtag(current + 1) };
    });
  });

  // ---------- Session 分享检查与执行（C08） ----------
  // 规则：分享=把 visibility 提升为 project。分享前核对：
  //  a) 会话内引用资产的保密级别（secret/restricted 不可分享）
  //  b) 会话中不得包含创建者标记为"个人"的内容——首版以消息中显式 [private] 前缀为来源标记
  app.post("/sessions/:sessionId/share-check", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    await teamRole(auth.userId, body.teamId);
    return withTeam(body.teamId, async (client) => {
      const { rows: sess } = await client.query<{ visibility: string; created_by: string; title: string }>(
        `SELECT visibility, created_by, title FROM sessions WHERE team_id = $1 AND id = $2`,
        [body.teamId, sessionId]
      );
      if (!sess[0]) throw ERR.NOT_FOUND();
      if (sess[0].created_by !== auth.userId) throw ERR.FORBIDDEN("只有创建者可以分享会话");
      const blockers: string[] = [];
      // a) 引用资产的保密级别
      const { rows: refs } = await client.query<{ asset_id: string; name: string; properties: Record<string, unknown> }>(
        `SELECT DISTINCT a.id AS asset_id, a.name, r.properties
           FROM messages m
           JOIN sessions s ON s.team_id = m.team_id AND s.id = m.session_id
           JOIN asset_revisions r ON r.team_id = s.team_id
           JOIN assets a ON a.team_id = r.team_id AND a.id = r.asset_id
          WHERE m.team_id = $1 AND m.session_id = $2
            AND (m.content LIKE '%@' || a.name || '%' OR m.content LIKE '%' || r.id::text || '%')`,
        [body.teamId, sessionId]
      );
      for (const ref of refs) {
        const conf = String((ref.properties as any)?.confidentiality ?? "internal");
        if (conf === "secret" || conf === "restricted") {
          blockers.push(`引用资产「${ref.name}」保密级别为 ${conf}，不能分享到项目受众`);
        }
      }
      // b) 显式私有内容标记
      const { rows: privates } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM messages
          WHERE team_id = $1 AND session_id = $2 AND content LIKE '[private]%'`,
        [body.teamId, sessionId]
      );
      if (Number(privates[0]!.n) > 0) {
        blockers.push(`会话包含 ${privates[0]!.n} 条标记 [private] 的消息，需脱敏后才能分享`);
      }
      const digest = createHash("sha256")
        .update(`${body.teamId}:${sessionId}:${blockers.join("|")}`)
        .digest("hex");
      return {
        shareable: blockers.length === 0,
        blockers,
        checkDigest: digest.slice(0, 16),
        currentVisibility: sess[0].visibility,
      };
    });
  });

  app.post("/sessions/:sessionId/share", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { sessionId } = req.params as { sessionId: string };
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        confirmCheckDigest: z.string().min(4).max(32),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    const out = await withTeam(body.teamId, async (client) => {
      const { rows: sess } = await client.query<{ visibility: string; created_by: string }>(
        `SELECT visibility, created_by FROM sessions WHERE team_id = $1 AND id = $2 FOR UPDATE`,
        [body.teamId, sessionId]
      );
      if (!sess[0]) throw ERR.NOT_FOUND();
      if (sess[0].created_by !== auth.userId) throw ERR.FORBIDDEN("只有创建者可以分享会话");
      // 重新执行检查（检查与执行之间内容可能变化——摘要比对防止 TOCTOU）
      const { rows: refs } = await client.query<{ asset_id: string; name: string; properties: Record<string, unknown> }>(
        `SELECT DISTINCT a.id AS asset_id, a.name, r.properties
           FROM messages m
           JOIN sessions s ON s.team_id = m.team_id AND s.id = m.session_id
           JOIN asset_revisions r ON r.team_id = s.team_id
           JOIN assets a ON a.team_id = r.team_id AND a.id = r.asset_id
          WHERE m.team_id = $1 AND m.session_id = $2
            AND (m.content LIKE '%@' || a.name || '%' OR m.content LIKE '%' || r.id::text || '%')`,
        [body.teamId, sessionId]
      );
      const blockers: string[] = [];
      for (const ref of refs) {
        const conf = String((ref.properties as any)?.confidentiality ?? "internal");
        if (conf === "secret" || conf === "restricted") {
          blockers.push(`引用资产「${ref.name}」保密级别为 ${conf}，不能分享到项目受众`);
        }
      }
      const { rows: privates } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM messages
          WHERE team_id = $1 AND session_id = $2 AND content LIKE '[private]%'`,
        [body.teamId, sessionId]
      );
      if (Number(privates[0]!.n) > 0) {
        blockers.push(`会话包含 ${privates[0]!.n} 条标记 [private] 的消息，需脱敏后才能分享`);
      }
      const digest = createHash("sha256")
        .update(`${body.teamId}:${sessionId}:${blockers.join("|")}`)
        .digest("hex")
        .slice(0, 16);
      if (digest !== body.confirmCheckDigest) {
        throw ERR.CONFLICT("SHARE_CHECK_CHANGED", "分享检查已过期（内容变化或未先执行检查），请重新检查");
      }
      if (blockers.length > 0) {
        throw ERR.FORBIDDEN("分享被来源检查阻止");
      }
      await client.query(
        `UPDATE sessions SET visibility = 'project' WHERE team_id = $1 AND id = $2`,
        [body.teamId, sessionId]
      );
      return { visibility: "project" };
    });
    return reply.code(200).send(out);
  });
}
