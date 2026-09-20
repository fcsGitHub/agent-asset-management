/**
 * M6 韧性演练（真实执行，无任何模拟）：
 *  A. kill -9 崩溃注入 ×2 —— 写入突发窗口 + 发布事务窗口（SIGKILL，非优雅退出）
 *  B. 重启验证 —— 已确认写入持久、会话持久、发布事务原子（要么完整要么缺席）、outbox 不重不丢
 *  C. 冷启动引导 —— 全新空容器（模拟新主机）：建角色 → 从零迁移全部 schema → 全链路可用
 * 产出：docs/evidence/m6-crash-drill.json
 */
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { Client } from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const runId = randomBytes(3).toString("hex");
const MAIN_DB = "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const COLD_PORT = 5439;
const COLD_DB = `postgres://taw_app:taw_app_dev@127.0.0.1:${COLD_PORT}/taw`;
const COLD_ADMIN_DB = `postgres://taw_admin:taw_admin_dev@127.0.0.1:${COLD_PORT}/taw`;

const report: any = { runId, startedAt: new Date().toISOString(), steps: [] };
function step(name: string, ok: boolean, detail: unknown): void {
  report.steps.push({ name, ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 500) });
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : " — " + JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) throw new Error(`步骤失败: ${name}`);
}
function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", shell: "bash" });
}

let child: ReturnType<typeof spawn> | null = null;

