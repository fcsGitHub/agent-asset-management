# M73 研究笔记 — 可发现性与会话体验轮（页面显示 + Agent 功能）

日期：2026-10-07。用户指令：「优化迭代，加强页面显示，agent功能」。

## 调研锚点（本轮实读）

- **工具对称性（Anthropic tool-use / LangChain 工具设计指南的共同原则）**：给模型一个写工具就必须给它对应的读工具——「能写不能读」会让模型在回答「现状如何」类问题时要么编造要么拒绝。对照本仓库：Agent 有 `issue.create` 无 `issue.list`、有 `collection.add` 无 `collection.items`——正是这一原则指出的不对称。
- **ChatGPT 会话自动标题**：新对话零输入摩擦，首条消息后自动以内容命名；用户手动改名后不再自动改。对照本仓库：新建会话强制 `window.prompt` 弹窗命名——创建时用户往往还不知道要问什么，摩擦真实存在。
- **AgentPM / Linear 仪表盘范式**（延续 M8 引入的 overview 聚合端点思路）：总览页应聚合「计数 + 待办 + 水位」而非静态文案。本仓库后端 `/projects/:id/overview` 已存在（M8），但 ①前端仅部分使用 ②弃用资产被 `lifecycle <> 'archived'` 混进 active（M70 语义变更未同步此处）③完整度水位（M67 已有端点）未进总览 ④待办只算 CR 不含 Agent 提案/语义候选。

## 坐实的缺口（全部有代码/走查证据）

1. `apps/api/src/agent/tools.ts`：DRAFT_TOOLS 有 issue.create/collection.add，READONLY_TOOLS 无 issue.list/collection.items——「能写不能读」。
2. `apps/web/src/pages/Workbench.tsx` 新建会话 `window.prompt("新会话标题：")`——强制命名弹窗。
3. `apps/web/src/components/AgentPane.tsx` ToolCard 结果区一律 `JSON.stringify` 原文——graph.path 的核心信息（路径链条）埋在 JSON 里，非技术成员读不懂。
4. `apps/api/src/routes/runs.ts` 创建运行的 `allowed_tools` 留档列硬编码 6 个工具名（M50 之前的旧清单），与运行器实际 `allAgentTools()` 分叉（留档失真；运行器不读此列，无行为影响）。
5. `apps/api/src/routes/projects.ts` overview：assets.active 口径含 deprecated（M70 语义后失真）；无提案/语义候选待办计数。
6. `apps/web/src/components/ProjectPages.tsx` DashboardPage：无完整度水位卡（M67 端点空挂）；「团队资产」卡无弃用计数。
7. blocked 运行的提示只说「已暂停等待处置」——没有告知任何处置出口。

## 方案与取舍

- **新工具放 READONLY 层**：issue.list（默认未结 open+in_progress，status=all 全量，q 过滤走 likeContains——m72 LIKE 字面量口径）、collection.items（复用 resolveCollectionRef 名称/id 双解析，条目带 note/type_key/lifecycle，逐条 recordUsage 计 agent_read 热度）。
- **自动标题不加 LLM**：规则实现（首行截 24 字）足够好且零成本零延迟；迁移 0031 加 `sessions.title_is_auto` 布尔列而非用正则识别占位标题——显式状态位避免「用户恰好手动起了占位格式的名字」被误改写。改写放在创建运行的事务里且条件更新（AND title_is_auto），并发首条运行只有一条生效，用户恰在事务前显式命名的不会被覆盖。PATCH 改名即接管命名权（title_is_auto=false 永不自动改）。存量会话默认 false（历史标题全部来自用户显式输入）。
- **可读化渲染放前端、防御式**：ToolResultView 按工具名分派（asset.search/graph.assetsByType 资产行简表、graph.path 路径条、graph.neighbors 邻域、collection.search/items、issue.list 状态徽标），任何形状不符返回 null 回退 JSON——绝不因渲染崩掉对话面板；原始 JSON 收进「原始结果」折叠（渐进披露原则不丢透明度）。
- **总览加强全部复用既有端点**（overview/completeness-summary 同源口径），不造第二套统计。

## 明确不做（如实记录）

- blocked 运行「继续执行」按钮：真实续跑需要把上一运行的 messages 上下文带进新运行（跨运行状态传递），本轮不做，只补诚实指引（「可发送新消息继续任务（下一运行会重新检索现场）」）。
- proposal.list / activity 类 Agent 读工具：提案状态人可在「Agent 提案」页看、动态页可看；Agent 侧需求不迫切，列入可选后续。
- 会话标题 LLM 摘要（ChatGPT 式语义标题）：需为一条标题单独烧一次调用，规则版先落地，效果不够再升级。
