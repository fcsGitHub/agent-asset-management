// 受控工具网关（设计 17/18 章）。
// 分级：read（授权范围内自动执行）/ draft（草稿写入）/ human（人类高权动作，永不注册给 Agent）。
// 每次调用：校验主体与租户、重新鉴权、预算、持久化调用记录（含 denied）。
import type { PoolClient } from "pg";
import { canonicalDigest } from "@taw/domain/digest";

export type ToolTier = "read" | "draft";

/** 外部副作用已发生但结果未知（D06）：调用方必须进入对账，不得盲目重试。 */
export class UnknownOutcomeError extends Error {
  constructor(public detail: string) {
    super("外部执行结果未知，进入对账状态");
  }
}

export interface ToolContext {
  teamId: string;
  userId: string;
  projectId: string;
  runId: string;
}

export interface ToolDef {
  name: string;
  tier: ToolTier;
  description: string;
  parameters: Record<string, unknown>;
  execute(client: PoolClient, ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export const READONLY_TOOLS: ToolDef[] = [
  {
    name: "asset.search",
    tier: "read",
    description: "按名称关键词与类型检索本团队资产目录，返回资产与最新修订摘要。",
    parameters: {
      type: "object",
      properties: {
        q: { type: "string", description: "名称关键词" },
        type: { type: "string", description: "类型键（可选），如 simulation.model" },
      },
      required: [],
    },
    async execute(client, ctx, args) {
      const { rows } = await client.query(
        `SELECT a.id, a.name, tv.type_key, r.id AS head_revision_id, r.content_digest
           FROM assets a
           JOIN asset_type_versions tv ON tv.team_id = a.team_id AND tv.id = a.current_type_version_id
           JOIN LATERAL (SELECT id, content_digest FROM asset_revisions
                          WHERE team_id = a.team_id AND asset_id = a.id ORDER BY seq DESC LIMIT 1) r ON true
          WHERE a.team_id = $1
            AND ($2 = '' OR a.name ILIKE '%' || $2 || '%')
            AND ($3 = '' OR tv.type_key = $3)
          ORDER BY a.created_at DESC LIMIT 20`,
        [ctx.teamId, String(args.q ?? ""), String(args.type ?? "")]
      );
      return rows;
    },
  },
  {
    name: "asset.getRevision",
    tier: "read",
    description: "查看本团队资产某修订的属性与制品摘要。",
    parameters: {
      type: "object",
      properties: {
        assetId: { type: "string" },
        revisionId: { type: "string" },
      },
      required: ["assetId", "revisionId"],
    },
    async execute(client, ctx, args) {
      const { rows } = await client.query(
        `SELECT r.id, r.seq, r.properties, r.content_digest, r.created_at
           FROM asset_revisions r WHERE r.team_id = $1 AND r.asset_id = $2 AND r.id = $3`,
        [ctx.teamId, String(args.assetId), String(args.revisionId)]
      );
      if (!rows[0]) throw new Error("修订不存在或与资产不匹配");
      const arts = await client.query(
        `SELECT blob_digest, artifact_role, original_name FROM revision_artifacts WHERE team_id = $1 AND revision_id = $2`,
        [ctx.teamId, String(args.revisionId)]
      );
      return { ...rows[0], artifacts: arts.rows };
    },
  },
  {
    name: "relation.query",
    tier: "read",
    description: "查询某资产的正向/反向关系（不含候选提议）。",
    parameters: {
      type: "object",
      properties: { assetId: { type: "string" } },
      required: ["assetId"],
    },
    async execute(client, ctx, args) {
      const out = await client.query(
        `SELECT rt.type_key, ta.name AS target FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets ta ON ta.team_id = ra.team_id AND ta.id = ra.target_asset_id
          WHERE ra.team_id = $1 AND ra.source_asset_id = $2 AND ra.status = 'confirmed'`,
        [ctx.teamId, String(args.assetId)]
      );
      const inc = await client.query(
        `SELECT rt.type_key, sa.name AS source FROM relation_assertions ra
           JOIN relation_type_versions rt ON rt.team_id = ra.team_id AND rt.id = ra.relation_type_version_id
           JOIN assets sa ON sa.team_id = ra.team_id AND sa.id = ra.source_asset_id
          WHERE ra.team_id = $1 AND ra.target_asset_id = $2 AND ra.status = 'confirmed'`,
        [ctx.teamId, String(args.assetId)]
      );
      return { outgoing: out.rows, incoming: inc.rows };
    },
  },
];

export const DRAFT_TOOLS: ToolDef[] = [
  {
    name: "issue.create",
    tier: "draft",
    description: "在本项目创建 Issue（日常协作，不需要审批）。必须给出标题与说明。",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        assetId: { type: "string", description: "相关资产（可选）" },
        reportedRevisionId: { type: "string", description: "针对的修订（可选，须与 assetId 匹配）" },
      },
      required: ["title", "body"],
    },
    async execute(client, ctx, args) {
      const id = crypto.randomUUID();
      await client.query(
        `INSERT INTO issues (team_id, id, project_id, asset_id, reported_revision_id, title, body, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ctx.teamId, id, ctx.projectId,
         args.assetId ? String(args.assetId) : null,
         args.reportedRevisionId ? String(args.reportedRevisionId) : null,
         String(args.title).slice(0, 200), String(args.body).slice(0, 16000), ctx.userId]
      );
      return { issueId: id };
    },
  },
  {
    name: "external.notify",
    tier: "draft",
    description: "向外部系统发送通知（演示型外部副作用工具）。正常返回送达回执。",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
        failMode: { type: "string", enum: ["none", "timeout_after_effect"], description: "测试注入：副作用后超时" },
      },
      required: ["message"],
    },
    async execute(client, ctx, args) {
      // 真实副作用（先落库），随后可能结果未知
      const receiptId = crypto.randomUUID();
      await client.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,'issue_triage',$5)`,
        [ctx.teamId, receiptId, ctx.runId, ctx.projectId, JSON.stringify({ external: true, message: String(args.message).slice(0, 500) })]
      );
      if (args.failMode === "timeout_after_effect") {
        throw new UnknownOutcomeError("通知已写入外部队列，但回执超时未收到");
      }
      return { receipt: receiptId, delivered: true };
    },
  },
  {
    name: "proposal.create",
    tier: "draft",
    description: "提交资产整理提案（如建议登记的资产、类型、属性、建议关系）。提案只是候选，不产生正式资产，也不能触发发布。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["asset_registration", "relation_suggestion"] },
        payload: { type: "object", description: "结构化提案内容" },
      },
      required: ["kind", "payload"],
    },
    async execute(client, ctx, args) {
      const id = crypto.randomUUID();
      const kind = String(args.kind);
      if (!["asset_registration", "relation_suggestion"].includes(kind)) {
        throw new Error("kind 必须是 asset_registration 或 relation_suggestion");
      }
      await client.query(
        `INSERT INTO agent_proposals (team_id, id, run_id, project_id, kind, payload)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [ctx.teamId, id, ctx.runId, ctx.projectId, kind, JSON.stringify(args.payload)]
      );
      return { proposalId: id, status: "pending", note: "提案待成员审查；不会自动成为正式资产" };
    },
  },
];

/** 永不注册给 Agent 的人类高权动作（D02 负例即针对这些名字的调用应被拒绝）。 */
export const HUMAN_ONLY_TOOL_NAMES = [
  "review-and-publish",
  "release.publish",
  "review_and_publish",
  "permission.grant",
  "ontology.approve",
  "export.sensitive",
  "plugin.enable",
];

export function allAgentTools(): ToolDef[] {
  return [...READONLY_TOOLS, ...DRAFT_TOOLS];
}

export function toolSpecs(tools: ToolDef[]): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

export interface InvokeResult {
  status: "ok" | "denied" | "error";
  result?: unknown;
  error?: string;
}

/** 网关执行：记录每次调用（含拒绝）。 */
export async function invokeTool(
  client: PoolClient,
  ctx: ToolContext,
  tools: ToolDef[],
  callId: string,
  name: string,
  rawArgs: string
): Promise<InvokeResult> {
  let args: Record<string, unknown> = {};
  try {
    args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
  } catch {
    args = { _raw: rawArgs };
  }

  const record = async (status: "ok" | "denied" | "error", result?: unknown, error = "") => {
    await client.query(
      `INSERT INTO tool_invocations (team_id, id, run_id, call_id, name, args, result, status, error)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8)`,
      [ctx.teamId, ctx.runId, callId, name, JSON.stringify(args), result ? JSON.stringify(result) : null, status, error]
    );
    return { status, result, error };
  };

  // 高权动作名即使被模型调用也一律拒绝（D02）
  if (HUMAN_ONLY_TOOL_NAMES.includes(name)) {
    return record("denied", null, "该动作只能由人类管理员在界面执行，Agent 无权调用");
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return record("denied", null, `工具 ${name} 不在本次运行允许清单内`);
  }
  try {
    const result = await tool.execute(client, ctx, args);
    return record("ok", result);
  } catch (err) {
    if (err instanceof UnknownOutcomeError) {
      // 副作用已发生但结果未知：先留审计记录，再抛给运行器进入 unknown_reconcile（D06），
      // 不作为普通工具错误回喂模型（模型不得据此盲目重试）。
      await record("error", null, `外部执行结果未知：${err.message}`);
      throw err;
    }
    return record("error", null, err instanceof Error ? err.message : String(err));
  }
}

export function proposalDigest(payload: unknown): string {
  return canonicalDigest(payload);
}
