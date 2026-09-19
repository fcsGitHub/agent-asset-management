/**
 * DeepSeek API 冒烟测试：真实调用官方 API（OpenAI 兼容协议）。
 * 用途：验证网络连通、鉴权、模型可用。key 从 .env / 环境变量读取，绝不打印。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): void {
  try {
    const content = readFileSync(join(root, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 依赖真实环境变量 */
  }
}

async function main(): Promise<void> {
  loadEnv();
  const key = process.env.DEEPSEEK_API_KEY ?? "";
  const base = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";
  if (!key || key === "replace-me") {
    console.error("smoke-llm: DEEPSEEK_API_KEY 未配置");
    process.exit(2);
  }
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "你是资产管理助手的冒烟测试端点。只回复一个 JSON 对象。" },
        { role: "user", content: '请严格输出 {"ok": true}' },
      ],
      max_tokens: 20,
      temperature: 0,
    }),
  });
  const latency = Date.now() - started;
  if (!res.ok) {
    console.error(`smoke-llm: HTTP ${res.status} (${latency}ms)`);
    const text = await res.text();
    // 脱敏：仅输出状态与错误类型，不回显请求头
    console.error(text.slice(0, 300));
    process.exit(1);
  }
  const data = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string } }[];
    usage?: { total_tokens?: number };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  console.log(
    JSON.stringify({
      ok: true,
      http: 200,
      latencyMs: latency,
      model: data.model,
      contentSample: content.slice(0, 120),
      totalTokens: data.usage?.total_tokens,
    })
  );
}

main().catch((err: unknown) => {
  console.error("smoke-llm failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
