// /api/v1/uploads — 文件接收（设计 14 章）：
// 流式接收 → 大小限制 → 摘要计算 → 内容寻址入库（对象键服务端生成）。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomUUID as uuid } from "node:crypto";
import { createWriteStream, mkdirSync, unlink } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { q, withTeam } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, newId, requireAuth } from "../auth.js";
import { blobStoreFromEnv } from "@taw/storage/local-cas";
import { parseBody } from "./auth.js";

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  const store = blobStoreFromEnv();
  // 临时目录与内容库同盘，保证 rename 原子性（不跨设备）
  const tmpDir = resolve(join(process.env.BLOBSTORE_ROOT ?? "./data/blobs", "tmp"));
  mkdirSync(tmpDir, { recursive: true });

  app.post("/uploads", async (req, reply) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();

    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) throw ERR.INVALID("缺少 multipart 文件字段");

    const tmpPath = join(tmpDir, `upload-${uuid()}`);
    const hash = createHash("sha256");
    let size = 0;
    const out = createWriteStream(tmpPath);
    try {
      await pipeline(
        file.file,
        async function* (source) {
          for await (const chunk of source) {
            const buf = chunk as Buffer;
            size += buf.length;
            if (size > MAX_UPLOAD_BYTES) throw ERR.INVALID("文件超过大小限制");
            hash.update(buf);
            yield buf;
          }
        },
        out
      );
    } catch (err) {
      unlink(tmpPath, () => undefined);
      throw err;
    }
    const digest = hash.digest("hex");
    const result = await store.putFromSource(teamId, tmpPath);
    const mediaType = file.mimetype || "application/octet-stream";

    const uploadId = newId();
    await withTeam(teamId, async (client) => {
      await client.query(
        `INSERT INTO blobs (team_id, digest, size, media_type) VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, digest) DO NOTHING`,
        [teamId, digest, size, mediaType]
      );
      await client.query(
        `INSERT INTO uploads (team_id, id, uploader_id, original_name, digest, size, media_type, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'ready')`,
        [teamId, uploadId, auth.userId, file.filename.slice(0, 255), digest, size, mediaType]
      );
    });
    return reply.code(201).send({
      teamId,
      uploadId,
      digest,
      size,
      mediaType,
      originalName: file.filename,
    });
  });

  app.get("/uploads/:uploadId", async (req) => {
    const auth = requireAuth(req);
    const { uploadId } = req.params as { uploadId: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId)) throw ERR.INVALID("teamId 查询参数缺失");
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();
    const { rows: ups } = await withTeam(teamId, async (client) =>
      client.query<{ id: string; digest: string; size: number; media_type: string; original_name: string; state: string }>(
        `SELECT id, digest, size, media_type, original_name, state FROM uploads WHERE team_id = $1 AND id = $2`,
        [teamId, uploadId]
      )
    );
    const up = ups[0];
    if (!up) throw ERR.NOT_FOUND();
    return {
      teamId,
      uploadId: up.id,
      digest: up.digest,
      size: up.size,
      mediaType: up.media_type,
      originalName: up.original_name,
      state: up.state,
    };
  });

  // 下载：重新授权（设计 14 章：下载必须能证明属于有权访问的对象）
  // M53（吸收 CKAN「资源随取随用」）：回原文件名（revision_artifacts 登记名），
  // 界面 <a download> 与浏览器另存名都拿到真实文件名而非摘要串。
  app.get("/blobs/:digest", async (req, reply) => {
    const auth = requireAuth(req);
    const { digest } = req.params as { digest: string };
    const teamId = String((req.query as { teamId?: string } | null)?.teamId ?? "");
    if (!/^[0-9a-f-]{36}$/.test(teamId) || !/^[0-9a-f]{64}$/.test(digest)) throw ERR.NOT_FOUND();
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();
    const exists = await store.exists(teamId, digest);
    if (!exists) throw ERR.NOT_FOUND();
    // 文件名登记在 revision_artifacts（RLS 表）：须带租户上下文查询，否则行不可见
    const originalName = await withTeam(teamId, async (client) => {
      const { rows } = await client.query<{ original_name: string }>(
        `SELECT original_name FROM revision_artifacts WHERE team_id = $1 AND blob_digest = $2 AND original_name <> '' LIMIT 1`,
        [teamId, digest]
      );
      return rows[0]?.original_name ?? "";
    });
    if (originalName) {
      // RFC 5987 filename*：中文名等非 ASCII 安全透传
      reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(originalName)}`);
    }
    const content = await store.get(teamId, digest);
    void resolve;
    return reply.header("content-type", "application/octet-stream").send(content);
  });
}
