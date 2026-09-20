/**
 * M6 并发负载验证（真实并发 + 真实 API 延迟/吞吐测量）。
 * 夹具：1 团队 2,000 资产 × 5 修订（SQL 批量生成）。
 * 阶段：
 *   R 读并发 —— 16 worker × 40 op（search/detail/channel 混合）
 *   W 写并发 —— 8 worker × 15 次草稿保存（各自独立资产，无锁竞争）
 *   X 混合并发 —— 8 读 worker + 8 写 worker 同时运行，量化写负载对读 P95 的影响
 * 产出：docs/evidence/m6-concurrent-perf.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4311;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const runId = randomBytes(3).toString("hex");

process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
process.env.API_PORT = String(PORT);

interface PhaseResult {
  ops: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  throughputOpsPerSec: number;
}

const report: any = {
  runId,
  fixture: { assets: 2000, revisionsPerAsset: 5 },
  concurrency: { readWorkers: 16, writeWorkers: 8 },
  results: {} as Record<string, PhaseResult>,
  environment: { node: process.version, db: "pgvector/pgvector:pg16 (docker, local)" },
  startedAt: new Date().toISOString(),
};

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function summarize(latencies: number[], errors: number, wallMs: number): PhaseResult {
  return {
    ops: latencies.length + errors,
    errors,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: Math.max(...latencies),
    throughputOpsPerSec: Math.round(((latencies.length + errors) / wallMs) * 1000),
  };
}

interface Session { cookie: string; csrf: string }

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  if (res.status !== 201) throw new Error(`register ${email} → ${res.status}`);
  let cookie = "";
  let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { session: { cookie, csrf }, teamId: ((await res.json()) as { teamId: string }).teamId };
}

async function call(session: Session, method: string, path: string, body?: unknown): Promise<number> {
  const headers: Record<string, string> = { cookie: session.cookie, "x-csrf-token": session.csrf };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (res.status >= 400) await res.text(); // 排空
  return res.status;
}

/** 单个读 worker：混合 search / detail / channel 操作。 */
async function readWorker(
  session: Session, teamId: string, projectId: string, assetIds: string[],
  iterations: number, latencies: number[], errCount: { n: number }
): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    const kind = i % 4;
    const assetId = assetIds[(Math.random() * assetIds.length) | 0]!;
    const path = kind === 0
      ? `/assets/search?teamId=${teamId}&limit=50`
      : kind === 1
        ? `/assets/${assetId}?teamId=${teamId}`
        : kind === 2
          ? `/assets/search?teamId=${teamId}&q=${encodeURIComponent("资产 " + ((Math.random() * 2000) | 0))}&limit=20`
          : `/projects/${projectId}/channel?teamId=${teamId}&channel=stable`;
    const t0 = Date.now();
    try {
      const status = await call(session, "GET", path);
      if (status !== 200) errCount.n += 1;
      else latencies.push(Date.now() - t0);
    } catch {
      errCount.n += 1;
    }
  }
}

