// /api/v1/collections — 资产集合（M56，HF Datasets Collections 思想）。
// 人工策展的跨类型资产组：权威榜单 / 新人入门包 / 评审材料包。与自动检索互补——
// 集合成员是人的判断（含每条备注），机器检索负责发现，集合负责沉淀。
// 管理权（改名/改描述/删集合）= 创建者或管理员；条目增删改备注 = 全员日常协作（同 Issues）。
// M67⑤ 只读分享快照（Zenodo/HF snapshot 冻结语义）：深拷贝当前内容 + 128-bit token，
// GET /share/collections/:token 免登录只读；分享是治理动作 → 管理权同集合管理。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { q, withTeam, withShareRead } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";

async function teamRole(userId: string, teamId: string): Promise<string> {
  const { rows } = await q<{ role: string }>(
    `SELECT role FROM team_members WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId]
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  return rows[0].role;
}

async function requireCollectionManagePermission(
  teamId: string,
  collectionId: string,
  userId: string,
  role: string
): Promise<void> {
  const { rows } = await withTeam(teamId, async (client) =>
    client.query<{ created_by: string }>(
      `SELECT created_by FROM asset_collections WHERE team_id = $1 AND id = $2`,
      [teamId, collectionId]
    )
  );
  if (!rows[0]) throw ERR.NOT_FOUND();
  if (rows[0].created_by !== userId && role !== "admin") throw ERR.FORBIDDEN();
}

export async function collectionRoutes(app: FastifyInstance): Promise<void> {
  app.post("/collections", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().min(1).max(80),
        description: z.string().max(500).default(""),
      }),
      req.body
    );
    const id = newId();
    // 成员校验：RLS 只隔离行，不校验调用者归属——teamId 来自请求体，必须显式验证（同 house 模式）
    await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      try {
        await client.query(
          `INSERT INTO asset_collections (team_id, id, name, description, created_by) VALUES ($1,$2,$3,$4,$5)`,
          [body.teamId, id, body.name.trim(), body.description.trim(), auth.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw ERR.CONFLICT("COLLECTION_TAKEN", `集合「${body.name.trim()}」已存在`);
        }
        throw err;
      }
    });
    return reply.code(201).send({ teamId: body.teamId, collectionId: id });
  });

  // 列表：item_count 聚合；传 assetId 时附 contains_asset（详情页「加入集合」勾选态用）
  app.get("/collections", async (req) => {
    const auth = requireAuth(req);
    const query = (req.query ?? {}) as { teamId?: string; assetId?: string };
    const teamId = String(query.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const assetId = String(query.assetId ?? "");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.name, c.description, c.created_by, c.created_at,
                u.display_name AS created_by_name,
                (SELECT count(*)::int FROM asset_collection_items i WHERE i.team_id = c.team_id AND i.collection_id = c.id) AS item_count
           FROM asset_collections c JOIN users u ON u.id = c.created_by
          WHERE c.team_id = $1
          ORDER BY c.created_at DESC`,
        [teamId]
      );
      if (assetId && /^[0-9a-f-]{36}$/.test(assetId)) {
        const { rows: mine } = await client.query(
          `SELECT collection_id FROM asset_collection_items WHERE team_id = $1 AND asset_id = $2`,
          [teamId, assetId]
        );
        const set = new Set(mine.map((r) => r.collection_id));
        return rows.map((r) => ({ ...r, contains_asset: set.has(r.id) }));
      }
      return rows.map((r) => ({ ...r, contains_asset: null }));
    });
  });

  app.get("/collections/:collectionId", async (req) => {
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query(
        `SELECT c.id, c.name, c.description, c.created_by, c.created_at, u.display_name AS created_by_name
           FROM asset_collections c JOIN users u ON u.id = c.created_by
          WHERE c.team_id = $1 AND c.id = $2`,
        [teamId, collectionId]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      const { rows: items } = await client.query(
        `SELECT i.asset_id, i.note, i.added_at, au.display_name AS added_by_name,
                a.name AS asset_name, a.lifecycle, a.created_at AS asset_created_at,
                tv.type_key, tv.title AS type_title, tv.version AS type_version
           FROM asset_collection_items i
           JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN users au ON au.id = i.added_by
          WHERE i.team_id = $1 AND i.collection_id = $2
          ORDER BY i.added_at DESC`,
        [teamId, collectionId]
      );
      return { ...rows[0], items };
    });
  });

  app.patch("/collections/:collectionId", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        description: z.string().max(500).optional(),
      }),
      req.body
    );
    const role = await teamRole(auth.userId, body.teamId);
    await requireCollectionManagePermission(body.teamId, collectionId, auth.userId, role);
    // 权限检查已 404 化缺失集合；改名撞名 → 409，同名单击为无害 no-op
    await withTeam(body.teamId, async (client) => {
      if (body.name !== undefined) {
        const name = body.name.trim();
        try {
          await client.query(
            `UPDATE asset_collections SET name = $3 WHERE team_id = $1 AND id = $2`,
            [body.teamId, collectionId, name]
          );
        } catch (err) {
          if ((err as { code?: string }).code === "23505") {
            throw ERR.CONFLICT("COLLECTION_TAKEN", `集合「${name}」已存在`);
          }
          throw err;
        }
      }
      if (body.description !== undefined) {
        await client.query(
          `UPDATE asset_collections SET description = $3 WHERE team_id = $1 AND id = $2`,
          [body.teamId, collectionId, body.description.trim()]
        );
      }
    });
    return reply.code(200).send({ ok: true });
  });

  app.delete("/collections/:collectionId", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const role = await teamRole(auth.userId, teamId);
    await requireCollectionManagePermission(teamId, collectionId, auth.userId, role);
    const { rowCount } = await withTeam(teamId, async (client) =>
      client.query(`DELETE FROM asset_collections WHERE team_id = $1 AND id = $2`, [teamId, collectionId])
    );
    if (!rowCount) throw ERR.NOT_FOUND();
    return reply.code(200).send({ ok: true });
  });

  app.post("/collections/:collectionId/items", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        assetId: z.string().uuid(),
        note: z.string().max(500).default(""),
      }),
      req.body
    );
    await teamRole(auth.userId, body.teamId);
    await withTeam(body.teamId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM asset_collections WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        collectionId,
      ]);
      if (!rows[0]) throw ERR.NOT_FOUND();
      const { rows: asset } = await client.query(`SELECT 1 FROM assets WHERE team_id = $1 AND id = $2`, [
        body.teamId,
        body.assetId,
      ]);
      if (!asset[0]) throw ERR.INVALID("资产不存在于本团队");
      try {
        await client.query(
          `INSERT INTO asset_collection_items (team_id, collection_id, asset_id, note, added_by) VALUES ($1,$2,$3,$4,$5)`,
          [body.teamId, collectionId, body.assetId, body.note.trim(), auth.userId]
        );
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw ERR.CONFLICT("ITEM_EXISTS", "该资产已在此集合中");
        }
        throw err;
      }
    });
    return reply.code(201).send({ ok: true });
  });

  app.patch("/collections/:collectionId/items/:assetId", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId, assetId } = req.params as { collectionId: string; assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId) || !/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const body = parseBody(z.object({ teamId: z.string().uuid(), note: z.string().max(500) }), req.body);
    await teamRole(auth.userId, body.teamId);
    const { rowCount } = await withTeam(body.teamId, async (client) =>
      client.query(
        `UPDATE asset_collection_items SET note = $4 WHERE team_id = $1 AND collection_id = $2 AND asset_id = $3`,
        [body.teamId, collectionId, assetId, body.note.trim()]
      )
    );
    if (!rowCount) throw ERR.NOT_FOUND();
    return reply.code(200).send({ ok: true });
  });

  app.delete("/collections/:collectionId/items/:assetId", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId, assetId } = req.params as { collectionId: string; assetId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId) || !/^[0-9a-f-]{36}$/.test(assetId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    const { rowCount } = await withTeam(teamId, async (client) =>
      client.query(
        `DELETE FROM asset_collection_items WHERE team_id = $1 AND collection_id = $2 AND asset_id = $3`,
        [teamId, collectionId, assetId]
      )
    );
    if (!rowCount) throw ERR.NOT_FOUND();
    return reply.code(200).send({ ok: true });
  });

  // ---------- 只读分享快照（M67⑤）----------
  // 冻结当前集合内容（名称/描述/条目元数据/head 内容摘要）+ 签发 token。
  // 快照不含 teamId/用户 id/制品内容——对外只分享元数据与内容指纹。
  app.post("/collections/:collectionId/snapshots", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const body = parseBody(z.object({ teamId: z.string().uuid() }), req.body);
    const role = await teamRole(auth.userId, body.teamId);
    await requireCollectionManagePermission(body.teamId, collectionId, auth.userId, role);
    // 事务内只返回纯对象，COMMIT 后再 send——reply.send() 在事务回调内调用会在
    // COMMIT 前刷出响应，紧随的读取会竞态扑空（M67 走查发现，同 meta-share 口径）
    const out = await withTeam(body.teamId, async (client) => {
      const { rows: cols } = await client.query<{ name: string; description: string }>(
        `SELECT name, description FROM asset_collections WHERE team_id = $1 AND id = $2`,
        [body.teamId, collectionId]
      );
      if (!cols[0]) throw ERR.NOT_FOUND();
      const { rows: items } = await client.query(
        `SELECT i.note, i.added_at,
                a.name AS asset_name, a.lifecycle,
                tv.type_key, tv.version AS type_version,
                (SELECT r.content_digest FROM asset_revisions r
                  WHERE r.team_id = a.team_id AND r.asset_id = a.id ORDER BY r.seq DESC LIMIT 1) AS content_digest
           FROM asset_collection_items i
           JOIN assets a ON a.team_id = i.team_id AND a.id = i.asset_id
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
          WHERE i.team_id = $1 AND i.collection_id = $2
          ORDER BY i.added_at DESC`,
        [body.teamId, collectionId]
      );
      if (items.length > 500) {
        throw ERR.INVALID(`集合条目 ${items.length} 条超过分享快照上限（500），请先精简集合`);
      }
      const payload = {
        collectionName: cols[0].name,
        description: cols[0].description,
        items: items.map((r: Record<string, unknown>) => ({
          name: r.asset_name,
          typeKey: r.type_key,
          typeVersion: r.type_version,
          lifecycle: r.lifecycle,
          note: r.note,
          addedAt: r.added_at,
          contentDigest: r.content_digest,
        })),
      };
      const snapshotId = newId();
      const token = randomBytes(16).toString("hex");
      await client.query(
        `INSERT INTO asset_collection_snapshots (team_id, id, collection_id, token, collection_name, description, created_by, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [body.teamId, snapshotId, collectionId, token, cols[0].name, cols[0].description, auth.userId, JSON.stringify(payload)]
      );
      return {
        snapshotId,
        token,
        shareUrl: `/share/collection/${token}`,
        itemCount: items.length,
      };
    });
    return reply.code(201).send(out);
  });

  // 团队内快照清单（管理端：查看历史分享链接）
  app.get("/collections/:collectionId/snapshots", async (req) => {
    const auth = requireAuth(req);
    const { collectionId } = req.params as { collectionId: string };
    if (!/^[0-9a-f-]{36}$/.test(collectionId)) throw ERR.NOT_FOUND();
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    await teamRole(auth.userId, teamId);
    return withTeam(teamId, async (client) => {
      const { rows } = await client.query<{ id: string; token: string; item_count: number; created_at: Date }>(
        `SELECT id, token, jsonb_array_length(payload->'items')::int AS item_count, created_at
           FROM asset_collection_snapshots
          WHERE team_id = $1 AND collection_id = $2
          ORDER BY created_at DESC`,
        [teamId, collectionId]
      );
      return rows.map((r) => ({ snapshotId: r.id, token: r.token, shareUrl: `/share/collection/${r.token}`, itemCount: r.item_count, createdAt: r.created_at }));
    });
  });
}

// 免登录只读分享查看：RLS 走 public_share_read 策略（withShareRead 事务内
// SET LOCAL app.share_read='on'——只有这一个代码路径能开该通道，其余端点照常被
// 租户策略拦住）。内容=payload 深拷贝，永不随集合后续变化；不回显 teamId。
export async function collectionShareRoutes(app: FastifyInstance): Promise<void> {
  app.get("/share/collections/:token", async (req) => {
    const { token } = req.params as { token: string };
    if (!/^[0-9a-f]{32}$/.test(token)) throw ERR.NOT_FOUND();
    return withShareRead(async (client) => {
      const { rows } = await client.query<{ collection_name: string; payload: Record<string, unknown>; created_at: Date }>(
        `SELECT collection_name, payload, created_at FROM asset_collection_snapshots WHERE token = $1`,
        [token]
      );
      if (!rows[0]) throw ERR.NOT_FOUND();
      return {
        collectionName: rows[0].collection_name,
        createdAt: rows[0].created_at,
        payload: rows[0].payload,
      };
    });
  });
}
