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
    if (res.status === 401) throw new LlmError("LLM_AUTH", "模型鉴权失败（401）");
    if (res.status === 402) throw new LlmError("LLM_INSUFFICIENT_BALANCE", "模型账户余额不足（402）");
    if (res.status === 429) throw new LlmError("LLM_RATE_LIMIT", "模型限流（429）", true);
    if (!res.ok) throw new LlmError("LLM_HTTP", `模型 HTTP ${res.status}`);
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
}
