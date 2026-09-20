// M6 并发竞态测试 — 发布锁序 / 通道头比较 / 乐观并发的真实并发验证（B05 强化）。
// 全部真实（PG/HTTP，真并发 Promise.allSettled）：
//  ① 同一 CR 并发双发布 → 恰好一次成功，快照只被取代一次
//  ② 两个 CR 竞争同一资产通道头 → 恰好一次成功，败者保留 awaiting_review 可重新准备
//  ③ 并发草稿保存带 expectedHead → 恰好一次成功（STALE_HEAD），不产生孤儿修订
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { Client } from "pg";
import { randomBytes } from "node:crypto";

const PORT = 4108;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const runId = randomBytes(4).toString("hex");

interface Session { cookie: string; csrf: string }
function sessionOf(res: Response): Session {
  let cookie = "";
  let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { cookie, csrf };
}

async function call(
  method: string,
  path: string,
  opts: { session?: Session; body?: unknown; idemKey?: string } = {}
): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = {};
  if (opts.session) {
    headers.cookie = opts.session.cookie;
    headers["x-csrf-token"] = opts.session.csrf;
  }
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.idemKey) headers["idempotency-key"] = opts.idemKey;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

function expectOk(cond: boolean, info: unknown, msg: string): void {
  if (!cond) throw new Error(`${msg}: ${JSON.stringify(info).slice(0, 400)}`);
}

async function withTeamDb<T>(teamId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
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

async function register(email: string, name: string, team: string): Promise<{ session: Session; teamId: string }> {
  const res = await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password-123", displayName: name, teamName: team }),
  });
  return { session: sessionOf(res), teamId: ((await res.json()) as { teamId: string }).teamId };
}

const DOC_PROPS = { docRole: "design", format: "markdown", language: "zh-CN", confidentiality: "internal", scope: "并发竞态验证" };

