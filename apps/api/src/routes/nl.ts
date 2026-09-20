// /api/v1/nl — 自然语言命令解析（设计 4 章 Agent 辅助的界面层延伸）。
// 解析器链：L1 规则（确定性、零成本）→ L2 真实 DeepSeek（严格 JSON + 白名单校验）。
// 两级都失败时回退"按原文搜索资产"并如实标注 parser.kind/note —— 不伪造解析成功。
// 意图映射到既有界面动作。写类意图（create_issue）解析端点本身绝不落库：
// 界面卡片预览标题/正文，用户点击"执行"确认后才调用既有 POST /issues —— 双重确认，
// 服务端不新增任何写权限面，解析接口保持零副作用。
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { q } from "../db.js";
import { ERR } from "../errors.js";
import { checkCsrf, requireAuth } from "../auth.js";
import { parseBody } from "./auth.js";
import { DeepSeekProvider, LlmError } from "@taw/agent-adapter/deepseek";

const PAGES = ["dashboard", "workbench", "activity", "approvals", "graph", "ontology", "proposals"] as const;

export const NlIntent = z
  .object({
    intent: z.enum(["navigate", "search_assets", "fill_register_form", "create_issue"]),
    params: z.object({
      page: z.enum(PAGES).optional(),
      query: z.string().max(120).optional(),
      typeKeyHint: z.string().max(64).optional(),
      name: z.string().max(120).optional(),
      title: z.string().max(200).optional(),
      body: z.string().max(4000).optional(),
    }).default({}),
  })
  // 写类意图必须有明确标题：模型只给意图不给标题时视为未通过白名单校验（走诚实回退）
  .superRefine((v, ctx) => {
    if (v.intent === "create_issue" && !(v.params.title ?? "").trim()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["params", "title"], message: "create_issue 需要 title" });
    }
  });
export type NlIntent = z.infer<typeof NlIntent>;

export interface NlParseResult {
  intent: z.infer<typeof NlIntent>;
  parser: { kind: "rules" | "llm"; model?: string; tokens?: number; note?: string };
}

/** L1 规则解析：覆盖高确定性的短命令；命中即返回（零模型成本、完全确定）。 */
export function ruleParse(text: string): NlIntent | null {
  const t = text.trim();
  const page = t.match(/(?:^打开|^跳到|^跳转|^去|^go to)\s*(总览|仪表盘|工作台|动态|审批|审批队列|提案|提案页|图谱|关系图谱|关系图|本体|本体治理)/);
  if (page) {
    const p = page[1]!;
    const map: Record<string, (typeof PAGES)[number]> = {
      "总览": "dashboard", "仪表盘": "dashboard", "工作台": "workbench",
      "动态": "activity", "审批": "approvals", "审批队列": "approvals",
      "提案": "proposals", "提案页": "proposals",
      "图谱": "graph", "关系图谱": "graph", "关系图": "graph",
      "本体": "ontology", "本体治理": "ontology",
    };
    return { intent: "navigate", params: { page: map[p] ?? "dashboard" } };
  }
  const search = t.match(/^(?:搜索|查找|找一下?|查一下?)(?:资产|相关资产)?[：:\s]*(.+)$/);
  if (search && search[1]!.trim()) {
    return { intent: "search_assets", params: { query: search[1]!.trim().slice(0, 120) } };
  }
  const register = t.match(/^登记(?:一个|新建?)?\s*(.{0,60}?)\s*资产$/);
  if (register) {
    return { intent: "fill_register_form", params: { name: register[1]!.trim() || undefined } };
  }
  // 写类意图（确定性句式）：仅解析出草稿标题，真正创建仍需用户在界面卡片上确认
  const issue = t.match(/^(?:报告|提交|新建|建|提)(?:一个|个)?\s*(?:问题|工单|[Ii]ssue)\s*[：:]\s*(.+)$/);
  if (issue && issue[1]!.trim()) {
    return { intent: "create_issue", params: { title: issue[1]!.trim().slice(0, 200) } };
  }
  return null;
}

