// Agent 运行执行器（设计 18 章）：
// - 事件先落库再推送（可续接 SSE）
// - 每次工具调用经网关（含拒绝记录），消耗预算
// - 取消传播到模型请求（AbortController）
// - 未知外部结果 → unknown_reconcile，不盲目重试（D06）
// - 终态路径先写 run_events 再更新 agent_runs 状态（0019 时序不变量：
//   状态变更的 NOTIFY 必然晚于该运行全部事件的 NOTIFY，SSE 的 done 不会早到）
import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { getPool, withTeam, q } from "../db.js";
import { DeepSeekProvider, LlmError, type ChatMessage } from "@taw/agent-adapter/deepseek";
import { allAgentTools, toolSpecs, invokeTool, UnknownOutcomeError, type ToolContext } from "./tools.js";
import { loadEnvFile } from "@taw/agent-adapter/env";

loadEnvFile();

export { UnknownOutcomeError } from "./tools.js";
// 进程内取消注册表
const cancelControllers = new Map<string, AbortController>();

export async function appendEvent(
  teamId: string,
  runId: string,
  type: string,
  payload: unknown
): Promise<number> {
  const { rows } = await withTeam(teamId, async (client) =>
    client.query<{ seq: string }>(
      `INSERT INTO run_events (team_id, run_id, type, payload) VALUES ($1,$2,$3,$4) RETURNING seq`,
      [teamId, runId, type, JSON.stringify(payload ?? {})]
    )
  );
  return Number(rows[0]!.seq);
}

async function touchRun(
  teamId: string,
  runId: string,
  fields: { status?: string; result?: string; error?: string; used?: { toolCalls: number; tokens: number } }
): Promise<void> {
  await withTeam(teamId, async (client) => {
    const params: unknown[] = [];
    const sets: string[] = ["updated_at = now()"];
    if (fields.status !== undefined) { params.push(fields.status); sets.push(`status = $${params.length}`); }
    if (fields.result !== undefined) { params.push(fields.result); sets.push(`result = $${params.length}`); }
    if (fields.error !== undefined) { params.push(fields.error); sets.push(`error = $${params.length}`); }
    if (fields.used !== undefined) { params.push(JSON.stringify(fields.used)); sets.push(`used = $${params.length}::jsonb`); }
    params.push(runId);
    await client.query(
      `UPDATE agent_runs SET ${sets.join(", ")} WHERE id = $${params.length}::uuid`,
      params
    );
  });
}

export function requestCancel(teamId: string, runId: string): void {
  void q(`SELECT 1`).catch(() => undefined);
  const controller = cancelControllers.get(runId);
  if (controller) controller.abort();
  void withTeam(teamId, async (client) => {
    await client.query(`UPDATE agent_runs SET cancel_requested = true, updated_at = now() WHERE id = $1`, [runId]);
  }).catch(() => undefined);
}

export function activeRunCount(): number {
  return cancelControllers.size;
}

export function executeRun(runId: string): void {
  // 异步执行；不阻塞创建请求
  void runLoop(runId).catch((err: unknown) => {
    console.error("runLoop crashed:", err instanceof Error ? err.message : err);
  });
}