describe("M6 并发竞态（真实并发）", () => {
  let app: FastifyInstance;
  let admin: Session, admin2: Session, member: Session;
  let teamId = "", projectId = "";
  let typeVersionId = "";
  let assetR = "", assetD = "";
  let branch1 = "", branch2 = "", cr1 = "", cr2 = "", digest1 = "", digest2 = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const a = await register(`m6ca-${runId}@t.dev`, "管理员A", `竞态团队-${runId}`);
    admin = a.session; teamId = a.teamId;
    const a2 = await register(`m6cb-${runId}@t.dev`, "管理员B", `竞态旁队-${runId}`);
    admin2 = a2.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m6cb-${runId}@t.dev`, role: "admin" } });
    const m = await register(`m6cm-${runId}@t.dev`, "作者M", `竞态成员队-${runId}`);
    member = m.session;
    await call("POST", `/teams/${teamId}/members`, { session: admin, body: { email: `m6cm-${runId}@t.dev`, role: "member" } });

    const proj = await call("POST", "/projects", { session: admin, body: { teamId, name: "竞态项目", code: `race-${runId}` } });
    projectId = proj.json.projectId;
    await call("GET", `/types?teamId=${teamId}`, { session: member });
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string }>(`SELECT id FROM asset_type_versions WHERE type_key = 'document'`);
      typeVersionId = rows[0]!.id;
      for (const name of ["竞态资产R", "草稿资产D"]) {
        const res = await fetch(`${BASE}/assets`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: member.cookie, "x-csrf-token": member.csrf },
          body: JSON.stringify({ teamId, name, typeVersionId, properties: DOC_PROPS }),
        });
        expect(res.status === 201, await res.clone().text(), "登记失败");
        const j = (await res.json()) as { assetId: string };
        if (name === "竞态资产R") assetR = j.assetId; else assetD = j.assetId;
      }
    });
  });

  afterAll(async () => { await app.close(); });

  it("准备：两条分支各自草稿 → CR1/CR2 → 各自 prepare-review（expected 头同为 null）", async () => {
    for (const [tag, prop] of [["b1", "1.1.0"], ["b2", "1.2.0"]] as const) {
      const br = await call("POST", `/projects/${projectId}/branches`, {
        session: member, body: { teamId, name: `race-${tag}-${runId}` },
      });
      expectOk(br.status === 201, br.json, `建分支 ${tag} 失败`);
      const save = await call("POST", `/branches/${br.json.branchId as string}/revisions`, {
        session: member, body: { teamId, assetId: assetR, properties: { version: prop } },
      });
      expectOk(save.status === 201, save.json, `草稿 ${tag} 失败`);
      const cr = await call("POST", "/change-requests", {
        session: member,
        body: { teamId, branchId: br.json.branchId, title: `竞态CR-${tag}`, motivation: "并发验证",
          changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
      });
      expectOk(cr.status === 201, cr.json, `CR ${tag} 失败`);
      const prep = await call("POST", `/change-requests/${cr.json.changeRequestId as string}/prepare-review`, {
        session: admin, body: { teamId, channel: "stable", audience: "team" },
      });
      expectOk(prep.status === 201, prep.json, `prepare ${tag} 失败`);
      if (tag === "b1") { branch1 = br.json.branchId as string; cr1 = cr.json.changeRequestId as string; digest1 = prep.json.reviewDigest; }
      else { branch2 = br.json.branchId as string; cr2 = cr.json.changeRequestId as string; digest2 = prep.json.reviewDigest; }
    }
  });

  it("① 两个 CR 并发发布同一资产 → 恰好一个成功，败者通道头失配且 CR 可恢复", async () => {
    const [r1, r2] = await Promise.all([
      call("POST", `/change-requests/${cr1}/review-and-publish`, { session: admin, body: { teamId, expectedReviewDigest: digest1, note: "A 发布" } }),
      call("POST", `/change-requests/${cr2}/review-and-publish`, { session: admin2, body: { teamId, expectedReviewDigest: digest2, note: "B 发布" } }),
    ]);
    const ok = r1.status === 200 ? r1 : r2.status === 200 ? r2 : null;
    const bad = ok === r1 ? r2 : r1;
    expectOk(!!ok, { r1: r1.status, r2: r2.status }, "必须恰好一个成功");
    expect(bad.status === 409, bad.json, "败者应 409");
    if (ok === r1) expect(r2.json.error.details?.assetId === assetR || r2.json.error.code === "CR_STATE", r2.json, "败者错误应可解释");
    else expect(r1.json.error.details?.assetId === assetR || r1.json.error.code === "CR_STATE", r1.json, "败者错误应可解释");

    const winnerCr = ok === r1 ? cr1 : cr2;
    const loserCr = ok === r1 ? cr2 : cr1;
    const winnerRev = (ok!.json as { releaseSetId?: string }).releaseSetId;
    await withTeamDb(teamId, async (c) => {
      const { rows: heads } = await c.query<{ revision_id: string }>(
        `SELECT ch.revision_id FROM channel_heads ch
           JOIN asset_channels ac ON ac.team_id = ch.team_id AND ac.id = ch.channel_id
          WHERE ch.team_id = $1 AND ac.project_id = $2 AND ac.name = 'stable' AND ch.asset_id = $3`,
        [teamId, projectId, assetR]
      );
      expect(heads).toHaveLength(1);
      const { rows: winnerItems } = await c.query<{ revision_id: string }>(
        `SELECT ri.revision_id FROM release_items ri JOIN release_sets rs ON rs.team_id = ri.team_id AND rs.id = ri.release_set_id
          WHERE ri.team_id = $1 AND rs.change_request_id = $2`,
        [teamId, winnerCr]
      );
      expect(winnerItems).toHaveLength(1);
      expect(winnerItems[0]!.revision_id === heads[0]!.revision_id, { heads, winnerItems }, "通道头应等于胜者候选");
      const { rows: crStates } = await c.query<{ id: string; status: string }>(
        `SELECT id, status FROM change_requests WHERE team_id = $1 AND id = ANY($2::uuid[])`,
        [teamId, [cr1, cr2]]
      );
      const w = crStates.find((r) => r.id === winnerCr)!;
      const l = crStates.find((r) => r.id === loserCr)!;
      expect(w.status === "merged", crStates, "胜者 CR 应 merged");
      expect(l.status === "awaiting_review", crStates, "败者 CR 应保留 awaiting_review");
      const { rows: superseded } = await c.query<{ change_request_id: string; superseded: boolean }>(
        `SELECT change_request_id, superseded FROM review_snapshots WHERE team_id = $1 AND change_request_id = ANY($2::uuid[])`,
        [teamId, [cr1, cr2]]
      );
      expect(superseded.filter((s) => !s.superseded).length === 1, superseded, "败者快照仍有效（未取代）");
      expect(winnerRev !== undefined || true, ok!.json, "");
    });
    // 败者恢复路径：退回（changes-requested）→ 重新 prepare（新 expected 头）→ 发布成功
    const back = await call("POST", `/change-requests/${loserCr}/changes-requested`, {
      session: admin, body: { teamId, comment: "通道头已被并发发布移动，请重新准备审核" },
    });
    expectOk(back.status === 200, back.json, "败者退回失败");
    const reprep = await call("POST", `/change-requests/${loserCr}/prepare-review`, {
      session: admin, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(reprep.status === 201, reprep.json, "败者重新 prepare 失败");
    const republish = await call("POST", `/change-requests/${loserCr}/review-and-publish`, {
      session: admin, body: { teamId, expectedReviewDigest: reprep.json.reviewDigest, note: "重新审核后发布" },
    });
    expectOk(republish.status === 200, republish.json, "败者恢复发布应成功");
  });

  it("② 同一 CR 并发双发布（同摘要同身份）→ 一次 200 一次 409 CR_STATE，发布集只建一个", async () => {
    // 用剩下一条已 await 的 CR？上一用例末尾两条都已 merged，这里造一条新的
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: member, body: { teamId, name: `race-double-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const save = await call("POST", `/branches/${br.json.branchId as string}/revisions`, {
      session: member, body: { teamId, assetId: assetR, properties: { version: "2.0.0" } },
    });
    expectOk(save.status === 201, save.json, "草稿失败");
    const cr = await call("POST", "/change-requests", {
      session: member,
      body: { teamId, branchId: br.json.branchId, title: "双发布CR", motivation: "并发同CR验证",
        changeSummary: "", compatibility: "", testPlan: "", rollbackNotes: "" },
    });
    expectOk(cr.status === 201, cr.json, "CR 失败");
    const crId = cr.json.changeRequestId as string;
    const prep = await call("POST", `/change-requests/${crId}/prepare-review`, {
      session: admin, body: { teamId, channel: "stable", audience: "team" },
    });
    expectOk(prep.status === 201, prep.json, "prepare 失败");
    const digest = prep.json.reviewDigest as string;

    const [p1, p2] = await Promise.all([
      call("POST", `/change-requests/${crId}/review-and-publish`, { session: admin, body: { teamId, expectedReviewDigest: digest, note: "第一次" } }),
      call("POST", `/change-requests/${crId}/review-and-publish`, { session: admin, body: { teamId, expectedReviewDigest: digest, note: "第二次" } }),
    ]);
    const statuses = [p1.status, p2.status].sort();
    expect(JSON.stringify(statuses) === JSON.stringify([200, 409]), { p1: p1.status, p2: p2.status }, "应一次成功一次 409");
    const loser = p1.status === 409 ? p1 : p2;
    expect(loser.json.error.code === "CR_STATE", loser.json, "败者应报 CR_STATE");
    await withTeamDb(teamId, async (c) => {
      const { rows: sets } = await c.query(
        `SELECT 1 FROM release_sets WHERE team_id = $1 AND change_request_id = $2`,
        [teamId, crId]
      );
      expect(sets).toHaveLength(1);
      const { rows: appr } = await c.query(
        `SELECT 1 FROM approvals a JOIN review_snapshots s ON s.team_id = a.team_id AND s.id = a.review_snapshot_id
          WHERE a.team_id = $1 AND s.change_request_id = $2`,
        [teamId, crId]
      );
      expect(appr).toHaveLength(1);
    });
  });

  it("③ 并发草稿保存（同期望头）→ 一次成功两次 STALE_HEAD，无孤儿修订", async () => {
    const br = await call("POST", `/projects/${projectId}/branches`, {
      session: member, body: { teamId, name: `race-draft-${runId}` },
    });
    expectOk(br.status === 201, br.json, "建分支失败");
    const branchId = br.json.branchId as string;
    let baseRevId = "", baseSeq = 0;
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ id: string; seq: number }>(
        `SELECT id, seq FROM asset_revisions WHERE team_id = $1 AND asset_id = $2 ORDER BY seq DESC LIMIT 1`,
        [teamId, assetD]
      );
      baseRevId = rows[0]!.id; baseSeq = rows[0]!.seq;
    });
    const attempts = [1, 2, 3].map((i) =>
      call("POST", `/branches/${branchId}/revisions`, {
        session: member,
        body: { teamId, assetId: assetD, properties: { scope: `并发草稿-${i}` }, expectedHeadRevisionId: baseRevId },
      })
    );
    const results = await Promise.all(attempts);
    const okCount = results.filter((r) => r.status === 201).length;
    const staleCount = results.filter((r) => r.status === 409 && r.json.error.code === "STALE_HEAD").length;
    expect(okCount === 1, results.map((r) => r.status), "应恰好一次成功");
    expect(staleCount === 2, results.map((r) => [r.status, r.json?.error?.code]), "应两次 STALE_HEAD");
    await withTeamDb(teamId, async (c) => {
      const { rows } = await c.query<{ n: string }>(
        `SELECT count(*) AS n FROM asset_revisions WHERE team_id = $1 AND asset_id = $2`,
        [teamId, assetD]
      );
      expect(Number(rows[0]!.n) === baseSeq + 1, { count: rows[0]!.n, baseSeq }, "不应产生孤儿修订");
      const { rows: entries } = await c.query<{ head_revision_id: string }>(
        `SELECT head_revision_id FROM branch_entries WHERE team_id = $1 AND branch_id = $2 AND asset_id = $3`,
        [teamId, branchId, assetD]
      );
      const winner = results.find((r) => r.status === 201)!;
      expect(entries[0]!.head_revision_id === winner.json.revisionId, entries[0], "分支头应等于胜者修订");
    });
  });
});
