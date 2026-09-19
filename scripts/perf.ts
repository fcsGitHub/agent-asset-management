/**
 * E05 性能验证（真实数据量 + 真实 API 延迟测量）。
 * 夹具：1 团队 5,000 资产 / 50,000 修订 / 100,000 关系（SQL 批量生成，非逐条 API）。
 * 测量：资产列表 P50/P95、资产详情 P50/P95、通道视图 P50/P95；
 *       发布事务单次端到端（分支→保存→CR→prepare→publish）真实耗时。
 * 产出：docs/evidence/m5-perf-report.json
 */
import { execSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4310;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const runId = randomBytes(3).toString("hex");

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
process.env.API_PORT = String(PORT);

interface Sample { p50: number; p95: number; n: number; max: number }

const report: any = {
  runId,
  fixture: { assets: 5000, revisions: 50000, relations: 100000 },
  targets: { listDetailP95Ms: 1000 },
  results: {},
  environment: { node: process.version, db: "pgvector/pgvector:pg16 (docker, local)" },
  startedAt: new Date().toISOString(),
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function measure(name: string, n: number, fn: () => Promise<void>): Promise<Sample> {
  // 预热
  for (let i = 0; i < 5; i++) await fn();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    await fn();
    samples.push(Date.now() - t0);
  }
  const s = { p50: percentile(samples, 50), p95: percentile(samples, 95), n, max: Math.max(...samples) };
  report.results[name] = s;
  console.log(`${name}: P50=${s.p50}ms P95=${s.p95}ms max=${s.max}ms (n=${n})`);
  return s;
}

async function main(): Promise<void> {
  // API 服务
  const { buildServer } = await import("../apps/api/src/server.js");
  const app = await buildServer();
  await app.listen({ port: PORT, host: "127.0.0.1" });

  // 注册用户（受 RLS 需要真实成员关系）
  const reg = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `perf-${runId}@t.dev`, password: "password-123", displayName: "性能员", teamName: `性能团队-${runId}` }),
  });
  const teamId = ((await reg.json()) as any).teamId as string;
  const cookies = (reg.headers.getSetCookie().map((s) => s.split(";")[0])).join("; ");
  const csrfMatch = reg.headers.getSetCookie().find((s) => s.startsWith("taw_csrf="))!;
  const csrf = csrfMatch.split(";")[0]!.split("=")[1]!;
  const projRes = await fetch(`${BASE}/projects`, {
    method: "POST", headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
    body: JSON.stringify({ teamId, name: "性能项目", code: `perf-${runId}` }),
  });
  const projectId = ((await projRes.json()) as any).projectId as string;

  // 类型定义播种
  await fetch(`${BASE}/types?teamId=${teamId}`, { headers: { cookie: cookies } });

  // ---------- SQL 批量夹具 ----------
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  console.log("生成夹具数据（5k 资产 / 50k 修订 / 100k 关系）…");
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
  const { rows: userRows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`perf-${runId}@t.dev`]);
  const userId = userRows[0]!.id;
  const { rows: typeRows2 } = await c.query<{ id: string }>(
    `SELECT id FROM asset_type_versions WHERE team_id = $1 AND type_key = 'simulation.model' LIMIT 1`, [teamId]);
  const typeId = typeRows2[0]!.id;
  // 5,000 个实体与资产
  await c.query(
    `WITH e AS (
       INSERT INTO entities (team_id, id, kind)
       SELECT $1::uuid, gen_random_uuid(), 'asset' FROM generate_series(1, 5000)
       RETURNING team_id, id
     )
     INSERT INTO assets (team_id, id, name, current_type_version_id, created_by)
     SELECT e.team_id, e.id, '性能资产 ' || row_number() OVER (), $2::uuid, $3::uuid FROM e`,
    [teamId, typeId, userId]
  );
  await c.query(`CREATE TEMP TABLE tmp_assets AS SELECT id FROM assets WHERE team_id = $1`, [teamId]);
  // 每资产 10 个修订 → 50,000
  await c.query(
    `INSERT INTO asset_revisions (team_id, id, asset_id, type_version_id, properties, content_digest, seq, created_by)
     SELECT $1::uuid, gen_random_uuid(), a.id, $2::uuid,
            jsonb_build_object('frame','ECI','timeScale','TAI','positionUnit','m','velocityUnit','m/s','interfaceVersion','perf-v1','validStepSeconds', jsonb_build_object('min',0.1,'max',60)),
            encode(sha256((a.id::text || ':' || i::text)::bytea), 'hex'), i, $3::uuid
       FROM tmp_assets a CROSS JOIN generate_series(1, 10) i`,
    [teamId, typeId, userId]
  );
  // 关系：每资产指向 20 个不同资产 → 100,000
  await c.query(
    `INSERT INTO relation_assertions (team_id, id, relation_type_version_id, source_asset_id, target_asset_id, proposed_by, confirmed_by, status)
     SELECT $1::uuid, gen_random_uuid(), rt.id, a.id, b.id, $2::uuid, $2::uuid, 'confirmed'
       FROM tmp_assets a
       CROSS JOIN LATERAL (
         SELECT t.id FROM tmp_assets t WHERE t.id <> a.id ORDER BY t.id OFFSET (random()*4900)::int LIMIT 20
       ) b
       CROSS JOIN LATERAL (SELECT id FROM relation_type_versions WHERE team_id = $1::uuid AND type_key = 'dependsOn' LIMIT 1) rt`,
    [teamId, userId]
  );
  await c.query("COMMIT");
  await c.end();
  // 计数走管理连接（应用角色受 RLS 限制看不到全库口径）
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (adminUrl) {
    const ca = new Client({ connectionString: adminUrl });
    await ca.connect();
    const { rows: counts } = await ca.query<{ assets: string; revisions: string }>(
      `SELECT (SELECT count(*) FROM assets)::text AS assets,
              (SELECT count(*) FROM asset_revisions)::text AS revisions`);
    console.log("全库夹具规模:", counts);
    await ca.end();
  }

  // ---------- 延迟测量 ----------
  await measure("assets.search(空关键词, 50条)", 60, async () => {
    const r = await fetch(`${BASE}/assets/search?teamId=${teamId}&limit=50`, { headers: { cookie: cookies } });
    if (r.status !== 200) throw new Error("search failed " + r.status);
  });
  await measure("assets.detail(含修订历史)", 60, async () => {
    const { Client: C2 } = await import("pg");
    const c2 = new C2({ connectionString: process.env.DATABASE_URL });
    await c2.connect();
    await c2.query("BEGIN");
    await c2.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    const { rows } = await c2.query<{ id: string }>(
      `SELECT id FROM assets WHERE team_id = $1 ORDER BY created_at DESC LIMIT 1 OFFSET (random()*4000)::int`, [teamId]);
    await c2.query("ROLLBACK");
    await c2.end();
    const r = await fetch(`${BASE}/assets/${rows[0]!.id}?teamId=${teamId}`, { headers: { cookie: cookies } });
    if (r.status !== 200) throw new Error("detail failed");
  });
  await measure("channel.view(稳定通道)", 40, async () => {
    const r = await fetch(`${BASE}/projects/${projectId}/channel?teamId=${teamId}&channel=stable`, { headers: { cookie: cookies } });
    if (r.status !== 200) throw new Error("channel failed");
  });

  // ---------- 发布事务端到端（真实链路一次；成员提交、管理员发布） ----------
  const regM = await fetch(`${BASE}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `perf-m-${runId}@t.dev`, password: "password-123", displayName: "性能成员", teamName: `旁-${runId}` }),
  });
  const memberCookies = regM.headers.getSetCookie().map((s2) => s2.split(";")[0]).join("; ");
  const memberCsrf = (regM.headers.getSetCookie().find((s2) => s2.startsWith("taw_csrf=")) ?? "").split(";")[0]!.split("=")[1]!;
  await fetch(`${BASE}/teams/${teamId}/members`, {
    method: "POST", headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
    body: JSON.stringify({ email: `perf-m-${runId}@t.dev`, role: "member" }),
  });
  const t0 = Date.now();
  const br = await fetch(`${BASE}/projects/${projectId}/branches`, {
    method: "POST", headers: { "content-type": "application/json", cookie: memberCookies, "x-csrf-token": memberCsrf },
    body: JSON.stringify({ teamId, name: `perf-${runId}` }),
  });
  const branchId = ((await br.json()) as any).branchId as string;
  const c2 = new Client({ connectionString: process.env.DATABASE_URL });
  await c2.connect();
  await c2.query("BEGIN");
  await c2.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
  const { rows: a1 } = await c2.query<{ id: string }>(`SELECT id FROM assets WHERE team_id = $1 LIMIT 1`, [teamId]);
  const { rows: rev } = await c2.query<{ id: string; content_digest: string; type_version_id: string }>(
    `SELECT id, content_digest, type_version_id FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT 1`, [teamId, a1[0]!.id]);
  await c2.query("ROLLBACK");
  await c2.end();
  await fetch(`${BASE}/branches/${branchId}/revisions`, {
    method: "POST", headers: { "content-type": "application/json", cookie: memberCookies, "x-csrf-token": memberCsrf },
    body: JSON.stringify({ teamId, assetId: a1[0]!.id, properties: { interfaceVersion: "perf-v2" } }),
  });
  const cr = await fetch(`${BASE}/change-requests`, {
    method: "POST", headers: { "content-type": "application/json", cookie: memberCookies, "x-csrf-token": memberCsrf },
    body: JSON.stringify({ teamId, branchId, title: "性能发布", motivation: "E05" }),
  });
  const crId = ((await cr.json()) as any).changeRequestId as string;
  const prep = await fetch(`${BASE}/change-requests/${crId}/prepare-review`, {
    method: "POST", headers: { "content-type": "application/json", cookie: memberCookies, "x-csrf-token": memberCsrf },
    body: JSON.stringify({ teamId }),
  });
  const prepJson = (await prep.json()) as any;
  const pub = await fetch(`${BASE}/change-requests/${crId}/review-and-publish`, {
    method: "POST", headers: { "content-type": "application/json", cookie: cookies, "x-csrf-token": csrf },
    body: JSON.stringify({ teamId, expectedReviewDigest: prepJson.reviewDigest }),
  });
  const publishMs = Date.now() - t0;
  report.results.publishTransactionE2E = { ms: publishMs, ok: pub.status === 200 };
  console.log(`publishTransactionE2E: ${publishMs}ms (status ${pub.status})`);

  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "docs", "evidence"), { recursive: true });
  writeFileSync(join(root, "docs", "evidence", "m5-perf-report.json"), JSON.stringify(report, null, 2));
  await app.close();
  console.log("\n性能报告：docs/evidence/m5-perf-report.json");
  void execSync; void spawn;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("perf failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