async function startApi(port: number, dbUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    child = spawn(process.execPath, [tsxCli, "apps/api/src/server.ts"], {
      cwd: root,
      env: { ...process.env, API_PORT: String(port), DATABASE_URL: dbUrl },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const alive = await waitReady(port, 20000);
    if (alive) return;
    await killChild();
    await sleep(1000);
  }
  throw new Error(`API 在端口 ${port} 启动失败`);
}

async function killChild(): Promise<void> {
  if (child) {
    child.kill("SIGKILL");
    child = null;
  }
  await sleep(400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitReady(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/projects`);
      if (res.status === 401) return true; // 服务在，未登录即 401
    } catch { /* 未就绪 */ }
    await sleep(300);
  }
  return false;
}

interface Session { cookie: string; csrf: string }

async function register(base: string, email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${base}/auth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  if (res.status !== 201) throw new Error(`register → ${res.status}: ${await res.text()}`);
  let cookie = ""; let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { session: { cookie, csrf }, teamId: ((await res.json()) as { teamId: string }).teamId };
}

async function call(base: string, session: Session, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { cookie: session.cookie, "x-csrf-token": session.csrf };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function withTeamDb<T>(dbUrl: string, teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
    return await fn(c);
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
}

async function main(): Promise<void> {
  const API1 = 4320;
  const BASE1 = `http://127.0.0.1:${API1}/api/v1`;

  // ---------- A. 启动 + 建真实数据 ----------
  await startApi(API1, MAIN_DB);
  step("API 启动（子进程，可被 kill -9）", true, { port: API1 });

  const { session, teamId } = await register(BASE1, `crash-${runId}@t.dev`, "崩溃演练员", `崩溃团队-${runId}`);
  // 成员身份：负责提交 CR（作者分离——发布者不能是 CR 作者）
  const member = await register(BASE1, `crashm-${runId}@t.dev`, "崩溃成员", `崩溃旁队-${runId}`);
  await call(BASE1, session, "POST", `/teams/${teamId}/members`, { email: `crashm-${runId}@t.dev`, role: "member" });
  const proj = await call(BASE1, session, "POST", "/projects", { teamId, name: "崩溃演练项目", code: `crash-${runId}` });
  const projectId = proj.json.projectId as string;
  await call(BASE1, session, "GET", `/types?teamId=${teamId}`);
  let typeVersionId = "";
  await withTeamDb(MAIN_DB, teamId, async (c) => {
    const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
    typeVersionId = rows[0]!.id;
  });
  const assetRes = await call(BASE1, session, "POST", "/assets", {
    teamId, name: "崩溃演练资产", typeVersionId,
    properties: { docRole: "design", format: "markdown", language: "zh-CN", confidentiality: "internal", scope: "崩溃一致性" },
  });
  const assetId = assetRes.json.assetId as string;
  const br = await call(BASE1, session, "POST", `/projects/${projectId}/branches`, { teamId, name: `crash-${runId}` });
  const branchId = br.json.branchId as string;
  // 已确认写入：这条必须在崩溃后完好
  const ack = await call(BASE1, session, "POST", `/branches/${branchId}/revisions`, {
    teamId, assetId, properties: { scope: "崩溃前已确认写入" },
  });
  step("崩溃前基线（用户/项目/资产/分支/已确认草稿）", ack.status === 201, { assetId, ackedRevision: ack.json.revisionId });
  const ackedRevisionId = ack.json.revisionId as string;

  // ---------- B. 窗口一：写入突发中 kill -9 ----------
  const burst = Array.from({ length: 5 }, (_, i) =>
    call(BASE1, session, "POST", `/branches/${branchId}/revisions`, {
      teamId, assetId, properties: { scope: `突发写入-${i}` },
    }).then((r) => ({ i, status: r.status, revisionId: r.json?.revisionId, digest: r.json?.contentDigest }))
      .catch(() => ({ i, status: 0 }))
  );
  await sleep(25); // 让部分请求已到达、部分仍在处理中
  await killChild();
  step("kill -9（写入突发进行中，SIGKILL）", true, {});
  const burstSettled = await Promise.all(burst);
  const ackedBurst = burstSettled.filter((r) => r.status === 201);
  console.log(`  突发 5 写：崩溃前收到确认 ${ackedBurst.length} 条，其余为进行中被切断`);

  await startApi(API1, MAIN_DB);
  step("API 重启（同一数据库）", true, {});

  // 已确认写入持久性：ack 基线 + 崩溃前确认的突发写入必须全部在场且摘要一致
  const survivors = await withTeamDb(MAIN_DB, teamId, async (c) => {
    const { rows } = await c.query<{ id: string; content_digest: string }>(
      `SELECT id, content_digest FROM asset_revisions WHERE team_id = $1 AND asset_id = $2`,
      [teamId, assetId]
    );
    return rows;
  });
  const allAcked = [{ revisionId: ackedRevisionId, digest: ack.json.contentDigest }, ...ackedBurst];
  const lost = allAcked.filter((a) => !survivors.some((s) => s.id === a.revisionId && s.content_digest === a.digest));
  step("已确认写入崩溃后全部持久（含摘要一致）", lost.length === 0, { acked: allAcked.length, lost });

  // 会话持久：崩溃前的登录会话重启后依然有效
  const sessionOk = await call(BASE1, session, "GET", `/assets/${assetId}?teamId=${teamId}`);
  step("崩溃前登录会话重启后仍有效", sessionOk.status === 200, { status: sessionOk.status });

  // ---------- C. 窗口二：发布事务中 kill -9 ----------
  const save = await call(BASE1, member.session, "POST", `/branches/${branchId}/revisions`, {
    teamId, assetId, properties: { scope: "发布候选" },
  });
  const cr = await call(BASE1, member.session, "POST", "/change-requests", {
    teamId, branchId, title: "崩溃窗口发布", motivation: "发布事务原子性演练",
    changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "",
  });
  const crId = cr.json.changeRequestId as string;
  const prep = await call(BASE1, member.session, "POST", `/change-requests/${crId}/prepare-review`, {
    teamId, channel: "stable", audience: "team",
  });
  step("发布链准备到 prepare-review", prep.status === 201, { crId });
  const digest = prep.json.reviewDigest as string;

  // 确定性事务中段崩溃：独立连接持有 CR 行锁 → 发布事务开启后即停在第一步（未写任何数据），
  // 此刻 kill -9。相比盲等定时窗口，这保证崩溃点一定位于打开的事务内。
  const locker = new Client({ connectionString: MAIN_DB });
  await locker.connect();
  await locker.query("BEGIN");
  await locker.query("SELECT set_config('app.team_id', $1, true)", [teamId]);
  await locker.query(`SELECT id FROM change_requests WHERE team_id = $1 AND id = $2 FOR UPDATE`, [teamId, crId]);
  const publishPromise = call(BASE1, session, "POST", `/change-requests/${crId}/review-and-publish`, {
    teamId, expectedReviewDigest: digest, note: "崩溃窗口发布（管理员）",
  }).then((r) => ({ status: r.status })).catch(() => ({ status: 0 }));
  await sleep(400); // 发布请求已到达并停在 CR 行锁上
  await killChild();
  await locker.query("ROLLBACK").catch(() => undefined);
  await locker.end();
  step("kill -9（发布事务已开启、停在行锁上，SIGKILL）", true, {});
  const publishOutcome = await publishPromise;
  console.log(`  发布请求：崩溃前收到响应 = ${publishOutcome.status !== 0 ? publishOutcome.status : "无（进行中被切断）"}`);

  await startApi(API1, MAIN_DB);
  step("API 二次重启", true, {});

  // 原子性不变量：release_set / approval / 通道头 / main 视图 / outbox —— 要么全有要么全无
  const atom = await withTeamDb(MAIN_DB, teamId, async (c) => {
    const { rows: sets } = await c.query(`SELECT id FROM release_sets WHERE team_id = $1 AND change_request_id = $2`, [teamId, crId]);
    const { rows: crRow } = await c.query<{ status: string }>(`SELECT status FROM change_requests WHERE team_id = $1 AND id = $2`, [teamId, crId]);
    const { rows: heads } = await c.query<{ revision_id: string | null }>(
      `SELECT ch.revision_id FROM channel_heads ch
         JOIN asset_channels ac ON ac.team_id = ch.team_id AND ac.id = ch.channel_id
        WHERE ch.team_id = $1 AND ac.project_id = $2 AND ac.name = 'stable' AND ch.asset_id = $3`,
      [teamId, projectId, assetId]
    );
    const { rows: appr } = await c.query(
      `SELECT 1 FROM approvals a JOIN review_snapshots s ON s.team_id = a.team_id AND s.id = a.review_snapshot_id
        WHERE a.team_id = $1 AND s.change_request_id = $2`, [teamId, crId]);
    const { rows: mainHead } = await c.query<{ head_revision_id: string }>(
      `SELECT e.head_revision_id FROM branch_entries e JOIN branches b ON b.team_id = e.team_id AND b.id = e.branch_id
        WHERE e.team_id = $1 AND b.project_id = $2 AND b.name = 'main' AND e.asset_id = $3`,
      [teamId, projectId, assetId]);
    const { rows: outbox } = await c.query(
      `SELECT 1 FROM outbox WHERE team_id = $1 AND payload::text LIKE $2`, [teamId, `%${crId}%`]);
    return { sets: sets.length, crStatus: crRow[0]?.status, head: heads[0]?.revision_id ?? null, approvals: appr.length, hasMainHead: mainHead.length > 0, outboxRows: outbox.length };
  });
  const published = atom.sets > 0;
  const consistent = published
    ? atom.approvals > 0 && atom.head !== null && atom.hasMainHead && atom.outboxRows > 0 && atom.crStatus === "merged"
    : atom.approvals === 0 && atom.head === null && !atom.hasMainHead && atom.crStatus !== "merged";
  step("发布事务崩溃原子性（全有或全无）", consistent, { published, ...atom });
  report.publishAtomicityOutcome = published ? "已提交（崩溃前完成）" : "已回滚（崩溃中断事务）";

  // outbox 恰好一次：同一发布事件不得出现重复行
  const dup = await withTeamDb(MAIN_DB, teamId, async (c) => {
    const { rows } = await c.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
         SELECT payload::text, count(*) AS cnt FROM outbox WHERE team_id = $1 GROUP BY payload::text HAVING count(*) > 1
       ) d`, [teamId]);
    return Number(rows[0]!.n);
  });
  step("outbox 无重复事件", dup === 0, { duplicateGroups: dup });

  // ---------- D. 冷启动引导（全新空容器，模拟新主机） ----------
  sh(`docker rm -f taw-pg-coldstart > /dev/null 2>&1; docker volume rm taw_pgdata_coldstart6 > /dev/null 2>&1; true`);
  sh(`docker run -d --name taw-pg-coldstart -e POSTGRES_DB=taw -e POSTGRES_USER=taw_admin -e POSTGRES_PASSWORD=taw_admin_dev ` +
    `-p 127.0.0.1:${COLD_PORT}:5432 -v taw_pgdata_coldstart6:/var/lib/postgresql/data pgvector/pgvector:pg16`);
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if (sh(`docker exec taw-pg-coldstart pg_isready -U taw_admin -d taw`).includes("accepting")) { ready = true; break; } } catch { /* 等待 */ }
    await sleep(500);
  }
  step("冷启动容器就绪（空卷，5439）", ready, {});
  sh(`docker exec taw-pg-coldstart psql -U taw_admin -d taw -c "CREATE ROLE taw_app LOGIN PASSWORD 'taw_app_dev' NOSUPERUSER NOCREATEDB NOCREATEROLE; GRANT USAGE ON SCHEMA public TO taw_app;"`);
  step("角色预创建（角色不在 dump/迁移中）", true, {});
  const mig = spawn(process.execPath, [tsxCli, "scripts/migrate.ts", "--role=admin"], {
    cwd: root, env: { ...process.env, DATABASE_ADMIN_URL: COLD_ADMIN_DB }, stdio: "ignore",
  });
  const migOk = await new Promise<boolean>((resolve) => mig.on("exit", (code) => resolve(code === 0)));
  step("从零迁移（空库 → 全部 schema）", migOk, {});
  report.coldStartMigrations = "0 → 全部迁移应用";

  const API2 = 4321;
  await startApi(API2, COLD_DB);
  const BASE2 = `http://127.0.0.1:${API2}/api/v1`;
  const cold = await register(BASE2, `cold-${runId}@t.dev`, "冷启动验证员", `冷启动团队-${runId}`);
  const coldMember = await register(BASE2, `coldm-${runId}@t.dev`, "冷启动成员", `冷启动旁队-${runId}`);
  await call(BASE2, cold.session, "POST", `/teams/${cold.teamId}/members`, { email: `coldm-${runId}@t.dev`, role: "member" });
  const coldProj = await call(BASE2, cold.session, "POST", "/projects", { teamId: cold.teamId, name: "冷启动项目", code: `cold-${runId}` });
  const coldProjectId = coldProj.json.projectId as string;
  await call(BASE2, cold.session, "GET", `/types?teamId=${cold.teamId}`);
  let coldType = "";
  await withTeamDb(COLD_DB, cold.teamId, async (c) => {
    const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
    coldType = rows[0]!.id;
  });
  const coldAsset = await call(BASE2, cold.session, "POST", "/assets", {
    teamId: cold.teamId, name: "冷启动资产", typeVersionId: coldType,
    properties: { docRole: "manual", format: "markdown", language: "zh-CN", confidentiality: "public", scope: "冷启动" },
  });
  const coldBr = await call(BASE2, coldMember.session, "POST", `/projects/${coldProjectId}/branches`, { teamId: cold.teamId, name: `cold-${runId}` });
  const coldSave = await call(BASE2, coldMember.session, "POST", `/branches/${coldBr.json.branchId as string}/revisions`, {
    teamId: cold.teamId, assetId: coldAsset.json.assetId, properties: { scope: "冷启动草稿" },
  });
  const coldCr = await call(BASE2, coldMember.session, "POST", "/change-requests", {
    teamId: cold.teamId, branchId: coldBr.json.branchId, title: "冷启动发布", motivation: "冷启动全链路",
    changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "",
  });
  const coldPrep = await call(BASE2, coldMember.session, "POST", `/change-requests/${coldCr.json.changeRequestId as string}/prepare-review`, {
    teamId: cold.teamId, channel: "stable", audience: "team",
  });
  const coldPub = await call(BASE2, cold.session, "POST", `/change-requests/${coldCr.json.changeRequestId as string}/review-and-publish`, {
    teamId: cold.teamId, expectedReviewDigest: coldPrep.json.reviewDigest, note: "冷启动管理员发布",
  });
  const coldChannel = await call(BASE2, cold.session, "GET", `/projects/${coldProjectId}/channel?teamId=${cold.teamId}&channel=stable`);
  step("冷启动全链路（注册→资产→分支→CR→发布→通道视图）",
    coldPub.status === 200 && coldChannel.status === 200, { publish: coldPub.status, channel: coldChannel.status });
  await killChild();

  // ---------- 清理冷启动容器（保留证据） ----------
  sh(`docker rm -f taw-pg-coldstart > /dev/null 2>&1; docker volume rm taw_pgdata_coldstart6 > /dev/null 2>&1; true`);
  step("冷启动容器清理", true, {});

  report.finishedAt = new Date().toISOString();
  mkdirSync(join(root, "docs", "evidence"), { recursive: true });
  writeFileSync(join(root, "docs", "evidence", "m6-crash-drill.json"), JSON.stringify(report, null, 2));
  console.log("\n崩溃演练报告：docs/evidence/m6-crash-drill.json");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("crash drill failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