async function runLoop(runId: string): Promise<void> {
  const pool = getPool();
  // agent_runs 受 RLS，执行器通过 run_team_index 恢复映射定位 team
  const teamId: string | null = await readTeamIdBypassingRls(runId);
  if (!teamId) throw new Error(`run ${runId} not found`);
  void pool;

  const controller = new AbortController();
  cancelControllers.set(runId, controller);
  try {
    await touchRun(teamId, runId, { status: "running" });
    await appendEvent(teamId, runId, "run_started", {});

    const meta = await loadRunMeta(teamId, runId);
    let provider: DeepSeekProvider;
    try {
      provider = new DeepSeekProvider();
    } catch (err) {
      await appendEvent(teamId, runId, "failed", { error: (err as Error).message });
      await touchRun(teamId, runId, {
        status: "failed",
        error: err instanceof Error ? err.message : "LLM 配置错误",
      });
      return;
    }

    const tools = allAgentTools();
    // OpenAI 兼容协议要求工具名 ^[a-zA-Z0-9_-]+$；内部契约名（含点）与线上名双向映射
    const wireName = (n: string) => n.replace(/\./g, "__");
    const byWire = new Map(tools.map((t) => [wireName(t.name), t]));
    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是团队资产工作台的助手。你只能通过提供的工具读取本团队资产目录、创建 Issue、提交整理提案。" +
          "你没有任何发布、审批、权限或本体批准能力——这些动作属于人类管理员，工具清单里也不存在。" +
          "回答使用中文、简洁、引用具体资产名与修订号。完成任务后给出简短总结。",
      },
      { role: "user", content: buildUserPrompt(meta.prompt, meta.contextRefs) },
    ];

    let usedToolCalls = 0;
    let usedTokens = 0;
    const budget = meta.budget as { maxToolCalls: number; maxTokens: number };

    // 终态时序不变量的取消侧收尾：先事件后状态（见文件头注释）
    const finishCancelled = async (): Promise<void> => {
      await appendEvent(teamId, runId, "cancelled", { reason: "user" });
      await touchRun(teamId, runId, { status: "cancelled", error: "用户取消" });
    };

    for (let turn = 0; turn < 12; turn++) {
      if (controller.signal.aborted) {
        await finishCancelled();
        return;
      }
      // cancel_requested 是数据库中的持久取消请求：取消若在进程内 controller
      // 注册之前到达（慢机/排队积压窗口），abort 会丢失——每轮开始时兜底复查
      if (await isCancelRequested(teamId, runId)) {
        await finishCancelled();
        return;
      }
      const specs = toolSpecs(tools).map((t) => ({
        ...t,
        function: { ...t.function, name: wireName(t.function.name) },
      }));
      const chat = await provider.chat(messages, specs, controller.signal);
      usedTokens += chat.totalTokens;
      const msg = chat.message;
      if (msg.content) {
        await appendEvent(teamId, runId, "message", { role: "assistant", text: msg.content });
      }
      const toolCalls = msg.tool_calls ?? [];
      if (!toolCalls.length) {
        // 终态时序不变量：先事件后状态（见文件头注释）
        await appendEvent(teamId, runId, "completed", { finalText: msg.content ?? "" });
        await touchRun(teamId, runId, {
          status: "completed",
          result: msg.content ?? "",
          used: { toolCalls: usedToolCalls, tokens: usedTokens },
        });
        return;
      }
      messages.push(msg);
      for (const call of toolCalls) {
        // 线上名还原为内部契约名
        call.function.name = byWire.get(call.function.name)?.name ?? call.function.name;
        if (controller.signal.aborted) break;
        if (usedToolCalls >= budget.maxToolCalls) {
          await appendEvent(teamId, runId, "blocked", { reason: "budget_tool_calls", limit: budget.maxToolCalls });
          await touchRun(teamId, runId, {
            status: "blocked",
            error: "预算已用尽：工具调用次数达到上限，等待用户处置",
            used: { toolCalls: usedToolCalls, tokens: usedTokens },
          });
          return;
        }
        usedToolCalls++;
        await appendEvent(teamId, runId, "tool_call", { callId: call.id, name: call.function.name, args: safeParse(call.function.arguments) });
        const toolCtx: ToolContext = { teamId, userId: meta.createdBy, projectId: meta.projectId, runId };
        let invokeResult;
        try {
          invokeResult = await runToolCall(teamId, toolCtx, tools, call.id, call.function.name, call.function.arguments);
        } catch (err) {
          if (err instanceof UnknownOutcomeError) {
            await appendEvent(teamId, runId, "unknown_reconcile", { tool: call.function.name, detail: err.detail });
            await touchRun(teamId, runId, {
              status: "unknown_reconcile",
              error: `工具 ${call.function.name} 外部结果未知：${err.detail}`,
              used: { toolCalls: usedToolCalls, tokens: usedTokens },
            });
            return;
          }
          throw err;
        }
        await appendEvent(teamId, runId, "tool_result", {
          callId: call.id,
          name: call.function.name,
          status: invokeResult.status,
          result: invokeResult.status === "ok" ? invokeResult.result : null,
          error: invokeResult.error ?? "",
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify({ status: invokeResult.status, result: invokeResult.result, error: invokeResult.error }),
        });
      }
      if (usedTokens >= budget.maxTokens) {
        await appendEvent(teamId, runId, "blocked", { reason: "budget_tokens", limit: budget.maxTokens });
        await touchRun(teamId, runId, {
          status: "blocked",
          error: "预算已用尽：token 达到上限",
          used: { toolCalls: usedToolCalls, tokens: usedTokens },
        });
        return;
      }
    }
    // 轮数上限
    await appendEvent(teamId, runId, "blocked", { reason: "max_turns" });
    await touchRun(teamId, runId, { status: "blocked", error: "运行轮数达到上限" });
  } catch (err) {
    if (controller.signal.aborted || (err instanceof LlmError && err.code === "LLM_CANCELLED")) {
      await appendEvent(teamId, runId, "cancelled", { reason: "user" });
      await touchRun(teamId, runId, { status: "cancelled", error: "用户取消" });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    await appendEvent(teamId, runId, "failed", { error: message });
    await touchRun(teamId, runId, { status: "failed", error: message });
  } finally {
    cancelControllers.delete(runId);
  }
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

function buildUserPrompt(prompt: string, contextRefs: string[]): string {
  const refs = contextRefs.length ? `\n\n上下文引用：\n${contextRefs.join("\n")}` : "";
  return prompt + refs;
}

interface RunMeta {
  prompt: string;
  contextRefs: string[];
  projectId: string;
  createdBy: string;
  budget: unknown;
}

/** 持久取消标记：cancel 请求可能早于执行器注册 AbortController，每轮开始兜底复查。 */
async function isCancelRequested(teamId: string, runId: string): Promise<boolean> {
  return withTeam(teamId, async (client) => {
    const { rows } = await client.query<{ cancel_requested: boolean }>(
      `SELECT cancel_requested FROM agent_runs WHERE id = $1::uuid`,
      [runId]
    );
    return rows[0]?.cancel_requested === true;
  });
}

async function loadRunMeta(teamId: string, runId: string): Promise<RunMeta> {  return withTeam(teamId, async (client: PoolClient) => {
    const { rows } = await client.query<{
      prompt: string;
      context_refs: string[];
      project_id: string;
      created_by: string;
      budget: unknown;
    }>(`SELECT prompt, context_refs, project_id, created_by, budget FROM agent_runs WHERE id = $1`, [runId]);
    const r = rows[0]!;
    return { prompt: r.prompt, contextRefs: r.context_refs, projectId: r.project_id, createdBy: r.created_by, budget: r.budget };
  });
}

/** 恢复场景：run 行可能因崩溃停留在无租户上下文可读之外——通过运行 ID 索引表读取 team。
 * 恢复映射保存在无 RLS 的恢复表（仅服务端写）。 */
async function readTeamIdBypassingRls(runId: string): Promise<string | null> {
  const { rows } = await q<{ team_id: string }>(
    `SELECT team_id FROM run_team_index WHERE run_id = $1`, [runId]
  );
  return rows[0]?.team_id ?? null;
}

/** 单次工具调用：独立事务（调用记录与副作用同事务持久化）。 */
async function runToolCall(
  teamId: string,
  ctx: ToolContext,
  tools: ReturnType<typeof allAgentTools>,
  callId: string,
  name: string,
  rawArgs: string
) {
  return withTeam(teamId, async (client) => {
    try {
      return await invokeTool(client, ctx, tools, callId, name, rawArgs);
    } catch (err) {
      if (err instanceof UnknownOutcomeError) throw err;
      // 网关已捕获普通错误；此处仅透传未知异常
      throw err;
    }
  });
}

export function newCallId(): string {
  return randomUUID();
}
