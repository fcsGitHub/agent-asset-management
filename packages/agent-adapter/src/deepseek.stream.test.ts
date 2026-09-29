// M53 流式累积器单测：OpenAI 兼容 SSE 分片 → 内容增量 + 工具调用归并 + 用量。
// 离线纯函数测试（真实网络流在 tests/m53-agent-stream.test.ts 覆盖）。
import { describe, expect, it } from "vitest";
import { createStreamAccumulator } from "./deepseek.js";

const frame = (obj: unknown): string => `data: ${JSON.stringify(obj)}`;

describe("createStreamAccumulator", () => {
  it("内容分片按序拼接，onDelta 逐片回调", () => {
    const seen: string[] = [];
    const acc = createStreamAccumulator((d) => seen.push(d));
    acc.pushLine(frame({ choices: [{ delta: { content: "资产" }, finish_reason: null }] }));
    acc.pushLine("");
    acc.pushLine(frame({ choices: [{ delta: { content: "管理" }, finish_reason: null }] }));
    acc.pushLine(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
    acc.pushLine("data: [DONE]");
    const r = acc.result();
    expect(r.content).toBe("资产管理");
    expect(seen).toEqual(["资产", "管理"]);
    expect(r.finishReason).toBe("stop");
    expect(r.toolCalls).toHaveLength(0);
  });

  it("工具调用分片按 index 归并，arguments 跨片拼接", () => {
    const acc = createStreamAccumulator();
    acc.pushLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "asset__search", arguments: "{\"q\":" } }] } }],
    }));
    acc.pushLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"轨道\"}" } }] } }],
    }));
    acc.pushLine(frame({
      choices: [{ delta: { tool_calls: [
        { index: 1, id: "call-2", type: "function", function: { name: "graph__path", arguments: "{\"from\":\"A\",\"to\":\"B\"}" } },
      ] } }],
    }));
    acc.pushLine(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
    const r = acc.result();
    expect(r.finishReason).toBe("tool_calls");
    expect(r.toolCalls).toHaveLength(2);
    expect(r.toolCalls[0]).toEqual({ id: "call-1", type: "function", function: { name: "asset__search", arguments: '{"q":"轨道"}' } });
    expect(r.toolCalls[1]!.id).toBe("call-2");
    expect(r.toolCalls[1]!.function.name).toBe("graph__path");
  });

  it("收尾 usage 帧（choices 为空）计入 totalTokens；[DONE] 与残帧容忍", () => {
    const acc = createStreamAccumulator();
    acc.pushLine(frame({ choices: [{ delta: { content: "ok" } }] }));
    acc.pushLine(frame({ choices: [], usage: { total_tokens: 1234 } }));
    acc.pushLine("data: [DONE]");
    acc.pushLine("event: ping");              // 非 data 行忽略
    acc.pushLine("data: {broken json");       // 残帧跳过不抛
    acc.pushLine("data: ");                   // 空数据行忽略
    const r = acc.result();
    expect(r.content).toBe("ok");
    expect(r.totalTokens).toBe(1234);
  });

  it("混合内容与工具调用（先文本后调用）", () => {
    const acc = createStreamAccumulator();
    acc.pushLine(frame({ choices: [{ delta: { content: "我先查一下。" } }] }));
    acc.pushLine(frame({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }] } }],
    }));
    const r = acc.result();
    expect(r.content).toBe("我先查一下。");
    expect(r.toolCalls[0]!.function.name).toBe("f");
  });
});
