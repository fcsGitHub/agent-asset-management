/**
 * 恢复实例验证（由 e2e-m5-restore.ts 以独立进程启动，DATABASE_URL 指向恢复库）。
 * 验证：登录/资产/修订摘要/blob sha256/已撤销会话仍被拒绝/outbox 不重复。
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";

const BASE = `http://127.0.0.1:${process.env.API_PORT}/api/v1`;
const cookie = process.env.VERIFY_COOKIE + "; ";
const csrf = process.env.VERIFY_CSRF!;
const teamId = process.env.VERIFY_TEAM_ID!;
const assetId = process.env.VERIFY_ASSET!;
const revisionId = process.env.VERIFY_REVISION!;
const blobDigest = process.env.VERIFY_BLOB_DIGEST!;
const blobContent = process.env.VERIFY_BLOB_CONTENT!;
const revokedCookie = process.env.VERIFY_REVOKED_COOKIE.includes("taw_csrf") ? process.env.VERIFY_REVOKED_COOKIE : process.env.VERIFY_REVOKED_COOKIE + "; ";

async function step(name: string, ok: boolean, detail: unknown): Promise<void> {
  console.log(`${ok ? "OK" : "FAIL"} ${name} :: ${JSON.stringify(detail).slice(0, 200)}`);
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  // 自起 API 服务（连接恢复库）
  const { buildServer } = await import("../apps/api/src/server.js");
  const app = await buildServer();
  await app.listen({ port: Number(process.env.API_PORT ?? 4301), host: "127.0.0.1" });

  await step("恢复库可连通（/auth/me 用原会话）", (await (await fetch(`${BASE}/auth/me`, { headers: { cookie } })).text()).includes("恢复验证员"), {});

  // 资产与修订摘要一致
  const asset = await (await fetch(`${BASE}/assets/${assetId}?teamId=${teamId}`, { headers: { cookie } })).json() as any;
  await step("资产在新实例可读", !!asset?.id, asset);
  const rev = asset.revisions.find((r: any) => r.id === revisionId);
  await step("修订存在且摘要一致（64 hex）", !!rev && /^[0-9a-f]{64}$/.test(rev.content_digest), rev);

  // blob 内容 sha256 与摘要一致
  const blobRes = await fetch(`${BASE}/blobs/${blobDigest}?teamId=${teamId}`, { headers: { cookie } });
  const text = await blobRes.text();
  const sha = createHash("sha256").update(text).digest("hex");
  await step("blob 可下载且 sha256 匹配", blobRes.status === 200 && sha === blobDigest, { sha: sha.slice(0, 12) + "…", expected: blobDigest.slice(0, 12) + "…" });
  void statSync;

  // 已撤销会话在恢复后仍被拒绝
  const revoked = await fetch(`${BASE}/auth/me`, { headers: { cookie: revokedCookie } });
  await step("已撤销会话恢复后仍 401", revoked.status === 401, revoked.status);

  // outbox：事件存在且不重复（发布事件唯一）
  const { Client } = await import("pg");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
  const { rows: events } = await c.query<{ event_type: string; n: string }>(
    `SELECT event_type, count(*)::text AS n FROM outbox GROUP BY event_type`);
  await c.query("ROLLBACK");
  await c.end();
  const publish = events.find((e) => e.event_type === "ReleasePublished");
  await step("outbox 发布事件恰一条（不重复）", publish?.n === "1", events);

  await app.close();
  console.log("VERIFY_PASS");
}

main().catch((err) => {
  console.error("VERIFY_FAIL", err instanceof Error ? err.message : err);
  process.exit(1);
});