/** 单个写 worker 的分支名与资产段分配由调用方决定（见阶段 W / X）。 */
async function main(): Promise<void> {
  const { buildServer } = await import("../apps/api/src/server.js");
  const app = await buildServer();
  await app.listen({ port: PORT, host: "127.0.0.1" });

  const admin = await register(`perfca-${runId}@t.dev`, "并发管理员", `并发团队-${runId}`);
  const teamId = admin.teamId;
  const projRes = await fetch(`${BASE}/projects`, {
    method: "POST", headers: { "content-type": "application/json", cookie: admin.session.cookie, "x-csrf-token": admin.session.csrf },
    body: JSON.stringify({ teamId, name: "并发项目", code: `cperf-${runId}` }),
  });
  const projectId = ((await projRes.json()) as any).projectId as string;
  await fetch(`${BASE}/types?teamId=${teamId}`, { headers: { cookie: admin.session.cookie } });

  // 8 个写成员
  const writers: Session[] = [];
  for (let w = 0; w < 8; w++) {
    const m = await register(`perfcw${w}-${runId}@t.dev`, `并发写手${w}`, `旁-${w}-${runId}`);
    await fetch(`${BASE}/teams/${teamId}/members`, {
      method: "POST", headers: { "content-type": "application/json", cookie: admin.session.cookie, "x-csrf-token": admin.session.csrf },
      body: JSON.stringify({ email: `perfcw${w}-${runId}@t.dev`, role: "member" }),
    });
    writers.push(m.session);
  }

  // ---------- SQL 批量夹具：2,000 资产 × 5 修订 ----------
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN");
  await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
  const { rows: userRows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [`perfca-${runId}@t.dev`]);
  const userId = userRows[0]!.id;
  const { rows: typeRows } = await c.query<{ id: string }>(
    `SELECT id FROM asset_type_versions WHERE team_id = $1 AND type_key = 'simulation.model' LIMIT 1`, [teamId]);
  const typeId = typeRows[0]!.id;
  await c.query(
    `WITH e AS (
       INSERT INTO entities (team_id, id, kind)
       SELECT $1::uuid, gen_random_uuid(), 'asset' FROM generate_series(1, 2000)
       RETURNING team_id, id
     )
     INSERT INTO assets (team_id, id, name, current_type_version_id, created_by)
     SELECT e.team_id, e.id, '并发资产 ' || row_number() OVER (), $2::uuid, $3::uuid FROM e`,
    [teamId, typeId, userId]
  );
  await c.query(
    `INSERT INTO asset_revisions (team_id, id, asset_id, type_version_id, properties, content_digest, seq, created_by)
     SELECT $1::uuid, gen_random_uuid(), a.id, $2::uuid,
            jsonb_build_object('frame','ECI','timeScale','TAI','positionUnit','m','velocityUnit','m/s','interfaceVersion','load-v1','validStepSeconds', jsonb_build_object('min',0.1,'max',60)),
            encode(sha256((a.id::text || ':' || i::text)::bytea), 'hex'), i, $3::uuid
       FROM assets a CROSS JOIN generate_series(1, 5) i WHERE a.team_id = $1::uuid`,
    [teamId, typeId, userId]
  );
  const { rows: assetRows } = await c.query<{ id: string }>(
    `SELECT id FROM assets WHERE team_id = $1 ORDER BY created_at`, [teamId]);
  await c.query("COMMIT");
  await c.end();
  const assetIds = assetRows.map((r) => r.id);
  console.log(`夹具就绪：${assetIds.length} 资产 × 5 修订；${writers.length} 写成员`);

  // ---------- 阶段 R：读并发 ----------
  {
    const latencies: number[] = [];
    const err = { n: 0 };
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 16 }, () => readWorker(admin.session, teamId, projectId, assetIds, 40, latencies, err))
    );
    const wall = Date.now() - t0;
    report.results.readConcurrent = summarize(latencies, err.n, wall);
    console.log(`R 读并发(16w×40op): P50=${report.results.readConcurrent.p50Ms}ms P95=${report.results.readConcurrent.p95Ms}ms ` +
      `吞吐=${report.results.readConcurrent.throughputOpsPerSec}op/s 错误=${err.n}`);
  }

  // ---------- 阶段 W：写并发（各自资产，无竞争） ----------
  {
    const latencies: number[] = [];
    const err = { n: 0 };
    const per = 15;
    const t0 = Date.now();
    await Promise.all(writers.map(async (ws, w) => {
      // 每个 worker 独占一段连续资产段
      const seg = assetIds.slice(w * per, (w + 1) * per);
      const br = await call(ws, "POST", `/projects/${projectId}/branches`, { teamId, name: `loadw-${w}-${runId}` });
      if (br !== 201) { err.n += seg.length; return; }
      const branches = await fetch(`${BASE}/projects/${projectId}/branches?teamId=${teamId}`, { headers: { cookie: ws.cookie } });
      const list = (await branches.json()) as { id: string; name: string }[];
      const branchId = list.find((b) => b.name === `loadw-${w}-${runId}`)!.id;
      for (const assetId of seg) {
        const t1 = Date.now();
        try {
          const status = await call(ws, "POST", `/branches/${branchId}/revisions`, {
            teamId, assetId, properties: { interfaceVersion: `load-w${w}` },
          });
          if (status === 201) latencies.push(Date.now() - t1); else err.n += 1;
        } catch { err.n += 1; }
      }
    }));
    const wall = Date.now() - t0;
    report.results.writeConcurrent = summarize(latencies, err.n, wall);
    console.log(`W 写并发(8w×15op): P50=${report.results.writeConcurrent.p50Ms}ms P95=${report.results.writeConcurrent.p95Ms}ms ` +
      `吞吐=${report.results.writeConcurrent.throughputOpsPerSec}op/s 错误=${err.n}`);
  }

  // ---------- 阶段 X：读 + 写混合并发 ----------
  {
    const readLat: number[] = [];
    const writeLat: number[] = [];
    const readErr = { n: 0 };
    const writeErr = { n: 0 };
    const t0 = Date.now();
    await Promise.all([
      ...Array.from({ length: 8 }, () => readWorker(admin.session, teamId, projectId, assetIds, 40, readLat, readErr)),
      ...writers.map(async (ws, w) => {
        const per = 15;
        const seg = assetIds.slice(200 + w * per, 200 + (w + 1) * per);
        const brName = `loadx-${w}-${runId}`;
        const br = await call(ws, "POST", `/projects/${projectId}/branches`, { teamId, name: brName });
        if (br !== 201) { writeErr.n += seg.length; return; }
        const branches = await fetch(`${BASE}/projects/${projectId}/branches?teamId=${teamId}`, { headers: { cookie: ws.cookie } });
        const list = (await branches.json()) as { id: string; name: string }[];
        const branchId = list.find((b) => b.name === brName)!.id;
        for (const assetId of seg) {
          const t1 = Date.now();
          try {
            const status = await call(ws, "POST", `/branches/${branchId}/revisions`, {
              teamId, assetId, properties: { interfaceVersion: `loadx-w${w}` },
            });
            if (status === 201) writeLat.push(Date.now() - t1); else writeErr.n += 1;
          } catch { writeErr.n += 1; }
        }
      }),
    ]);
    const wall = Date.now() - t0;
    report.results.mixedRead = summarize(readLat, readErr.n, wall);
    report.results.mixedWrite = summarize(writeLat, writeErr.n, wall);
    console.log(`X 混合 读: P50=${report.results.mixedRead.p50Ms}ms P95=${report.results.mixedRead.p95Ms}ms 错误=${readErr.n} | ` +
      `写: P95=${report.results.mixedWrite.p95Ms}ms 错误=${writeErr.n}`);
    report.writeImpactOnReadP95 = {
      readOnlyP95Ms: report.results.readConcurrent.p95Ms,
      mixedP95Ms: report.results.mixedRead.p95Ms,
    };
  }

  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "docs", "evidence"), { recursive: true });
  writeFileSync(join(root, "docs", "evidence", "m6-concurrent-perf.json"), JSON.stringify(report, null, 2));
  await app.close();
  console.log("\n并发负载报告：docs/evidence/m6-concurrent-perf.json");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("perf-concurrent failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