/** 从模型回复中提取 JSON 对象（容忍代码围栏与前后缀文本）。 */
export function extractJson(raw: string): unknown | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

const TYPE_KEYS_HINT = "document, software, simulation.model, simulation.engine, simulation.scenario, test.suite, agent.template 或团队自定义 type_key";

function buildLlmMessages(text: string, page: string) {
  return [
    {
      role: "system" as const,
      content:
        "你是团队资产工作台的界面命令解析器。把用户的中文指令解析为一个 JSON 对象，只输出 JSON，不要输出任何解释。" +
        `可选意图（白名单，四选一）：\n` +
        `1) {"intent":"navigate","params":{"page":"dashboard|workbench|activity|approvals|graph|ontology|proposals"}} —— 跳转页面（proposals 是 Agent 提案审核页）\n` +
        `2) {"intent":"search_assets","params":{"query":"<搜索关键词>"}} —— 搜索资产\n` +
        `3) {"intent":"fill_register_form","params":{"typeKeyHint":"<类型键，可选：${TYPE_KEYS_HINT}>","name":"<资产名，可选>"}} —— 预填登记表单\n` +
        `4) {"intent":"create_issue","params":{"title":"<问题标题，必填>","body":"<问题详情，可选>"}} —— 起草问题工单（界面会先预览，用户确认后才创建）\n` +
        "规则：指令含糊时优先 search_assets；用户只是描述问题而非明确要求建工单时，用 search_assets；" +
        "不要发明白名单之外的意图；不要编造属性值。",
    },
    { role: "user" as const, content: `当前页面：${page}\n用户指令：${text}` },
  ];
}

export async function nlRoutes(app: FastifyInstance): Promise<void> {
  app.post("/nl/parse", async (req) => {
    checkCsrf(req);
    const auth = requireAuth(req);
    const body = parseBody(
      z.object({
        teamId: z.string().uuid(),
        text: z.string().min(1).max(200),
        page: z.enum(PAGES).default("dashboard"),
      }),
      req.body
    );
    const { rows } = await q(`SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2`, [
      body.teamId,
      auth.userId,
    ]);
    if (!rows[0]) throw ERR.NOT_FOUND();

    // L1：规则命中直接返回
    const ruled = ruleParse(body.text);
    if (ruled) {
      return { ...ruled, parser: { kind: "rules" as const } };
    }

    // L2：真实 DeepSeek 解析（严格 JSON + 白名单 zod 校验）。返回与规则路径同构的扁平结构。
    let provider: DeepSeekProvider;
    try {
      provider = new DeepSeekProvider();
    } catch {
      // key 未配置：如实回退到按原文搜索（不伪造 LLM 解析）
      return {
        intent: "search_assets",
        params: { query: body.text },
        parser: { kind: "rules" as const, note: "DEEPSEEK_API_KEY 未配置，已按原文转为资产搜索" },
      };
    }
    try {
      const chat = await provider.chat(buildLlmMessages(body.text, body.page) as never, [], AbortSignal.timeout(20000));
      const raw = extractJson(chat.message.content ?? "");
      const parsed = NlIntent.safeParse(raw);
      if (!parsed.success) {
        return {
          intent: "search_assets",
          params: { query: body.text },
          parser: {
            kind: "rules" as const,
            model: provider.modelName,
            tokens: chat.totalTokens,
            note: "LLM 输出未通过白名单校验，已按原文转为资产搜索（注入或越权意图被丢弃）",
          },
        };
      }
      return { ...parsed.data, parser: { kind: "llm" as const, model: provider.modelName, tokens: chat.totalTokens } };
    } catch (err) {
      if (!(err instanceof LlmError)) throw err;
      return {
        intent: "search_assets",
        params: { query: body.text },
        parser: { kind: "rules" as const, note: `LLM 不可用（${err.code}），已按原文转为资产搜索` },
      };
    }
  });
}
