// 本地内容寻址 BlobStore（设计 14 章）：
// - 对象键由服务端生成：<root>/<teamId>/<sha256>，绝不采用用户文件名
// - 团队隔离目录；跨团队读取同摘要内容被路径隔离阻止
// - 写入临时文件后校验摘要再原子 rename
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, rename, readFile, stat, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import os from "node:os";
import { BLOB_DIGEST_RE, type BlobStore, type PutResult } from "./index.js";

export class LocalCasBlobStore implements BlobStore {
  constructor(private rootDir: string) {}

  private teamDir(teamId: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(teamId)) throw new Error("invalid team id");
    return resolve(join(this.rootDir, teamId));
  }

  private objectPath(teamId: string, digest: string): string {
    if (!BLOB_DIGEST_RE.test(digest)) throw new Error("invalid digest");
    const teamDir = this.teamDir(teamId);
    const p = resolve(join(teamDir, digest));
    if (!p.startsWith(teamDir)) throw new Error("path traversal blocked");
    return p;
  }

  /** 流式写入：从临时位置计算摘要，校验后原子转入内容库。 */
  async putFromSource(teamId: string, sourcePath: string): Promise<PutResult> {
    const { createReadStream } = await import("node:fs");
    const hash = createHash("sha256");
    let size = 0;
    const stream = createReadStream(sourcePath);
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
      size += (chunk as Buffer).length;
    }
    const digest = hash.digest("hex");
    const dest = this.objectPath(teamId, digest);
    await mkdir(dirname(dest), { recursive: true });
    try {
      await rm(dest, { force: true });
      await rename(sourcePath, dest);
    } catch (err) {
      // 跨设备（临时目录与内容库不同盘）时退回复制+校验后删除
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(sourcePath, dest);
      await rm(sourcePath, { force: true });
    }
    return { teamId, digest, size };
  }

  async put(teamId: string, content: Buffer): Promise<PutResult> {
    const digest = createHash("sha256").update(content).digest("hex");
    const dest = this.objectPath(teamId, digest);
    await mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${randomBytes(6).toString("hex")}`;
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    await rm(dest, { force: true });
    await rename(tmp, dest);
    return { teamId, digest, size: content.length };
  }

  async get(teamId: string, digest: string): Promise<Buffer> {
    return readFile(this.objectPath(teamId, digest));
  }

  async exists(teamId: string, digest: string): Promise<boolean> {
    try {
      await stat(this.objectPath(teamId, digest));
      return true;
    } catch {
      return false;
    }
  }
}

export function blobStoreFromEnv(): LocalCasBlobStore {
  const root = process.env.BLOBSTORE_ROOT ?? "./data/blobs";
  return new LocalCasBlobStore(resolve(root));
}
