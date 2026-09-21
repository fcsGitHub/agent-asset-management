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

// 动态 action 过滤白名单（M26）：与 /activity 下发的 ACTIVITY_FILTERS 同一口径。
// 枚举校验拒绝越表值——LLM 给出白名单外的值视为未通过校验（走诚实回退）。
const ACTIVITY_ACTIONS = ["agent", "asset.archive", "asset.restore", "review_prepared", "release_published", "release_rollback", "audit.export"] as const;

export const NlIntent = z
  .object({
    intent: z.enum(["navigate", "search_assets", "fill_register_form", "create_issue"]),
    params: z.object({
      page: z.enum(PAGES).optional(),
      query: z.string().max(120).optional(),
      typeKeyHint: z.string().max(64).optional(),
      name: z.string().max(120).optional(),
      // 图谱聚焦目标（M21）：page=graph 时可选，界面解析为资产后进入聚焦模式
      assetName: z.string().max(120).optional(),
      // 动态过滤目标（M26）：page=activity 时可选，直达对应 action 过滤视图
      activityAction: z.enum(ACTIVITY_ACTIONS).optional(),
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
  // 图谱聚焦（M21）：「聚焦 X 的图谱」「打开 X 的关系图谱」「图谱聚焦 X」；
  // 纯「打开图谱」已在上面命中（无 assetName），不冲突
  const focus =
    t.match(/^(?:聚焦|打开|查看)\s*[“「]?([^”」]{1,60}?)」?”?\s*(?:资产)?的(?:关系)?(?:图谱|关系图)$/) ??
    t.match(/^(?:关系)?图谱\s*聚焦[:：]?\s*[“「]?([^”」]{1,60}?)」?”?$/);
  if (focus && focus[1]!.trim()) {
    return { intent: "navigate", params: { page: "graph", assetName: focus[1]!.trim().slice(0, 120) } };
  }
  // 动态过滤（M26）：「看归档记录」「查看导出审计记录」「Agent 运行记录」等 →
  // activity + action 过滤（白名单枚举，越表词不命中、落入后续解析）
  const ACTION_WORDS: Record<string, (typeof ACTIVITY_ACTIONS)[number]> = {
    "归档": "asset.archive", "恢复": "asset.restore", "发布": "release_published",
    "回滚": "release_rollback", "导出审计": "audit.export", "导出": "audit.export", "审计": "audit.export",
    "Agent 运行": "agent", "Agent": "agent", "AGENT": "agent", "agent": "agent", "智能体": "agent",
  };
  const act = t.match(
    /^(?:看|查看|打开|显示|跳到|跳转|去|go to)?\s*(导出审计|归档|恢复|发布|回滚|审计|Agent 运行|Agent|AGENT|agent|智能体)?\s*(?:的)?(?:记录|动态|日志|历史)$/
  );
  if (act && act[1] && ACTION_WORDS[act[1]]) {
    return { intent: "navigate", params: { page: "activity", activityAction: ACTION_WORDS[act[1]] } };
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
        `1) {"intent":"navigate","params":{"page":"dashboard|workbench|activity|approvals|graph|ontology|proposals","assetName":"<仅 page=graph 且用户想聚焦某资产时填写资产名>","activityAction":"<仅 page=activity 且用户想看特定类别动态时填写，七选一：agent|asset.archive|asset.restore|review_prepared|release_published|release_rollback|audit.export>"}} —— 跳转页面（proposals 是 Agent 提案审核页；graph+assetName 进入聚焦模式；activity+activityAction 直达对应动作过滤视图）\n` +
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
