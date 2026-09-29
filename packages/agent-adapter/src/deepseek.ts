// DeepSeek Provider（OpenAI 兼容协议，官方 https://api.deepseek.com）。
// 真实调用：支持工具调用（function calling）、取消（AbortController）、错误处理。
// key 从服务端环境读取，绝不进入 Prompt/日志/导出。
import { loadEnvFile } from "./env.js";

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export interface ChatResult {
  message: ChatMessage;
  totalTokens: number;
  finishReason: string;
}

export class LlmError extends Error {
  constructor(public code: string, message: string, public retryable = false) {
    super(message);
  }
}

/** 流式聚合终态：内容全文、按 index 归并后的工具调用、用量与停止原因。 */
export interface StreamAggregated {
  content: string;
  toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  totalTokens: number;
  finishReason: string;
}

/**
 * OpenAI 兼容 SSE 流的纯累积器（M53）：逐行喂入、产出内容增量、按 index 归并工具调用分片。
 * 抽成纯函数是为了离线单测 SSE 解析（真实网络行为在 m53 集成测试覆盖）。
 * 容忍残帧：非法 JSON 行跳过（网络截断不该让整次运行崩溃，缺失内容由终态校验兜底）。
 */
export function createStreamAccumulator(onDelta?: (text: string) => void): {
  pushLine(line: string): void;
  result(): StreamAggregated;
} {
  let content = "";
  const toolCalls: StreamAggregated["toolCalls"] = [];
  const byIndex = new Map<number, StreamAggregated["toolCalls"][number]>();
  let totalTokens = 0;
  let finishReason = "";
  return {
    pushLine(line: string): void {
      const t = line.trim();
      if (!t.startsWith("data:")) return;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let chunk: {
        choices?: {
          delta?: { content?: string | null; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
          finish_reason?: string | null;
        }[];
        usage?: { total_tokens?: number };
      };
      try {
        chunk = JSON.parse(data);
      } catch {
        return;
      }
      if (chunk.usage?.total_tokens) totalTokens = chunk.usage.total_tokens;
      const choice = chunk.choices?.[0];
      if (!choice) return; // 含 usage 的收尾帧 choices 为空
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (delta.content) {
        content += delta.content;
        onDelta?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = byIndex.get(tc.index);
        if (!cur) {
          const created = {
            id: tc.id ?? "",
            type: "function" as const,
            function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" },
          };
          byIndex.set(tc.index, created);
          toolCalls.push(created);
          continue;
        }
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) {
          // 首片整名直接赋；后续若为续片（现有名是入参前缀）只补尾部，不重复拼接
          if (!cur.function.name || tc.function.name === cur.function.name) cur.function.name = tc.function.name;
          else if (tc.function.name.startsWith(cur.function.name)) cur.function.name = tc.function.name;
          else cur.function.name += tc.function.name;
        }
        if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      }
    },
    result(): StreamAggregated {
      return { content, toolCalls, totalTokens, finishReason };
    },
  };
}

export class DeepSeekProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string; model?: string }) {
    loadEnvFile();
    this.apiKey = opts?.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
    this.baseUrl = opts?.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
    this.model = opts?.model ?? process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
    if (!this.apiKey || this.apiKey === "replace-me") {
      throw new LlmError("LLM_NOT_CONFIGURED", "DEEPSEEK_API_KEY 未配置，Agent 运行被拒绝（不提供 mock 答复）");
    }
  }

  get modelName(): string {
    return this.model;
  }

  private static httpError(status: number): LlmError | null {
    if (status === 401) return new LlmError("LLM_AUTH", "模型鉴权失败（401）");
    if (status === 402) return new LlmError("LLM_INSUFFICIENT_BALANCE", "模型账户余额不足（402）");
    if (status === 429) return new LlmError("LLM_RATE_LIMIT", "模型限流（429）", true);
    if (status < 200 || status >= 300) return new LlmError("LLM_HTTP", `模型 HTTP ${status}`);
    return null;
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal?: AbortSignal
  ): Promise<ChatResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: 0.2,
        }),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new LlmError("LLM_CANCELLED", "模型调用已取消");
      throw new LlmError("LLM_UNREACHABLE", "模型服务不可达", true);
    }
    const httpErr = DeepSeekProvider.httpError(res.status);
    if (httpErr) throw httpErr;
    const data = (await res.json()) as {
      choices?: { message?: ChatMessage; finish_reason?: string }[];
      usage?: { total_tokens?: number };
    };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new LlmError("LLM_EMPTY", "模型返回为空");
    return {
      message: choice.message,
      totalTokens: data.usage?.total_tokens ?? 0,
      finishReason: choice.finish_reason ?? "stop",
    };
  }

  /**
   * 流式对话（M53）：SSE 逐块产出内容增量（onDelta 回调），终态聚合完整消息。
   * 工具调用分片按 index 归并；usage 取自收尾帧（stream_options.include_usage）。
   * 与 chat() 同构的返回形状，runner 可无缝替换。
   */
  async chatStream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    signal: AbortSignal | undefined,
    onDelta?: (text: string) => void
  ): Promise<ChatResult> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.length ? tools : undefined,
          temperature: 0.2,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new LlmError("LLM_CANCELLED", "模型调用已取消");
      throw new LlmError("LLM_UNREACHABLE", "模型服务不可达", true);
    }
    const httpErr = DeepSeekProvider.httpError(res.status);
    if (httpErr) throw httpErr;
    if (!res.body) throw new LlmError("LLM_EMPTY", "模型返回为空（无响应体）");
    const acc = createStreamAccumulator(onDelta);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          acc.pushLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      if (buf.trim()) acc.pushLine(buf);
    } catch (err) {
      if ((err as Error).name === "AbortError") throw new LlmError("LLM_CANCELLED", "模型调用已取消");
      if (err instanceof LlmError) throw err;
      throw new LlmError("LLM_STREAM", `流式读取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    const agg = acc.result();
    if (!agg.content && agg.toolCalls.length === 0) throw new LlmError("LLM_EMPTY", "模型返回为空");
    return {
      message: {
        role: "assistant",
        content: agg.content || null,
        ...(agg.toolCalls.length ? { tool_calls: agg.toolCalls } : {}),
      },
      totalTokens: agg.totalTokens,
      finishReason: agg.finishReason || "stop",
    };
  }
}
