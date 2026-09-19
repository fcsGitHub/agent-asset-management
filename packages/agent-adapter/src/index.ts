// @taw/agent-adapter — AgentAdapter 契约与 Provider 实现（设计 18 章）。
// 本系统接口示意；不声称是 Pi 上游现成 API。

export interface AuthorizedRunInput {
  runId: string;
  subjectId: string;
  teamId: string;
  projectId: string;
  sessionId: string;
  contextRefs: string[];
  allowedTools: string[];
  budget: { maxToolCalls: number; maxTokens: number };
  systemPrompt: string;
  userMessage: string;
}

export type RunEvent =
  | { type: "message_delta"; runId: string; seq: number; text: string }
  | { type: "tool_call"; runId: string; seq: number; callId: string; name: string; args: unknown }
  | { type: "tool_result"; runId: string; seq: number; callId: string; result: unknown }
  | { type: "completed"; runId: string; seq: number; finalText: string }
  | { type: "failed"; runId: string; seq: number; error: string }
  | { type: "cancelled"; runId: string; seq: number; reason: string };

export interface AgentAdapter {
  start(input: AuthorizedRunInput): AsyncIterable<RunEvent>;
  cancel(runId: string, reason: string): Promise<void>;
}
