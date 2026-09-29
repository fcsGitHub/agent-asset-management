# Research M61 — 自然语言生成 Schema 草稿（2026-09-29）

M60 候选清单首位（HANDOFF）：「对 Agent/⌘K 说『我要一个 XX 类型』→ LLM 意图产出
草稿 schema 进表单模式，人工确认后登记——LLM 只产草稿不落库」。

## 设计锚点（承 M60 调研 + 本仓库既有惯例）

1. **LLM 产草稿、人定稿**：与 NL 命令栏（L2 白名单）、Agent 提案同一权限哲学——
   模型输出永远进「草稿/候选」层，落库动作由人执行并过全部质量门。schema 设定是
   本体治理动作（管理员），LLM 不越权：describe-schema 只返回属性行草稿。
2. **结构化输出 + 白名单**（nl.ts 既有模式复用）：DeepSeek 严格 JSON → zod
   strictObject 校验（未知字段拒绝、类型枚举、1..24 行、长度上限）→ fieldsToSchema
   键约束复核 → compileTypeSchema 防御复核。四层防线，注入/越权形状一律丢弃并如实
   报「未通过结构校验」。
3. **诚实降级**：DEEPSEEK_API_KEY 未配置 → 503 DEPENDENCY_UNAVAILABLE（提示改用
   表单构建/样例推断），不伪造草稿——与 Agent「无 key 不提供 mock 答复」一致。

## 落地（M61）

- POST /types/describe-schema {teamId, description ≤500}：成员可用、零写入。
  返回 {typeKey?, title?, fields, jsonSchema, problems, model, tokens}——草稿即
  SchemaFieldDraft 属性行，直接填进 M60 表单模式（三通道汇于同一表单）。
- UI：表单构建模式顶部「用一句话描述类型」+「AI 生成草稿」；回填属性行与
  typeKey/title 建议（只填空位不覆盖用户已填），meta 行显示模型与 tokens，
  「请人工确认微调后再登记」常驻提示。
- vitest alias 补 @taw/api/routes/catalog（tests 白名单单测 import 用）。
- 验证：tests/m61 四项（白名单五类拒绝、真实 DeepSeek 草稿结构+可编译+零写入、
  replace-me 哨兵 503、越权 404/短描述 422）；浏览器全链路（描述→331 tokens 草稿
  枚举/必填/0-500/数组全对→typeKey 撞名人工改 m61.ai.report→登记入类型树）。

## 与 M58–M60 的关系

schema 生命周期四段现已齐：便捷设定（M60 表单/推断 + M61 自然语言）→ 入库/更新
强制（M59）→ 测试门禁（M58）→ 发布复核（M59 prepare + M58 gate）。LLM 参与的
两段（草稿、Agent 提案）都停在草稿层，落库与发布始终由人执行。
