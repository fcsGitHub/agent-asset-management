# HANDOFF — 交接

更新时间：2026-09-29（M55 使用度与别名轮后）

## 仓库状态

- 路径：D:\project\agent-asset-management（Windows，Git Bash）
- 分支：main（本仓库为本次目标新建；无用户历史修改，初始文档已保留）
- 工作区：最终提交后干净（keys.txt/.env/data/backups 均在 .gitignore）

## 已完成（详见 PLAN/ACCEPTANCE/EVIDENCE）

- M0–M5 全部里程碑；42 项验收：40 通过 / 1 明确不适用（E06 离线+ARM64 未验证，
  属环境外部限制，如实标记不做声称）
- 测试：37 套件 167 项全部通过（真实 PostgreSQL、真实 HTTP、真实 DeepSeek、真实 semantica；无任何 mock；
  全部断言经审计为真实生效，无空断言。注：M28～M30 提交信息中的"套件"数多记 1，M31 起以 vitest 文件数为准）
- M6/M7/M8 迭代轮：崩溃注入与冷启动、outbox 真实派发 worker、Agent 区真实运行（SSE 工具事件）、
  头修订索引与修订分页、本体治理（类型层次/关系 domain-range/成环禁止/质量门/迁移预演/本体导出）、
  项目总览 + 团队动态 + 审批队列 + ⌘K 命令栏（导航壳/快捷键单一真源/统一空状态）（EV-019～028）
- 演练：M1 重启持久化（docker restart）、E03 备份恢复到新容器、E05 性能（≥1 万资产规模）、
  M6 并发竞态/并发负载/kill -9 中段事务崩溃注入/冷启动引导（EV-019～023）
- 文档：README（真实执行过的命令）、docs/ops/{ADMIN,BACKUP,CONFIG}.md
- 安全基线：RLS + 受限应用角色、作者分离、审核快照失效、幂等发布、工具分级、
  密钥不出服务端、CSRF、路径穿越/越权负例

## 未完成 / 遗留

无未完成补强项（M6 补强轮已完成原 6 项遗留：归档端点、本体迁移预览、preview 通道 UI、
kill -9 崩溃注入、冷启动引导、并发压测）。唯一非通过验收项 E06 属环境外部限制
（无 ARM64/离线验证环境）。

## 风险

- 性能/并发结论为本机 Docker 口径（16 并发读 P95=42ms、混合负载 0 错误），生产硬件容量需另测。
- 本机语义 worker（8100）经会话后台任务（Bash run_in_background）与 PowerShell
  Start-Process 隐藏窗口两种方式启动，均会在宿主回合/空闲边界被回收（exit 1、
  无 traceback、无 Windows 崩溃事件；同方式启动的 node API/web 不受影响，worker
  自身服务全程正常）——宿主对会话派生进程树的回收，非代码缺陷。
  最终托管方式（2026-09-22）：Windows 计划任务「TAW semantic worker」（过去日期的
  once 触发器永不自动运行、无需管理员；手动 `schtasks /run` 拉起，由任务计划程序
  服务创建进程、完全脱离会话进程树）。日志：`data\worker-task.log`。
  删除托管：`MSYS_NO_PATHCONV=1 schtasks /delete /tn "TAW semantic worker" /f`。
- E06：离线/ARM64 无验证环境，交付物不做此声称。
- Pi（@earendil-works/pi-*）以统一 LLM 层路径适配（ADR-0003），已核实包存在（0.85.1）
  但未打包集成；当前 Agent 经 OpenAI 兼容协议直连 DeepSeek，接口契约一致。

## 恢复入口（新会话从这里开始）

1. 读 docs/implementation/ACCEPTANCE.md（42 项状态）与本文件
2. `docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
3. `npx tsx apps/api/src/server.ts` + `cd apps/web && npx vite --port 5174 --strictPort`
   + 语义 worker 用计划任务托管（勿用会话内后台启动，见风险区）：
   `MSYS_NO_PATHCONV=1 schtasks /run /tn "TAW semantic worker"`
   （任务不存在时创建：`MSYS_NO_PATHCONV=1 schtasks /create /tn "TAW semantic worker" /tr "cmd /d /c cd /d D:\project\agent-asset-management && .venv-sema\Scripts\python.exe services\semantic-worker\main.py >> data\worker-task.log 2>&1" /sc once /sd 2020/01/01 /st 00:00 /rl limited /f`）
   （API 的 DeepSeek 自载 .env；worker 自 M31 起同样自载 .env，无需手动 export）
   （可选）outbox 派发：设 OUTBOX_DISPATCH_URL 后 `npm run dev:worker`
4. `npx vitest run` 确认 167 项基线仍绿
5. M9 已完成：NL 命令解析（真实 DeepSeek，⌘K 自然语言模式）、语义候选抽取 LLM 增强、
   测试诚实化清零 80 处空断言并修复 4 个被掩盖的产品缺陷（EV-029~031）。
   M10 已完成：NL 写类意图 create_issue（解析零副作用 + 界面预览-确认双重门）、
   关系图谱页（本地力导向布局，g+m）、本体导出 Turtle 序列化（确定性）、
   总览「最近问题」卡片（EV-032）。
   M11 已完成：活动流实时推送（0018 触发器 pg_notify → activityHub 单例 LISTEN
   → SSE /activity/stream，事件与列表同源、Agent 状态原地更新、团队隔离）、
   图谱页本体导出下载按钮（EV-033）。
   M12 已完成：运行事件流迁移 NOTIFY（0019 + activityHub 双通道，去 400ms 轮询，
   线格式/续传不变）、runner 终态先事件后状态不变量、取消健壮性修复
   （cancel_requested 每轮兜底 + 两轮间取消误标修正）、图谱聚焦模式（EV-034）。
   M13 已完成：本体治理台（rail 本体，g+o：类层次树、关系类型表+断言计数、
   管理员登记类型/关系类型、双迁移预演、导出）、.primary 白底白字 UI 缺陷修复、
   图谱聚焦多跳展开（EV-035）。
   M14 已完成：语义候选工作台（工作区「语义候选」标签：真实抽取 → 端点自动映射 →
   人工确认断言 → 图谱/关系目录联动；后端零改动）（EV-036）。
   M15 已完成：候选审核队列（0020 持久化 + RLS + 状态机；关系断言核心重构为共享
   函数 createRelationAssertion；入队/队列/确认/忽略四端点，确认原子且违规保持
   pending；工作台跨成员待审核队列界面）（EV-037）。
   M16 已完成：活动流按项目过滤（0021 审计补 project_id，发布类动作真实盖章、
   团队级动作 NULL 的明确语义；/activity 与 SSE 支持 projectId 过滤；动态页项目
   过滤选择器）（EV-038）。
   M17 已完成：Agent 提案审核闭环（GET /projects/:id/proposals + POST /proposals/:id/review
   状态机与 jsonb 审核回执；工作区「Agent 提案」标签：结构化展示/筛选/接受与忽略/
   登记类提案预填登记表单）（EV-039）。
   M18 已完成：候选队列批审与详情（confirmCandidate 共享核心；batch-confirm/batch-dismiss
   逐条 SAVEPOINT 隔离、逐条如实回执；候选详情端点含决策留痕与断言去向；队列批选
   与详情展开 UI；本体页「受控单位词表」卡片——UNIT_VOCAB 模块级唯一定义点 + worker
   GET /units + API 代理 503 如实降级）（EV-040）。
   M19 已完成：实时层自愈——activityHub 健康探测（15s SELECT 1）+ 指数退避重连
   （500ms~8s）+ 重连后 resync（运行流 DB 游标精确回填恰好一次、活动流 SSE resync
   帧客户端重取对齐）；LISTEN 连接 application_name=taw_activity_hub 可观测；
   修复 connecting 缓存拒绝导致的枢纽永久死亡。队列状态筛选视图 + NL「打开提案页」
   （EV-041）。
   M20 已完成：活动流历史键集分页（精确时间戳游标 to_jsonb 往返、同 instant 跨源
   边界语义显式化；修复相等比较器双向 -1 的真实缺陷）+ 提案批量审核（reviewProposal
   共享核心、逐条回执）；动态页「加载更早」、提案批审条（EV-042）。
   M21 已完成：候选导入去重（同类型+端点 pending/confirmed 拒入、dismissed 放行、
   skipped/duplicateIndexes 如实回执）+ NL 图谱聚焦（L1 三句式 + L2 assetName 白名
   单；Workbench 解析资产注入 RelationGraph initialFocusId）（EV-043）。
   M22 已完成：审计导出 CSV（queryActivityPage 共享核心、DESC 遍历正序写出、
   RFC 4180 + BOM + 微秒 ts + entry_id、audit.export 盖章、20000 上限如实截断）+
   登记类型单位词表在线校验（实时 ⚠/✓、worker 降级如实提示）（EV-044）。
   M23 已完成：入队前去重预演（planImport 与真实入队同源判定——队列已有 pending/
   confirmed 跳过、批内重复跳过、dismissed 放行三口径一致，只判不写；预演端点 +
   工作台「预览入队 → 确认入队」两步流）+ 提案批量审核备注入口（复用 M20 batch-review
   per-item note，写入审核留痕并渲染）（EV-045）。
   M24 已完成：动态 action 过滤（queryActivityPage 同源扩展 agent 组/精确动作、过滤
   先于游标；选项随 /activity 同源下发；SSE 实时事件客户端同口径守护）+ 审计导出
   JSON（结构化条目 + truncated 如实标注；盖章 detail 增 format/action；CSV 契约不变）
   （EV-046）。
   M25 已完成（清积压）：图谱聚焦跳数记忆（localStorage 持久化、容错回退 1 跳）+
   队列候选批量重映射端点（空侧不改、仅改映射不自动确认）。纯前端轮零回退（EV-047）。
   M26 已完成（暂缓清零）：时间范围 since/until（列表/导出同源闭区间、窗口内键集
   翻页、盖章记录范围）+ NL 动态过滤意图（L1 五句式 + L2 七值白名单、activityPreset
   直达过滤视图）+ 提案 diff 视图（同名/类型/属性对比）。修复过滤竞态与时区错位
   两个真实前端缺陷（EV-048）。
   M27 已完成：审计条目详情（GET /activity/audit/:id 团队 scoped、动态页点击展开
   回执原文）+ 语义队列导出（CSV/JSON × 状态过滤、semantic.queue.export 盖章、
   动作标签与过滤选项自动出现）（EV-049）。
   M28 已完成：队列导出件回导入队（planImportDedup 三端点同源判定、per-item
   assetName 解析跨团队复用、unresolved 如实标记、二次回导完全幂等）（EV-050）。
   M29 已完成：回导件兼容 CSV（宽容 RFC 4180 解析、与 JSON 同管线、转义往返）+
   图谱 SVG 快照导出（样式内联、marker 修正）（EV-051）。
   M30 已完成：按操作者筛选（actorId 与项目×动作×时间三维正交、actors 名单同源
   下发、导出/盖章/实时守护同口径）+ 图谱 PNG 位图导出（2x 栅格化）。至此审计
   过滤四维矩阵（项目/动作/时间/操作者）全部与 queryActivityPage 同源（EV-052）。
   M31 已完成（实测走查轮，响应"从实际使用反馈收集需求"）：以真实用户身份走查
   全部主流程，修 4 缺陷 + 1 记账纠偏——关系断言防重（createRelationAssertion
   守卫 409 DUPLICATE_ASSERTION + 0022 部分唯一索引 + 存量重复撤回清理；修订限定
   断言不受约束）、关系撤回端点 POST /relations/:id/withdraw（管理员/提议人、
   relation.withdraw 审计盖章、动作标签同源）、语义 worker 最小 .env 加载器
   （文档朴素命令启动不再丢 LLM 增强）、过时 M4 文案修正、"套件"计数纠偏。
   m31 两项 + m14 适配，全量 37 套件 167 项全绿（EV-053）。
   M32 已完成（实测走查轮·下）：生命周期全环走查（新团队：登记→分支→草稿→CR→
   快照→发布→通道→回滚）修复——项目成员缺口（POST /projects/:id/members + 概况页
   入口 + project.member.add 盖章/标签同源；此前普通成员无任何途径进入项目）、
   发布按钮静默 no-op（与渲染同口径回落服务端有效快照）、回滚 UI（GET
   /projects/:id/release-sets 历史 + 管理员「回滚…」按钮）、草稿回执/通道条目
   摘要口径、新建项目自动选中；实测确认作者分离与"普通成员不能发布"控制如实生效。
   m32 两项 + m9 无 key 场景适配（replace-me 哨兵），全量 38 套件 169 项全绿
   （EV-054）。已知限制：存量成员角色提升无产品路径（DB 直改，m2 建邀请时可直接
   指定 admin；后续按需求再做）。
   M33 已完成（UI 全面翻新轮，对标 kimi-code desktop）：设计令牌体系
   （apps/web/src/styles/tokens.css，浅色 + 深色双主题，html[data-theme] 手动
   覆盖 + prefers-color-scheme 跟随系统，顶栏主题开关三态循环并持久化
   localStorage，index.html 首帧前恢复脚本防闪烁）；Agent 对话区重写为
   kimi 风格（components/AgentPane.tsx：用户右对齐气泡、Agent 头像 + 状态药丸
   + 时间戳、工具卡渐进展开（旋转图标/参数与结果分区/按工具类型生成摘要）、
   Markdown 正文渲染、流式光标、贴底自动滚动 + 「回到底部」浮钮、Composer
   自适应高度 + Enter 发送 / Shift+Enter 换行 + 中文输入法 isComposing 保护 +
   运行中主按钮变停止）；自研零依赖安全 Markdown 渲染器 lib/markdown.tsx
   （React 元素构造无 dangerouslySetInnerHTML，链接仅放行 http/https，支持
   表格/代码围栏/列表/引用/标题，7 项单元测试）；SVG 线性图标集替换 emoji/
   字符图标；消息与运行按时间线交织重建。修复两个真实缺陷：历史运行最终文本
   丢失（result 为 string 形态而界面只认 {finalText}，刷新后 Agent 回复消失）、
   运行历史 DESC 序与消息 seq 升序错配导致时间线倒序；新增运行元信息行
   （N 次工具调用 · M tokens）。
   M34 已完成（@ 上下文引用 + 工具网关健壮性）：Composer 输入 @ 触发资产检索
   面板（250ms 防抖真实 /assets/search、键盘上下/Enter/Tab/Esc、去重已选）、
   已选引用 chips、随运行写入 context_refs 落库；用户气泡下方渲染引用 chips
   （格式自解析 id，点击跳工作区资产详情）；GET /sessions/:id/runs 补返回
   context_refs（历史时间线可重建引用）。实测走查揪出真实缺陷并修复——
   工具网关事务毒化：工具内 SQL 失败（如模型传非法 UUID）中止整个 withTeam
   事务，invokeTool 的 error 记录连带失败、整轮运行以 "current transaction
   is aborted" 崩溃且不留调用记录；invokeTool 改为 SAVEPOINT 隔离执行
   （沿用 semantic.ts 既有模式）。asset.getRevision 契约补强：revisionId
   缺省读取最新修订（head），模型不再被迫猜测修订 id。tests/m33 三项
   （SAVEPOINT 隔离 + 默认头修订 + context_refs 回读），全量 40 套件
   179 项全绿；浏览器实测 @ 引用全流程（面板→chip→带上下文运行→工具成功）。
   M35 已完成（全页面视觉走查轮）：以真实用户身份在浏览器走查全部页面 ×
   亮/暗双主题——总览、工作台（对话/资产目录/详情/草稿面板）、图谱（节点
   着色/边标签/图例/导出按钮）、本体（类层次树/属性表）、动态（SSE「● 实时」
   连接确认）、审批（空态）、⌘K 命令栏（深色浮层 + 每页 SVG 图标）。修复
   资产目录搜索行被 select width:100% 挤压的缺陷（新增 .field-row 工具类）。
   未发现其他视觉缺陷；全量 40 套件 179 项保持全绿。
   M36 已完成（会话管理 + Agent 区补强）：PATCH /sessions/:id 端点（改名/归档，
   创建者或团队管理员，FOR UPDATE 防竞态，空补丁 422）；抽屉会话行悬停操作
   （重命名 ✎ / 归档 🗄），已归档会话移入「已归档（N）」折叠区可恢复（归档
   不删数据）；归档当前会话自动切到第一个未归档会话。Agent 回复悬停复制按钮
   （Markdown 原文进剪贴板，1.6s 反馈）；SSE 断线重连如实提示条（CONNECTING
   期间显示「连接中断，正在自动重连」，done/终态即消失，不伪装在线）。
   tests/m34 五项（权限 403/空补丁 422/改名归档往返/管理员恢复他人会话/404），
   全量 41 套件 184 项全绿；浏览器实测归档→折叠区→恢复全链路（DB 复核）。
   M37 已完成（运行状态药丸 + 提案流走查）：顶栏静态「已连接」替换为真实
   运行状态药丸（AgentPane 经 onRunStateChange 上报 streaming 态；空闲绿点 /
   运行中琥珀脉冲点）；浏览器实测「提交整理提案」全链路——asset.search →
   asset.getRevision（缺省 head）→ proposal.create 三工具卡 ✓、提案落库
   pending、Agent 提案标签页深色渲染（批审条/对比/预填/接受/忽略）、
   UI 点「接受」后 DB 状态 accepted；登录页深色主题验证。全量 41 套件
   184 项保持全绿。
   M38 已完成（思考过程可视化 + 发布通道走查）：多轮运行的中间 assistant
   文本不再被覆盖丢弃——逐轮收入可折叠「思考过程（N 轮）」块（终态正文与
   末轮相同则不重复计入；历史运行无逐轮数据时如实不显示）。发布与通道
   标签页带真实数据深色走查：分支 add-docs → 草稿修订 r2 → CR「补充分析
   报告结论」→ 准备审核快照（stable · 有效）→ 待审核态与发布/退回按钮
   渲染正确（作者分离：未发布，留待管理员操作）。全量 41 套件 184 项全绿。
   M39 已完成（布局自主调节 + 语义候选带数据走查）：对话区/工作区间新增
   可拖拽分隔条（Workbench panePct 状态持久化 localStorage「taw-pane-pct」，
   clamp 25–65%，支持拖拽 / ←→ 键微调 / 双击复位，窄屏自动隐藏）；用户气泡
   补 created_at 悬停时间戳（端点本已返回该列）；composer-note 文案缩短。
   语义候选标签页首次带真实数据走查：schtasks 拉起的 worker 进程僵死
   （8100 监听但不响应），kill 后直拉 .venv-sema 恢复；真实抽取两轮——
   规则基线 + LLM 增强（真实 DeepSeek，extractor 版本 +llm/deepseek）——
   入队 5 条（批内同键去重如实跳过 1 条）；UI 确认 derivedFrom（端点自动
   预映射、断言 e639dd97 落关系目录 confirmed）、忽略自环候选；「已确认/
   已忽略」历史视图只读 + 详情决策留痕（断言去向/修订/入队人/决策人）
   渲染正确；导出 CSV/JSON、回导 JSON 入口在位。全量 41 套件 184 项全绿。
   M40 已完成（运行预算实时可视化 + 一个真实缺陷修复）：修复预算默认值
   从未生效——创建端 zod 链 `.partial()` 把字段包成 optional 吞掉内层
   default，未显式传 budget 的运行落库 `{}`，runner 的预算闸门
   （usedToolCalls >= undefined）形同虚设（存量运行均为 {} 为证）；改为
   对象级完整默认值 + 字段级 default（ZodDefault 不解析默认值本身），
   runner 读取处对存量 `{}` 行同口径兜底。runner 在每次模型应答与每次
   工具结果后发 usage 事件（toolCalls/tokens + 预算上限），SSE 原样送达；
   界面 AgentPane 新增 UsageMeter——流式期间实时刷新「N/8 次工具调用 ·
   3.7k/20k tokens」+ token 预算细条（≥80% 琥珀、100% 红），终态定格；
   历史端点 GET /sessions/:id/runs 补返回 budget 列，刷新后元信息行同样
   带预算形态（存量无预算运行如实退回绝对值）。tests/m40 三项（默认值
   落库/部分提供补齐/usage 事件单调性与终态一致性 + 历史端点 budget）；
   浏览器实测运行中与刷新后两种形态的用量条渲染。全量 42 套件 187 项全绿。
   M41 已完成（工具卡资产引用直达）：新增纯函数 lib/toolRefs.ts——从工具
   参数（assetId）与结果（asset.search 命中数组的 {id,name} 形态；修订
   对象的 id 是修订 id，不误提）解析可跳转资产引用，去重上限 6；工具卡
   展开区新增「相关资产」chips（有 onOpenAsset 时可点击，直达工作区资产
   详情，与 @ 引用 chips 同视觉语言）。lib 单测 4 项（参数提取/结果数组
   去重/修订不误提/非法输入为空）；浏览器实测 asset.search 工具卡展开 →
   chips 渲染 → 点击跳转资产详情全链路。全量 43 套件 191 项全绿
   （期间 m5-c7c8 出现一次并行负载下的偶发失败， isolated 复跑通过；
   已把该断言加固为失败时带 status+body 诊断，逻辑不变）。
   M42 已完成（待办徽标）：审批导航项琥珀角标（待审核+已退回 CR 计数）、
   工作台「语义候选」「Agent 提案」标签待处理计数徽标；数据来自与各页面
   完全相同的列表端点（口径一致），项目切换加载 + 30s 轮询 + 变更事件
   即时刷新（lib/badges.ts 的 taw:badges-refresh 自定义事件，候选队列/
   提案列表/CR 列表载入即派发——列表即徽标数据源，永不相悖）。
   浏览器实测：确认一条语义候选后队列 3→2 与标签徽标 3→2 同步即时生效；
   审批角标=1（与总览待处理审核卡同口径）；零待办标签如实无徽标。
   全量 43 套件 191 项全绿。
   M43 已完成（CR 冻结差异视图）：GET /change-requests/:id 的变更项携带
   diff——绑定 CR 固化的 base/candidate 修订（而非分支活头，与审批摘要的
   冻结语义一致），复用 @taw/domain/diff 的 diffRevisions（属性逐字段 /
   制品文本行补丁 / 二进制摘要对照 / 关系增减）；此前该能力只在
   /branches/:id/diff 存在而界面从未消费，审批者只能看到 r1→r2 序号。
   发布与通道 CR 详情的资产表改为可展开差异卡片（汇总「属性 N · 制品 N ·
   关系 N」，展开见 +绿 / −红 / ~琥珀 差异行与文本补丁，无变化如实显示）。
   tests/m43 一项（属性 changed 精确值 + textPatch del/add 行 + 未变字段
   不出现）；浏览器实测存量 CR「补充分析报告结论」：卡片汇总「属性 1」→
   展开「+ summary = 补充转移轨道分析结论」，亮/暗双主题渲染正确。
   全量 44 套件 192 项全绿。
   M44 已完成（正文资产名链接化）：Markdown 渲染器新增可选 renderText
   钩子——纯文本叶节点统一经此变换（行内代码/围栏/链接文本不受影响）；
   lib/linkifyAssets.ts 纯函数把文本中的团队资产名切成可点击段（完整名
   精确匹配、同起点最长优先、同名取先出现者、短于 4 字符不参与、无重叠）；
   AgentPane 随项目加载资产名表，Agent 回复正文与思考过程中命中的资产名
   渲染为行内链接按钮，点击直达工作区资产详情。lib 单测 6 项（含最长
   优先/多次出现/短名排除/重名取先）；浏览器实测存量回答中「转移轨道
   分析报告」「轨道传播模型 A」全部链接化，点击打开对应资产详情。
   同轮揪出并修复一个真实潜伏缺陷（C08 偶发失败的根因）：POST
   /sessions/:id/messages 在 withTeam 处理器内部调用 reply.send()——
   Fastify 收到 send 即开始响应、不等事务 COMMIT，紧跟的读请求可能
   读不到刚写入的行（read-your-writes 竞态）。此前 C08 分享检查两次
   在全量/循环运行中间歇漏检（含密消息已 201 但 share-check 读到 0 条）
   即源于此；经事务内探针（消息/资产计数 + 同查询二次执行 + RLS 上下文）
   与 DB 事后核对定位。修复：消息创建改为先提交后响应（payload 由
   withTeam 返回，路由层再 send）。m5-c7c8 循环 15 次不再复现；
   该用例的布置调用同步补上状态断言（再发生时会倒在真实出错行）。
   全量 45 套件 198 项全绿。
   M45 已完成（审批队列复用 CR 差异视图）：差异组件从 Workbench 抽为共享
   组件 components/CrDiff.tsx（CRItemDiff 类型族 + CrItemDiffView 明细 +
   CrItemCard 汇总卡片），审批队列 CR 详情的变更项由纯文本列表升级为
   同款差异卡片——审批者在其主战场（而非只有发布与通道）即可看到
   「属性 N · 制品 N · 关系 N」与逐项差异行，组件与数据源（M43 端点）
   完全一致、无第二份实现。浏览器实测审批队列打开存量 CR：卡片汇总
   「属性 1」→ 展开「+ summary = 补充转移轨道分析结论」。全量 45 套件
   198 项全绿。
   M46 已完成（用量汇总 + 导航闭环 + 图谱平行边）：AGENT 顶栏新增会话级
   用量药丸「Σ 15.3k」——近 20 次运行的 tokens 合计（流式期间随 usage
   事件实时跳动，tooltip 如实注明口径与工具调用数）；资产详情新增
   「在图谱中查看」按钮（复用 graphFocus 聚焦机制），补齐 对话→资产→
   图谱→资产 的导航闭环。走查揪出图谱真实视觉缺陷并修复：多条关系
   夹在同样两节点间时，边与标签全部叠合（演示数据 verifies/derivedFrom/
   documentedBy 三边只剩一团）——平行边按无向规范向（小编号→大编号）
   分配对称车道、二次贝塞尔沿法线弯开、标签锚点随车道沿切向错开
   （箭头仍按真实方向），边元素 line 改 path 后实时与导出 SVG 样式
   选择器同步更新。浏览器实测三边扇形展开、三标签分离可读。
   全量 45 套件 198 项全绿。
   M47 已完成（CR 评审留痕）：退回原因自 M2 起就以 comments 行落库，
   但没有任何端点与界面可见——被退回的 CR 只显示「已退回」而不知为何。
   GET /change-requests/:id 新增 comments（作者/内容/时间，按时间升序）；
   共享组件 CrDiff.tsx 增加 CrComments 评审留痕区（琥珀左边条卡片），
   审批队列与发布与通道两处 CR 详情同步展示。m43 补第二项测试
   （prepare→退回→详情含留痕与作者、快照全部失效）；浏览器实测真实
   退回演示 CR：列表红 chip「已退回」、详情留痕卡含原因全文、快照
   标注「已被新快照取代」。全量 45 套件 199 项全绿。
   M48 已完成（空会话引导提示词）：新会话空态新增三张可点击任务卡
   （检索目录并表格总结 / 为缺制品资产提整理提案 / 检查关系缺口），
   点击即经 send(override) 直接发起真实运行（send 重构为可传参，不再
   只读输入框）；kimi 式 starter prompts 把"第一次怎么用 Agent"降为
   零门槛。浏览器实测全新空会话：点卡即发——用户气泡、asset.search +
   两次 asset.getRevision 工具卡、思考过程（2 轮）、顶栏 Σ 用量药丸
   全链路正常。全量 45 套件 199 项全绿。
   M49 已完成（图数据库本体检索层）：把「本体便于检索」落到真实图数据库——
   新增 packages/graph（@taw/graph，neo4j-driver/Bolt 对接 Memgraph 2.19）+
   docker compose graphdb 服务（127.0.0.1:7687，--query-execution-timeout-sec=10
   兜底）+ 迁移 0023（graph_sync_state 投影状态表 + taw_worker 跨租户读放行，
   沿用 0016 先例）。架构口径：PostgreSQL 是唯一事实源，图库只保存可再生投影
   （类节点=活跃 type_key、SUBCLASS_OF 层次边、Asset 节点 OF_TYPE、存活断言
   RELATES）；同步 = API 六个写咽喉（建类型/建资产/归档/恢复/关系断言/撤回，
   断言核心 createRelationAssertion 覆盖 UI 与语义候选确认两条路）在业务事务内
   盖脏标记，worker 托管的图投影对账器周期重建 + 启动时全团队漂移对账（图库
   容器重建后自动恢复，实测 1859 团队/293 重建/0 失败）；管理员另有 POST
   /graph/sync 手动同步。检索端点：类闭包 /ontology/type-closure（图引擎，
   图库离线回落 SQL 递归 CTE 并如实标注 engine=sql-fallback）、按类检索资产
   /ontology/assets-by-type（闭包内命中）、多跳邻域 /graph/neighborhood
   （图库原生变长路径，硬限深 ≤3）、两资产最短路径 /graph/path（图库边集线性
   拉取 + 应用层 BFS——Memgraph 2.19 无 shortestPath() 且变长路径不做关系
   唯一性剪枝，实测无界展开在环图上组合爆炸 7GiB 分配，故收敛到确定性问题
   解法，方言差异全部实测并记录于 queries.ts 注释）。本体治理页新增「本体检索
   （图数据库投影）」卡：图库在线/离线徽标、待同步/漂移如实提示、上次同步与
   投影计数、按类闭包检索（engine 标注 + 资产表直达详情）、两资产路径链
   （relKey 箭头标注、节点可点跳资产）；走查揪出路径链箭头 off-by-one 并修复。
   tests/m49 十项：在线七项（同步计数/漂移口径/闭包/按类/邻域/路径/撤回后投影
   收敛/团队隔离）+ 降级三项（死端口下 status 如实 reachable=false、闭包回落
   SQL、邻域/路径 503 DEPENDENCY_UNAVAILABLE、URL 恢复后 driver 重建自愈）。
   浏览器实测：真实种子团队走查 闭包检索（图数据库引擎 + 类键 chips）→ 路径
   天线 —dependsOn→ 轨道 —partOf→ 热控（2 跳）→ 节点点击直达工作区资产详情 →
   立即同步（37ms）→ 暗色双主题 → 图谱页无回归。全量 46 套件 209 项全绿。
   M50 已完成（Agent 图检索工具）：把 M49 的图检索能力接进受控工具网关——
   对话即本体检索。三个 read 级工具：graph.assetsByType（按类型键闭包检索资产，
   图引擎优先、图库离线自动回落 SQL 且 engine 字段如实标注 graph/sql-fallback/sql，
   includeSubclasses 可关）、graph.path（两资产最短关联路径；assetId 与名称两用——
   名称精确匹配优先、唯一模糊命中可用、多命中列出候选要求改用 id，found=false
   如实返回、图库不可用如实报错不猜测）、graph.neighbors（多跳邻域 1–3 跳）。
   全部显式携带 ctx.teamId 查询（租户隔离与投影一致）；经既有 SAVEPOINT 隔离与
   调用留痕（ok/error 全落库）。闭包解析从 API 路由抽为 @taw/graph
   resolveTypeClosure/sqlTypeClosure 共享（路由与工具同一实现，无第二份）；
   runner 系统提示词同步声明图谱检索能力。toolRefs 泛化：对象结果的 assets
   数组也解析「相关资产」chips（graph.assetsByType 工具卡可直达资产），lib 单测
   增至 5 项。tests/m50 八项（真实网关 + 图库）：闭包检索与过滤/精确类型引擎标注/
   非法参数报错/路径链与跳数/歧义名与未命中/同资产拒绝/租户隔离（他团队同名
   资产解析不到）/离线降级与恢复自愈/调用留痕落库。真实 DeepSeek 浏览器走查：
   问「天线布局和热控报告怎么关联 + analysis.asset 及子类有哪些资产」——Agent
   真实调用 asset.search → graph.assetsByType → graph.path，回答给出
   dependsOn→partOf 两跳链条与 4 资产闭包表格，并如实标注「检索引擎：graph」；
   工具卡展开含相关资产 chips；Σ 用量药丸 7k/4 次调用。全量 47 套件 218 项全绿。
   M51 已完成（NL 关联路径直达图谱）：把 M49/M50 的路径检索接进自然语言入口。
   解析：nl.ts 新增第五意图 graph_path（fromName/toName，schema 强制两端齐全，
   缺端视为未通过白名单）；L1 三种句式（「A和B怎么关联」「A与B有什么关系」
   「从A到B的路径」，引号容错、容忍「查一下/看一下」前缀、箭头变体；两端相同
   或缺失不命中落空交给 L2/搜索回退——不猜测）；L2 提示词白名单同步扩为五选一。
   界面：CommandBar 意图卡显示「查询「A」与「B」的关联路径」；Workbench
   executeNlIntent 新增 graph_path 分支——名称→id 解析（精确名优先、唯一模糊
   命中可用，失败如实 flash）后置 graphPathReq，图谱页 RelationGraph 新增路径
   模式：拉取 /graph/path，横幅展示「关联路径 · N 跳」+ relKey 箭头链条（按真实
   方向、节点可点直达资产）+ 退出按钮；链上边加粗提色（accent）、其余边与节点
   暗化，独立 SVG 导出样式同步带高亮；未找到/图库 503 如实横幅提示。空会话
   任务卡新增第四张「关联路径分析」示例。tests/m51 八项：L1 三句式与容错/同名
   端点不命中/既有意图无回归/schema 缺端拒绝/端点 L1 命中带规则溯源/未登录
   CSRF 门。浏览器实测：⌘K 输「天线布局仿真报告和热控系统仿真报告怎么关联」
   → 规则解析 → 执行 → 图谱页横幅「关联路径 · 2 跳」+ dependsOn→partOf 链条、
   链路边绿色高亮其余暗化。全量 48 套件 226 项全绿。
   M52 已完成（资产详情多跳关联）：查看任何资产时即可看到「N 跳内有什么、
   怎么连过去」——资产详情在「关系」卡之后新增「多跳关联（图数据库）」卡：
   跳数 1–3 可选（默认 2），数据来自 GET /graph/neighborhood（图库邻域端点，
   M49 就绪），前端 lib/hopChains 纯函数在返回的子图边上做无向 BFS，为每个
   关联资产生成从本资产出发的最短关联链（每步 relKey 箭头按真实方向标注，
   终点可点击直达资产；环图不回头、先到者即最短）。降级诚实：图库停机 503
   如实展示错误与刷新入口、投影滞后（found=false）提示待对账；docker stop
   taw-graphdb 实测降级文案、重启后刷新自愈。AssetDetailPanel 补 onOpenAsset
   通道（与目录/图谱同一 openAssetFromSearch）。lib 单测 4 项（线性链方向/
   逆向与最短优先/环图不回头/空边集）。浏览器实测：M49 演示团队「轨道传播
   模型分析报告」详情显示两条 1 跳链（partOf→ 热控、←dependsOn 天线），终点
   可点；停库降级与恢复自愈；暗色主题正常。全量 49 套件 230 项全绿。
   M53 已完成（调研吸收轮：分面检索/流式输出/图谱降噪）：广泛调研 9 个开源
   元数据/资产管理项目（DataHub/OpenMetadata/Atlas/NetBox/CKAN/OpenCTI 等），
   调研笔记与吸收清单落 docs/implementation/research-M53-opensource-survey.md。
   落地五块：①CKAN 分面——GET /assets/facets（在用类型/标签计数/分类路径真值
   聚合），/assets/search 补 label（修复参数声明却未实现的真实缺口）与 typePrefix
   两个过滤；目录资产列表新增家族快筛 chips（文档/代码/测试/仿真/数据，纯函数
   lib/typeFamily 前缀映射、自定义类型回落不强行归类）+ 类型/标签下拉（带计数）。
   ②随取随用——GET /assets/:id 修订携带 artifacts，详情页新增「制品（当前修订）」
   卡（角色/大小/一键下载）；GET /blobs/:digest 补 content-disposition
   filename*=UTF-8''（回真实文件名），顺带修复该查询漏租户上下文、RLS 下静默
   查不到文件名的真实缺陷；详情主卡展示标量属性，http(s) 值渲染为可点外链
   （NetBox Custom Links 轻量形态）。③关系目标可点——详情「关系」卡端点已带
   source/target_asset_id，渲染为按钮直达对应资产。④Agent 真·流式输出——
   adapter 新增 chatStream（OpenAI 兼容 SSE；createStreamAccumulator 纯函数
   离线单测：内容增量/工具调用按 index 归并/usage 收尾帧/残帧容忍），runner 以
   300ms 合帧把 message_delta {delta,turn} 先于 message 终值落库（append 失败
   不终止运行，终值事件兜底），前端 message_delta 逐字渲染（turn 感知、换回合
   旧段自动收入思考过程），工具卡加耗时显示。⑤图谱去杂乱（OpenCTI 思路）——
   类型图例点选显隐（图例覆盖全部参与类型含被隐藏的，off 态可单独恢复，避免
   「藏了就找不回」）、度数降噪（度 ≥ N 剪边，达标节点即使连边被剪光也保留——
   星型图中心枢纽不丢失，专门修了首版全灭缺陷）、边标签开关（localStorage 记忆），
   降噪后空态文案如实区分。
   测试：流式累积器 4 项 + typeFamily 3 项 + tests/m53-facets 七项（facets/
   label/typePrefix/has_artifacts/content-disposition）+ tests/m53-agent-stream
   （真实 DeepSeek 流式运行：message_delta 落库、同回合增量拼接=message 终值、
   增量先于终值的次序不变量）。浏览器实测：目录家族过滤/📎 标记、详情制品下载
   与关系直跳与属性直链、Agent 运行文本逐段增长（5→111→548 字符采样）+ 工具卡
   展开详情与耗时 + 用量条、图谱图例显隐往返/降噪保留中心/标签开关、docker stop
   taw-graphdb 诚实降级文案与重启自愈；暗色主题视觉正常。全量 53 套件 245 项全绿。
   M54 已完成（调研吸收二轮：使用与复用）：第二批调研 HF Hub / MLflow /
   Dataverse/Zenodo / Backstage / Terraform Registry / npm（两份独立调研合并，
   笔记追加于 docs/implementation/research-M53-opensource-survey.md）。落地
   五项+清偿两项老化候选：①详情页「复制引用」——HF Use-this-model / Dataverse
   Cite-as 思想，一键复制规范引用串（与 Agent @ 引用 formatContextRef 同格式）。
   ②「关联最多」排序——/assets/search 增 relation_count（未撤回关系断言数，
   LATERAL 计数）与 sort=refs（ORDER BY CASE DESC NULLS LAST + created_at
   次序），目录新增「关联」列与排序下拉（npm ?ranking= 可保存视角思想）。
   ③依赖链健康警示——/relations 出/入边携带端点 lifecycle；详情页 dep-alert
   横幅「依赖链上存在非进行中资产：上游/下游「名」（已归档/已弃用）」——Atlas
   分类传播 + Backstage orphan 横幅的读侧诚实形态：只提示不自动改状态，治理
   动作仍由人执行。④筛选 URL 化——目录筛选（q/type/family/label/lifecycle/
   sort）写回查询串；?view=assets 直达目录并恢复全部筛选（可收藏可分享），
   离开目录视图清参防陈旧。⑤图谱聚焦改走服务端 /graph/neighborhood（M52 以
   来老化两轮候选清偿）：图库在线引擎=graph（提示「邻域子图来自图数据库服务
   端」），503/投影滞后回退客户端 BFS（提示如实区分），relId 与断言 id 同源
   交集。⑥NL L1 新句式「X 的关联资产/相关资产/多跳资产/邻域资产」→ 图谱聚焦
   （搜索/查找/查 前缀让位搜索意图，纯动词不命中，既有句式零回归）。
   tests/m54 六项：句式命中与让位与回归 + refs 排序置顶与降序一致性 + 默认
   排序回归 + 归档上游后 lifecycle 数据源。浏览器实测：分享链接
   ?view=assets&family=document&sort=refs 刷新直达且筛选全恢复；「关联最多」
   模型（3 条关系）置顶；模型详情上游「回归测试集」（已归档）警示横幅与复制
   引用按钮（IAB 剪贴板权限受限无已复制反馈，真实浏览器可用）；⌘K「轨道传播
   模型的关联资产」规则解析→执行→图谱聚焦 + 服务端引擎标注；docker stop
   graphdb 后切跳数触发回退标注「已回退目录数据客户端计算」、重启自愈。
   全量 54 套件 251 项全绿。
   M55 已完成（使用度事件与别名引用，调研清单头两项落地，0024 迁移）：
   ①使用度事件——usage_events（kind: download/copy_ref/agent_read，RLS 租户
   隔离 + 索引），埋点全部落在真实行为处：GET /blobs/:digest 真实下载（与
   文件名查询合并为一次 JOIN，best-effort 不阻塞下载）、详情「复制引用」
   （navigator.clipboard 成功后才上报，IAB 剪贴板受限时如实不计）、Agent 工具
   读取（asset.getRevision / relation.query / graph.path 两端 / graph.neighbors
   种子资产，经 recordUsage 随工具事务提交——runner 外层 withTeam 提交语义与
   m50 教训一致）。search 增 usage_count LATERAL（90 天窗口）与 sort=usage；
   详情返回 usage 分项，界面「使用热度」行（近 90 天 x 次（下载 · 引用复制 ·
   Agent 读取））+ 目录排序第三档「最常使用」。②别名引用——asset_aliases
   （团队内唯一小写 slug ^[a-z0-9][a-z0-9._@-]{1,63}$，FK assets、RLS、索引），
   POST/DELETE /assets/:id/aliases（创建者或管理员；冲突 409 ALIAS_TAKEN、
   格式 422）、GET /assets/by-alias/:alias（跨团队 RLS 404）；详情 aliases
   数组 + 内联增删 UI（chips ×）；/assets/search q 命中别名；Agent
   resolveAssetRef 解析顺序变为 名称精确 → 别名精确 → 唯一模糊（工具描述
   同步更新，未命中报错文案提及「名称或别名」）——下游按稳定短名消费、资产
   升级换版不断链（MLflow models:/name@alias 思想）。
   tests/m55 七项：别名创建/解析/冲突 409/非创建者 403/格式 422/删除后 404/
   跨团队隔离、搜索命中别名、usage 端点 kind 白名单（download 拒绝）、真实
   下载两次计数、sort=usage 置顶与降序一致、Agent getRevision 埋点随
   seedInTeam 提交（真实 agent_runs 行满足外键，同 m33/m50）、graph.neighbors
   按别名解析成功。浏览器实测：详情添加别名 prod-model 即时成 chip；复制
   引用/下载后热度分项刷新（软件资产「下载 2」来自真实下载，模型「引用复制
   2」）；目录「最常使用」模型置顶且 URL ?view=assets&sort=usage 可分享。
   全量 55 套件 258 项全绿。
   M56 已完成（资产集合——人工策展，调研清单第三项落地，0025 迁移）：
   asset_collections（团队内名称唯一，复合主键 (team_id,id) 同 house 模式）+
   asset_collection_items（(team_id, collection_id, asset_id) 唯一、note 收录
   备注 ≤500 字、FK 两表、ON DELETE CASCADE，RLS 租户隔离）。定位：权威榜单/
   新人入门包/评审材料包——检索负责发现、集合负责沉淀（HF Collections 思想）。
   路由 /collections：POST 创建（重名 409 COLLECTION_TAKEN）、GET 列表
   （item_count ::int；按 assetId 过滤附 contains_asset——详情页勾选态数据源，
   无 assetId 时语义为 null）、GET 详情（条目含类型/生命周期/备注/收录人）、
   PATCH 改名/描述与 DELETE（创建者或管理员；改名撞名 409）、条目 POST/
   PATCH note/DELETE（全员日常协作，同 Issues 权限语义；重复 409、未知资产
   422）。安全修复（测试先行暴露）：集合路由最初只靠 RLS 没有显式成员校验
   ——RLS 隔离行但不校验调用者归属，外人可凭 body.teamId 越权写入；全部
   端点补 teamRole（NOT_FOUND 化非成员）。UI：工作台新增「集合」标签页
   （左列表右详情：新建表单、条目表、备注内联编辑、改名/删除按 canManage 显
   示）+ 资产详情「集合」卡（所在集合 chips × 移除、下拉+备注加入、加入后
   即时成 chip）；?view=collections 直达（可分享）。Agent 新增 collection
   .search（读，关键词过滤+条目数）与 collection.add（草稿层：集合按名精确/
   id 解析（多命中列候选），资产走 resolveAssetRef 名称→别名→模糊，note
   收录理由，重复如实报错「已在集合中」）；NL L1 新句式「把 X 加入集合 Y」
   （加到/加进/收入变体、引号容错；资产侧代词或缺侧不猜测不命中）+ LLM 白
   名单第六意图 add_to_collection（superRefine 两侧必填），命令栏卡片双重
   确认后前端解析两端（/assets/search + /collections）再调条目接口——解析
   端点零副作用原则不变。
   tests/m56 九项：创建/重名 409/空名 422、条目加入（成员协作+备注）/重复
   409/未知资产 422/contains_asset 两态、备注更新与清空+移除再删 404、管理
   权 403/改名/撞名 409/描述、跨团队隔离三路 404、级联删除后资产无恙、NL
   句式命中/代词与缺侧不命中/既有句式零回归、Agent collection.search/
   collection.add 真实运行（seedInTeam+真实 agent_runs 行同 m55；含未登记
   别名如实报错与重复如实报错）。浏览器实测：建集合→详情「加入集合」带备注
   chip 即现→条目表改备注→⌘K「把接口规范文档加入集合新人入门包」规则解析
   卡（零模型成本）→执行 flash 成功→条目 2 项；?view=collections 直达；
   真实 DeepSeek 一句话跑通 collection.search→asset.search→collection.add
   （备注「链路依赖软件」）并如实汇总条目数 3。
   全量 56 套件 267 项全绿。
   M57 已完成（越权修补 + 显示优化 + 使用片段，用户点名「对话框过大/漏洞修补/迭代」）：
   ①跨租户越权修补——全端点扫描（脚本核遍 GET/POST/PATCH/DELETE 三要素：CSRF/
   认证/成员校验）坐实 M56 同类漏洞 5 处：POST /issues、/issues/:id/status、
   /issues/:id/comments、POST 与 GET /sessions/:id/messages——这些端点只靠
   withTeam 设 RLS 租户上下文，而 RLS 只隔离行、不校验调用者归属：任何登录
   用户伪造他团队 teamId 即可读会话消息、向项目可见会话注入消息、建工单、
   推工单状态、评论。全部补显式成员校验（teamRole/team_members，非成员 404）；
   复扫全绿。其余标记项人工核明为安全模式（assertTeamMember/assertProjectAccess
   或先 RLS 行查找后写）。②显示优化——Agent 对话框默认宽度 44%→36%（用户反
   馈过大）；存储键 taw-pane-pct 升 v2：旧键里的 44 是挂载即写造成的伪用户选
   择，不继承；拖动下限 25→22；chat-scroll 与 pane-label 内边距/间距紧凑化
   （gap 18→13px）。③使用片段模板（调研清单第四项，HF/Terraform 思想）——
   packages/domain buildSnippets 纯函数 + GET /assets/:id/snippets：按类型
   家族生成（simulation→YAML 调用配置：别名 asset 行 + head 标量属性 + 嵌套
   对象展开如 validStepSeconds.min + 稳定键序；software→依赖声明示意；
   document→Markdown 引用；通用：Agent 引用（与 M54 复制引用同格式）、JSON
   引用（digest 16 位截断）、别名短引用 assets:alias + 不断链说明）；详情页
   「使用片段」卡：点选展开 + 复制（clipboard 成功后计 copy_ref 使用热度，
   与 M55 埋点同源）。
   tests/m57 六项：外人读/写会话消息 404 且验证未写入、外人建工单/推状态/
   评论 404 且成员路径无回归、片段端点四类内容（agent-ref 同格式/JSON/
   short-ref/config 嵌套展开）+ 跨团队 404、software/document 家族分派与无
   别名时无 short-ref、buildSnippets 纯函数（digest 截断/空属性回落/未知家族
   仅通用两条）。浏览器实测：面板 333/926=36% 视觉确认（截图比例分析对话区
   与工作区约 1:1.8 合理）、旧存储键 44 未继承（v2=36）；片段卡四条目渲染、
   YAML 与别名短引用展开内容核验（assets:prod-model、frame: ECI、
   validStepSeconds.min: 0.1）。
   全量 57 套件 273 项全绿。
   M58 已完成（发布测试门禁 + 批量关联下载，用户新目标两个点名缺口，0026 迁移；
   调研笔记 docs/implementation/research-M58-release-gate-bundle.md——GitHub
   required checks / HF snapshot_download / BagIt+Frictionless 双 manifest）：
   ①发布测试门禁（「部分模型需要过测试才可以通过」）——策略声明在类型层：
   asset_type_versions.requires_test_evidence（0026，不可变，改门禁=注册新版本，
   与 schema 演进同构；类型链上任一定义声明即门禁类型，与属性校验链语义一致）。
   POST /types 接受 requiresTestEvidence + GET /types 带回标志；本体页登记表单
   「发布测试门禁」开关 + 类型树「需测试证据」chip。证据只认候选精确修订上的
   测试运行（test_runs.target_content_digest 绑定），取 executedAt 最新一次
   （id 决胜保证确定性）：曾过但最新 fail/error/skipped 一样拦（GitHub strict
   模式）。prepare-review 把逐项门禁状态冻结进候选摘要与快照载荷（CR 详情
   items[].test_gate 展示「需测试证据 · 通过/尚无运行/最新 fail」，评审者先见）；
   review-and-publish 现场重算双保险——未满足 409 TEST_GATE_REQUIRED（details
   带资产与最新结果），prepare 后状态翻转由快照摘要失配兜底（B04 同机制，
   退回重提后放行）。开 CR 不拦（对齐「required checks 卡 merge 不卡 PR」）；
   非门禁类型零影响（test_gate.not_required）。CrItemCard 门禁 chip 红显未满足
   （.gate-blocked）。测试运行录入端点沿用 M3 生命周期 test-runs（绑定被测修订
   +结果+环境+日志摘录）。
   ②批量关联下载（「可以批量关联下载」）——GET /assets/:id/bundle?depth=1..3&
   direction=out|in|both：confirmed 关系闭包（BFS 防环、200 资产上限截断警告）
   各取当前头修订；GET /collections/:id/bundle：策展集合即批量范围（flat 不扩
   散）。一次 HTTP 请求流式返回 store-only 自描述 ZIP：manifest.json（Frictionless
   风格：来源与参数/资产（别名、修订、内容摘要、属性、制品）/闭包内关系（带
   标题）/警告）+ manifest-sha256.txt（BagIt 风格逐文件校验和，sha256sum 双空格
   格式，离线可核）+ 制品原文件（assets/<typeKey>/<安全化名>/<消解重名后的原名>，
   Windows 保留字符替换、同目录重名 -2 后缀）。@taw/domain/bundle 纯函数四件：
   traverseClosure / buildBundlePlan / buildStoreZip（确定性：固定 DOS 时间戳
   1980-01-01、CRC32、UTF-8 名、零新依赖）/ checkTestGate——API 与单测同源；
   ZIP 体积上限 256MB（超限 422 引导分批）；包内每资产计一次 download 使用热度
   （M55 白名单复用）；越权同 M57 教训显式 teamRole（外人伪造 teamId 404、畸形
   id 404、缺 teamId 422）。UI：详情页「批量下载」卡（跳数 1-3/方向选择/直接关
   联计数/<a download> 原生下载）+ 集合详情「⬇ 下载集合包」（空集合如实不显示）。
   schema 标准入库为既有能力（M2/A03 类型链 JSON Schema 全量校验），本轮未改动。
   tests/m58 十一项：纯函数四组（闭包深度/方向/防环/截断；路径安全化/重名消解/
   校验和行/闭包外边过滤；ZIP 确定性/CRC 向量/解析回读；门禁四态+摘要不匹配+
   同刻 id 决胜）+ 集成七项（闭包打包 manifest+校验和+制品原文+热度计数、方向
   过滤、集合打包/空集 422/畸形 404、越权 404/422、门禁拦截→补证据摘要失配→
   退回重提放行全闭环、strict 回归拦截、非门禁零影响回归）。修复两处真实缺陷：
   dedupePath 相对偏移换算错误（重名消解把扩展名吃进 stem）、集合 bundle 畸形
   id 直透 PG 报 500（补路径参数校验）。
   浏览器实测（M49 演示团队真实数据）：详情页批量下载卡渲染（直接关联 1 个）+
   页面内真实下载——ZIP PK 魔数/application/zip/UTF-8 文件名，2 跳闭包 hop
   0/1/2（天线布局→轨道传播→热控系统）、关系带标题（依赖/属于）；集合页建
   「M58移交验证包」加两资产→「下载集合包」真实打包（source.kind=collection）；
   本体页 UI 注册 m58.safety.model（门禁开关开启）→ 树上「需测试证据」chip；
   CR 详情变更项「需测试证据 · 尚无运行」红显 chip；作者自审发布 403（B03 既有
   不变量，UI 如实显示）；第二评审员无证据被拦（409 TEST_GATE_REQUIRED 集成已
   证，浏览器侧手动 cookie 受浏览器安全模型限制改 curl 完成同一闭环）→ 记 pass
   运行 → 旧快照摘要失配 → 退回重提 → 评审员带证据发布成功
   REL-2026-09-29-c46695。截图四张：m58-ui-bundle-card / m58-ui-collection-
   bundle / m58-ui-type-gate / m58-ui-cr-gate-chip。走查中 DB 沉淀：M58 临时
   数据（m58.safety.model 类型、M58安全模型、回归套件、移交验证包、评审员
   账号）留在 M49 演示团队，与历史走查数据共存惯例一致。
   全量 58 套件 284 项全绿（M57 后 +1 套件 +11 项）。
   M59 已完成（更新与入库的全路径 schema 强制，用户点名「保证更新与入库必须经过
   设定的 schema」；调研笔记 research-M59-schema-enforcement.md——OpenMetadata
   「实体定义即数据契约，后端对一切写入按 schema 校验」+ Backstage catalog
   validate 端点）。现状核对：类型↔schema 关联自 M1 已有（类型定义版本携带
   json_schema 不可变）；登记自 M2/A03 已校验。全仓库修订写入点只有两个——
   登记与**分支草稿保存（未校验，即资产「更新」主路径可完全绕过 schema）**。
   ①共享关卡：apps/api/src/ontology.ts——loadTypeChain（子→父→根，防环+深度
   上限）+ validateAgainstChain（全链逐定义校验，AJV 全量约束 required/type/
   enum/min/max + 单位词表，错误带 [typeKey vN] 前缀）；登记、分支保存、dry-run
   共用同一实现，规则不可能分叉（catalog.ts 原地内联循环已替换）。
   ②更新强制：POST /branches/:id/revisions 对合并后属性做全链校验，不合规 422
   ——「更新必须经过设定的 schema」闭环（草稿→CR→发布的候选全部产生自已校验
   修订；Agent 草稿工具只写提案不写修订，无第三条路）。
   ③发布复核：prepare-review 对每个候选修订属性重验全链，不合规 409
   CANDIDATE_SCHEMA_INVALID（修订与类型定义均不可变，创建时过卡的候选此处恒过
   ——零成本纵深；真实拦截对象是校验上线前存量的不合规历史草稿，它们不能借
   旧 CR 进入正式审核）。
   ④dry-run：POST /assets/validate（成员可用、零副作用）返回 {valid, errors}，
   与真实写入同源（Backstage validate 端点思想）；登记表单新增「校验」按钮
   （cleanedProps 提取为提交/校验共用函数，两侧口径不可能分叉）。
   tests/m59 五项：登记链前缀回归（子+祖先各报一条）、分支非法属性 422 且未
   写入（类型错+越界各拦、修订数不变）、合法草稿 r2 回归、存量欠账（应用角色
   直插不合规修订+分支条目→CR→prepare 409，正路候选重提 201）、dry-run 同源
   判定/缺必填判出/越权 404。测试自修一处：withTeamDb 是 ROLLBACK 只读包装器，
   模拟「绕过端点直插」需会话级 autocommit 助手 writeTeamDb。
   浏览器实测（M49 演示团队）：登记表单选仿真模型→空属性「校验」→如实列出
   6 个必填缺失→填齐→「✓ 属性满足当前类型链的全部定义（含祖先）」；资产详情
   「修改资产」卡新建分支 m59-schema-check→name 改 123 保存→422 且 UI 显示
   链上两个定义错误（[sim.report v1.0.0] + [analysis.asset v1.0.0]，祖先链
   生效的直接证据）→改回合法→「草稿已保存：r2」。截图：m59-ui-validate-btn、
   m59-ui-draft-gate。
   全量 59 套件 289 项全绿（零回归——既有分支/发布链路的历史测试数据本就合规）。
   M60 已完成（Schema 便捷生成，用户点名；调研笔记 research-M60-schema-builder.md
   ——quicktype/jsonschema.net 推断惯例 + required unanimity 规则 + 表单式 schema
   编辑器）。定位：M59 把「校验」补强后，「设定」侧的手写 JSON 门槛成了瓶颈。
   ①@taw/domain/schema-builder 纯函数两件：fieldsToSchema（表单属性行→schema，
   类型联动约束、键非法/重复/类型不匹配如实列 problems 不静默）+
   inferSchemaFromSamples（样例→schema：unanimity 必填——全部样例出现才必填、
   嵌套展开深度上限 2 层如实注明、数组元素一致才约束 items、类型冲突回落宽松{}
   并注明、null 跳过、非对象样例忽略；**枚举不机械推断**——样例区分不了受控值与
   自由文本，notes 提示人工设定）。②POST /types/infer-schema（成员可用、零副作用、
   compileTypeSchema 防御复核）；web 经 workspace 直引 schema-builder 子路径
   （模块无 ajv 依赖）。③本体页类型表单三模式（默认表单构建/样例推断/手写 JSON）：
   属性行编辑器（string→枚举输入、number/integer→min/max、array→元素类型联动）、
   生成物实时预览、统一回流 schemaText 单一事实源、任意模式可切手写微调；提交
   仍走 POST /types 全部质量门与 M59 关卡——生成只降「设定」门槛不降「校验」强度。
   tests/m60 七项：fieldsToSchema 完整行/枚举中英逗号/problems 四类；推断单样例全
   必填+嵌套+数组/unanimity+类型冲突/null+元素混杂+深度上限+全非对象；端点同源+
   非对象忽略+越权 404+空样例 422；端到端闭环（推断产物注册类型→符合样例资产
   201→违反者 M59 关卡 422）。全量 60 套件 296 项全绿（环境注记：宿主重启致
   PG/graphdb 容器退出，docker compose 重新拉起后零改动全绿——非代码回归）。
   浏览器实测：表单构建模式填 frame 枚举+level integer 0-10 → 实时预览正确生成
   → 真实登记 m60.form-built 入类型树；样例推断模式粘贴两行样例 → memo「仅在
   1/2 个样例中出现」未设必填、validStepSeconds.min 类型冲突如实回落宽松+注明、
   嵌套 required 展开正确 → 登记m60.inferred 成功。截图：m60-ui-form-builder、
   m60-ui-infer。
   M61 已完成（自然语言生成 schema 草稿，M60 候选首位；调研笔记
   research-M61-describe-schema.md）。POST /types/describe-schema（成员可用、零
   写入）：真实 DeepSeek 严格 JSON → SchemaDraft 白名单（zod strictObject：未知
   字段拒绝、类型六枚举、1..24 行、长度上限）→ fieldsToSchema 键约束复核 →
   compileTypeSchema 防御复核，四层防线；key 未配置 503 如实降级不伪造（Agent
   无 key 不 mock 同口径）。UI：表单构建模式顶部「用一句话描述类型」+「AI 生成
   草稿」——回填属性行与 typeKey/title 建议（只填空位不覆盖已填）、meta 显示
   模型与 tokens、「请人工确认微调后再登记」常驻。三通道（表单/样例推断/自然
   语言）汇于同一表单与质量门。vitest alias 补 @taw/api/routes/catalog。
   tests/m61 四项：白名单五类拒绝（未知字段/坏类型/空行/超 24 行/required 非
   boolean）、真实 DeepSeek 草稿（结构+可编译+枚举识别+零写入：types 列表前后
   不变）、replace-me 哨兵 503（stubEnv，M31 口径）、越权 404/短描述 422。
   浏览器实测全链路：「热控仿真报告：坐标系枚举 ECI/ECEF/LVLH 必填；报告编号
   必填；温度上限 0-500 整数；标签字符串数组」→ 331 tokens 草稿四属性全对
   （coordinateSystem 枚举/reportNo 必填/temperatureLimit 0-500/tags array）→
   LLM 建议 typeKey sim.report 与既有类型撞名（正好验证人工确认环节）→ 改
   m61.ai.report → 登记成功入类型树。截图：m61-ui-ai-draft。schema 生命周期
   四段就此齐备：便捷设定（M60+M61）→ 入库/更新强制（M59）→ 测试门禁（M58）
   → 发布复核（M59/M58）。
   全量 61 套件 300 项全绿。
   M62 已完成（Schema 驱动的登记表单，M61 候选「schema 约束的前端预填」升格；
   调研笔记 research-M62-schema-form.md）。修的是 M59 强制关卡之后暴露的输入侧
   四个坑：①祖先链字段不可见（表单只渲染所选类型自身 properties，而
   validateAgainstChain 逐环校验——父类 required 字段被子类 schema 省略时表单无
   输入位、登记必挂且无从下手）；②布尔字段文本框提交字符串必挂；③min/max/
   长度/pattern/单位词表零提示；④数组只按字符串切分。@taw/domain/schema-form
   纯函数三件：schemaToFormSpec（类型链→字段规格，语义与 validateAgainstChain
   严格对齐——字段=链上并集、required=并集、有效约束=各环**交集**（数值/长度取
   更紧、枚举取交集、派生侧漏写 min 不会放松祖先 min）、枚举无交集如实报治理债、
   单位词表并入 <name>Unit 下拉且 schema enum 优先、仅祖先声明标 inheritedFrom；
   锚点 rjsf/JSON Forms/Formly 但自建薄转换层，类型链合并是本项目特有语义）；
   formValuesToProperties（表单字符串→类型化属性：布尔/整数/数值/按元素类型
   列表/JSON，坏值收集 problems 不抛，替换 cleanedProps）；checkFormValues（本地
   预检，咨询性——必填/枚举/词表/范围/长度/格式/元素类型，完整语义仍由服务端
   ajv 权威）。web 登记表单：按 (parent_type_key, parent_version) 从 GET /types
   全量行重建链（深度/环防御同 loadTypeChain 口径），字段渲染部件化（枚举/布尔
   下拉、整数/数值输入模式、JSON/列表、约束人读提示行、继承来源标注、链并集与
   封闭说明）；「校验」与「登记」先本地预检，拦截成功省掉必然 400 的往返，通过
   后仍可走服务端 dry-run。tests/m62 六项：单类型规格、链合并（交集/无交集治理
   债/继承标注/closed）、词表并入三级优先、换算（含坏值不抛）、预检命中与放行、
   端到端（两级链 GET /types 重建→并集字段填满→dry-run 全链通过；漏继承字段
   本地预检+服务端 [parent vX] 前缀双重拦截；词表外值 422 且本地预检提前发现）。
   浏览器实测：curl 造 m62.ui.base/m62.ui.orbit 两级链 → 表单四字段（frame 收窄
   枚举仅 ECI/ECEF、level * 范围 0~3 提示、timeUnit 词表下拉 s/ms+词表名提示、
   Owner *（继承自 m62.ui.base v1.0.0）+ 并集说明）；空表单校验→本地预检报缺
   level/owner；level=9→「超过上限 3」；level=2→服务端 dry-run ✓；登记成功入
   目录。截图：m62-ui-form-spec、m62-ui-registered。全量 62 套件 306 项全绿。
   M63 已完成（bundle 离线校验与回导工具，连续两轮落选按约定升格必做；调研笔记
   research-M63-bundle-verify-import.md）。补 M58 批量下载的后半程：①@taw/domain
   bundle-verify——readStoreZip（与 buildStoreZip 对称的 store-only ZIP 读取：EOCD→
   中央目录→局部头切片，CRC32 复核，压缩/ZIP64/加密如实拒绝）+ verifyBundle
   （BagIt RFC 8493 口径：complete=payload↔清单双射与 valid=校验和全对**分开报告**，
   加 manifest 交叉核对——制品 path/digest/size 与 zip 实物一致、tawBundle 版本；
   已知边界如实：manifest.json 自身不在 checksum 清单，纯元数据改写包内不可证）。
   ②scripts/bundle-tools.ts CLI（tsx，npm 场景零新依赖）：verify（零网络，退出码
   0/1，--json）+ import（先离线校验不过即拒——无 --force 后门；再走公开 API 登录/
   CSRF/上传/登记/建关系，与界面同一套 M59 关卡，无旁路；类型按 typeKey+version
   精确解析缺失如实跳过；制品内容寻址上传去重、上传后摘要与 manifest 不符即中止；
   关系按 type_key 解析最新版+evidenceNote 注明回导来源；--dry-run 零写入先看计划；
   别名/测试运行/lifecycle 不回导并在报告注明；部分成功不回滚）。③修 M58 两个真
   缺陷：manifest 关系 predicate 存的是标题（人读）而非 type_key（机器可解析）——
   改为 predicate=type_key + predicateTitle 标题；revision_artifacts.size 是 bigint，
   node-pg 运行时返回 string 导致 manifest 里 size 是字符串、包容量 reduce 变字符串
   拼接——SQL 补 size::int，verifyBundle 的 size 核对从静默跳过改为如实报错。
   tests/m63 七项：读取器往返；校验 ok/篡改字节（valid=false 点到文件）/缺文件/
   多文件（complete=false 双射）/坏清单行/manifest 摘要交叉核对；API 端到端（真实
   下载包离线校验通过→dry-run 类型缺失如实列→补类型后全量导入资产+制品+关系→
   公开查询口径可见）；坏包拒绝导入零写入。m58 两处断言随格式修正同步。全量
   63 套件 313 项全绿。真实服务器 CLI 实测：演示团队造数据→curl 下载包→verify ✓
   exit 0→制品替换篡改→verify ✗（校验和+manifest 摘要/大小三重抓获）exit 1→
   新团队 dry-run（类型缺失如实跳过）→补注册同版类型→正式回导 2 资产+1 关系
   exit 0；进程退出用 exitCode 避免 Windows/libuv 断言。证据：
   docs/evidence/m63-cli-bundle-tools.txt。
   M64 已完成（schema 表单贯穿草稿编辑 + 门禁提示前移，两个连续落选候选合并一轮；
   调研笔记 research-M64-draft-form-gate-hint.md）。①抽取共享
   components/SchemaForm.tsx：FieldInput/fieldHint/SchemaFields/chainFromTypes——
   登记与草稿编辑同一套链重建与字段渲染（rjsf/JSON Forms 同一表单组件服务
   create/edit 的惯例），M62 的链合并/部件/预检只此一份。②域层增补两纯函数：
   propertiesToFormValues（类型化属性→表单字符串预填，六类型往返；schema 外属性
   分离 extra 保留开放世界表达力；含逗号标量数组如实注记失真风险）+
   chainRequiresTestEvidence（链上任一环声明即 required，与 checkTestGate 语义
   同源）。③DraftPanel 双模式：表单模式（默认，head 属性预填 + 额外属性 JSON 区）
   /JSON 模式（原文本域保留），互转不丢内容（表单→全量 JSON、JSON→表单+extra）；
   保存前本地预检。④**行为发现：草稿保存是补丁语义**——服务端按
   {...head.properties, ...body.properties} 合并后校验存储，清空的键沿用 head 值
   （不删除）不 422；草稿侧预检按合并视图查（否则误拦服务端会接受的保存），
   纯函数对裸值仍报缺必填（两层口径各有其用，测试分别断言）。⑤门禁提示前移：
   登记表单选中类型后链上任一环 requires_test_evidence 即显示「🔒 此类型链声明
   需测试证据…（登记与草稿不受阻，发布关卡强制）」——提示时机提前，不改变关卡
   位置；草稿面板同款小字提示。tests/m64 四项：chainRequiresTestEvidence 任一环
   语义；预填往返+extra 分离+逗号注记；GET /types 暴露 requires_test_evidence；
   草稿端到端（预填→改字段→换算合并→201；预检拦枚举外值+服务端 M59 兜底 422；
   补丁语义契约：清空键沿用 head 值 201 且新修订坐实；JSON 模式等价）。
   浏览器实测：登记表单选 m64gated → 🔒 提示 + accuracy* 范围 0~1；M63 CLI Manual
   详情「修改资产」→ 表单模式预填 note=handbook → 改 v2 → 保存 r2 成功 → JSON
   模式互转保真 → 切回表单。截图：m64-ui-gate-hint、m64-ui-draft-form。全量
   64 套件 317 项全绿（环境注记：宿主重启致 PG/graphdb 容器与 dev 服务退出，
   docker compose 重新拉起后零代码改动全绿）。
   M65 已完成（资产元数据完整度 scorecard 与引导，M54 起挂账十轮按老化约定升格；
   调研笔记 research-M65-completeness-scorecard.md）。锚点 Backstage TechInsights
   Scorecard（布尔检查+权重+可执行提示）与 Catalog「必填阻断/推荐引导」分层。
   ①@taw/domain/completeness：computeCompleteness 六项加权检查合计 100——
   schema_required 25（链上必填属性齐备，与登记表单同一份 schemaToFormSpec 链
   并集，兜住 M59 前存量欠账）、owner 20（惯例键 owner/ownerName/maintainer/
   responsible/author/creator 之一非空，HF model card/Backstage spec.owner 惯例）、
   relations 20（已确认关联>0，平台核心价值项）、artifacts 15（当前修订挂有
   制品）、aliases 10、tags 10；每项 passed/detail/hint——未通过必须给可执行
   下一步；引导不阻断（不新增登记门槛，M59 强度不变）。②GET /assets/:assetId
   附 completeness：required 用 loadTypeChain+schemaToFormSpec（与表单同语义不
   可能分叉），补一条 confirmed in+out 关系计数查询；owner/制品取 head 修订。
   ③web 详情页完整度卡：分数按档着色（80+ 绿/50-79 黄/<50 红）+ 逐项 ✓/✗ +
   未通过项 hint。边界如实：目录列表不滚动计算分数（需逐行拉属性，代价大，
   记为后续候选）；owner 惯例键是约定不是 schema。tests/m65 三项：纯函数
   （全过 100/逐项失败扣对应分且 hint 可执行/owner 惯例键/required 缺失点名/
   权重算术自证）；API 端到端（两级链裸资产 55 分明细如实 → 补关系+别名 → 85
   引导闭环；required 并集跨两级链）。浏览器实测：M63 CLI Manual 详情 45 分
   （必填 25+关联 20；负责人/制品/别名/标签 ✗ 各带提示）。**顺带发现记入候选**：
   草稿保存未附文件时新修订制品为空（修订快照语义，制品按修订携带）——发布该
   修订会丢制品；继承还是替换需治理确认（替换语义下「移除制品」才可能）。
   截图：m65-ui-scorecard。全量 65 套件 320 项全绿。
   M66 已完成（批量候选轮，用户点名一次多候选：四项一次交付；调研笔记
   research-M66-batch-candidates.md）。①**制品继承语义**（M65 发现的丢制品脚枪，
   RFC 7386 merge-patch 口径）：branches 保存端点 artifacts 改 optional——缺省=
   复制 head 制品行（只改属性的草稿不再丢制品；属性不变时 contentDigest 与 head
   一致，幂等）；显式提供数组（含空数组）=整体替换（保留换文件/显式清空能力）；
   DraftPanel 未选文件时省略 artifacts 字段。顺带修三处 revision_artifacts.size
   bigint 字符串（M63 同款 bug 的余下位置：详情/修订端点/继承查询，SQL 补
   size::int）。②**bundle tagmanifest**（BagIt RFC 8493 tag 文件清单，补 M63 记录
   边界）：打包侧新增第三条目 tagmanifest-sha256.txt（manifest.json 与
   manifest-sha256.txt 两行摘要）；校验侧存在才核对（旧包兼容：缺省如实注记
   「manifest.json 完整性不在包内可证」）——manifest.json 元数据被改（checksum
   与制品交叉核对都发现不了的路径）由 tagmanifest 抓获，M63 边界闭合；CLI
   verify 输出补 tagmanifest 状态与注记。③**完整度目录汇总**：GET /assets/search
   行级附 completenessScore（与详情卡同一条 computeCompleteness 定义；required
   按类型链缓存；properties 计算后剥离不下发）；sort=completeness 升序低分优先
   （SQL 无法按 JS 分数排序——候选集 ≤200 内计算后 JS 排序截断，界面如实注记）；
   web 目录「完整度」列按档着色 + 排序选项。**顺带修 M65 遗留 bug**：详情端点
   completeness 误用未挂制品的原始 revisions[0]（应 revisionsWithArts[0]）——
   制品检查在详情侧恒 false（search 侧正确），M66 测试一致性断言暴露。④**引用
   导出**（Zenodo Cite/GitHub Cite this repository 锚点）：@taw/domain/cite
   buildCitation 纯函数（BibTeX @misc：key=taw_\<id前8位>、owner 缺失占位+note
   如实标注、花括号转义；Markdown 粗体行）；GET /assets/:id/cite?format=
   bibtex|markdown → 纯文本；详情页「BibTeX」按钮复制并计 copy_ref 热度。
   tests/m66 四项（①缺省继承/显式替换/显式清空/摘要幂等；②产物含 tagmanifest
   通过/manifest 元数据篡改由 tagmanifest 且仅由 tagmanifest 抓获/旧包兼容注记；
   ③search 与详情同分+低分优先；④BibTeX 字段齐全+owner 占位+Markdown+跨团队
   404+纯函数转义）。浏览器实测：目录完整度列+低分优先排序生效；详情 BibTeX
   按钮请求 200 且响应体字段齐全（无头浏览器剪贴板权限拒绝致按钮态不翻转——
   环境限制，与既有复制按钮同口径，网络证据坐实端点与接线）。截图：
   m66-ui-catalog-completeness、m66-ui-bibtex-detail。全量 66 套件 324 项全绿。
   M67 已完成（候选清偿轮，用户点名「一轮完成所有候选项」：M66 后七项候选一次
   交付；调研笔记 research-M67-all-candidates.md）。①**派生血缘字段物化**（HF
   base_model）：@taw/domain/lineage extractLineageRefs（base_model/baseModel/
   base_model_ref/derived_from 四惯例字段，string/数组、去空去重）+ 详情附
   lineageRefs + POST /assets/:id/lineage/materialize——名称精确（大小写不敏感）
   或别名精确命中才建 derivedFrom 断言（模糊不自动建边，误连血缘比少连更糟），
   建边走既有 createRelationAssertion（domain/range、禁环、重边防护复用）；
   linked/already/unresolved/self 四态逐项如实回报；无血缘字段 422。②**属性
   自定义筛选器**（OpenMetadata Explore）：@taw/domain/prop-filter parsePropFilters
   （key=value / key:value，同键后项覆盖，非法项收集点名）→ search?prop=…
   （可重复）`r.properties->>$k = $v` 全参数化等值过滤；目录筛选行输入框（空格
   分隔多项）随 M54 URL 化一并恢复/写回（?view=assets&prop=owner=alice）。
   ③**标签沿血缘传播写侧**（Atlas 分类传播+治理确认流）：planLabelPropagation
   纯函数（BFS 沿「基座→派生物」——derivedFrom 断言方向是源(派生物)→目标(基座)，
   传播方向相反，递归 CTE 取「以起点为基座」的全部派生链；环安全 visited；只
   传播源自身标签、中间节点新加标签不级联，保守语义如实文档）；GET 预览返回
   planDigest（sha256 稳定序列化），POST 必须 confirmPlanDigest（不符 409
   PROPAGATION_PLAN_CHANGED，同 C08 share-check 的 TOCTOU 口径）；执行落
   asset_labels（ON CONFLICT DO NOTHING）并递增 meta_version（元数据 ETag
   乐观并发不被静默绕过）。④**别名进 ⌘K**：search 行附 matched_alias（命中 q
   的第一个别名 lateral 子查询），⌘K 与 @ 引用候选副标题显示「别名 xxx」——
   搜别名时解释为何命中。⑤**集合只读分享快照**（Zenodo/HF snapshot 冻结语义）：
   迁移 0027 asset_collection_snapshots（payload jsonb 深拷贝、token 128-bit
   唯一、不可变——无 UPDATE/DELETE 授权、不设集合 FK——集合删除后快照保留）；
   POST /collections/:id/snapshots（管理权=创建者或管理员，分享是治理动作；
   >500 条 422）+ GET /share/collections/:token **免登录只读**——RLS 双策略：
   tenant_isolation（NULLIF 空串防御，同 0004 口径）+ public_share_read（仅当
   事务内 SET LOCAL app.share_read='on' 才可 SELECT，db.ts withShareRead 是唯一
   开启该 GUC 的代码路径，其余端点跨团队照常不可见）；公开响应不含 teamId/
   用户 id/制品内容（只有元数据+内容摘要）；web 集合详情「分享快照」按钮（确认
   弹窗）+ 快照链接列表 + /share/collection/:token 公开页（App 路由旁路登录）。
   ⑥**Agent 对话区可折叠**：AgentPane collapsed 属性——收起渲染 34px 细条（竖排
   AGENT tab + 运行中亮灯），组件保持挂载（SSE 订阅/输入状态不断线）；Workbench
   记 localStorage（taw-agent-collapsed-v1）并隐藏拖动分隔条。⑦**完整度团队
   水位**（TechInsights 汇总视图）：queryAssetRows/scoreAssetRows 抽共享管线
   （search 与 summary 同一条 SQL+打分，不可能分叉），GET /assets/completeness-
   summary → @taw/domain/completeness-summary summarizeCompleteness（count/平均/
   三档分桶（与详情卡同阈值）/低分清单 <60 升序最多 20 条带未过项标题；候选集
   ≤200 与 search 同界，超限如实注记）；目录页顶部水位卡 + 低分清单可点开直达
   补元数据。
   **顺带修两个真 bug**（全量跑暴露）：(a) 0027 租户策略漏了 0004 的 NULLIF
   空串防御——连接复用时事务结束后 app.team_id 回退为空串（非 NULL），::uuid
   抛 22P02；(b) **reply.send() 在 withTeam 事务回调内调用会先于 COMMIT 刷出
   响应**，紧随的请求竞态读不到刚提交的行——单跑绿、全量跑必现（事件循环繁忙
   使 COMMIT 排队更靠后），三处新写端点统一改为「事务内返回纯对象，COMMIT 后
   再 send」（同 meta-share 既有口径）。tests/m67 十一项（纯函数四：lineage
   提取/传播规划（BFS 多级+环+已覆盖）/prop 解析/汇总分桶；端到端七：物化大小写
   不敏感+already+unresolved+422+lineageRefs、别名命中物化、prop 过滤+交集+422
   点名、传播预览/错摘要 409/执行落库/二次无待传播、matched_alias、快照冻结+
   免登录+增删不影响+坏 token 404+外团队 404+不泄漏 teamId、汇总分桶合计/低分
   升序/裸资产带未过项）。浏览器实测（demo 团队）：目录水位卡（治理动作后平均
   40→45、低分清单 11→9）+ 属性筛选唯一定位（URL 带 prop 参数）；ChildNet 详情
   血缘卡物化（小写 base_model 命中大写 BaseNet ✅）；BaseNet 一键传播（确认
   弹窗列下游与新增标签→「已传播 1 项标签到 1 个下游资产」）；集合分享快照创建
   + /share/collection/:token 免登录公开页冻结渲染；对话区收起细条/展开恢复；
   ⌘K 搜 m67basenet 命中显示「别名 m67basenet」。截图：m67-ui-watermark、
   m67-ui-lineage-materialize、m67-ui-propagate、m67-ui-share-public、
   m67-ui-agent-collapsed、m67-ui-cmdk-alias。全量 67 套件 335 项全绿。
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无。已退役：「动态页导出定时快照」——需要作业调度基建的产品级决策
   （引入 worker/cron 属架构扩展，非迭代轮粒度），不再作为迭代候选。
   可选后续方向（M67 后）：候选清单已清偿（M66 后七项全部落地）。剩余方向：
   AI 草稿质量反馈环（仍需先攒真实使用样本，不伪造）；属性筛选的范围/正则算子、
   嵌套属性（等值先满足绝大多数治理筛选用，记为后续候选）；如继续迭代，建议
   再做用户走查/收集真实使用反馈，或由用户直接点名需求。
   M68 已完成（治理收口轮，M67 走查发现的三个「能力有了、治理出口没跟上」缺口；
   调研笔记 research-M68-governance-closeout.md）。①**分享快照吊销**（泄漏治理
   出口，GitHub PAT/Zenodo revoke 锚点）：迁移 0028 加 revoked_at/revoked_by 两列
   + **列级 UPDATE 授权**（GRANT UPDATE (revoked_at, revoked_by)——payload/token
   在 DB 层仍不可改，吊销是唯一被授权的更新路径）；POST /collections/:id/
   snapshots/:sid/revoke（管理权同创建；重复吊销幂等 alreadyRevoked 如实标注）；
   公开端点对已吊销 token 返回 **410 SHARE_REVOKED**（Gone 语义如实——持有者应
   知道链接被主动吊销而非 404 装不存在）；团队内清单标注 🚫 已吊销 + UI 吊销
   按钮（确认弹窗）；吊销后可再创建新快照（治理出口不是死路）。②**属性筛选
   算子扩展**（OpenMetadata 完整口径）：prop-filter 解析器支持 key>=v / key<=v
   数值范围与**点号嵌套路径**（metrics.accuracy → properties #>> 数组参数）；
   SQL 侧范围比较用 `CASE WHEN 文本 ~ 数值正则 THEN ::numeric ELSE NULL END`——
   非数值行被排除而不是 22P02 抛错；最早算符位置切分且两字符算符优先（>= 不会
   切成 > + =x，值含 = 字符按最早算符归值）；同键同算符才覆盖、同键不同算符
   各自保留；等值语义与 M67 完全兼容（m67 断言仅适配新 op 形状）。
   **顺带修一处真 bug**：Workbench URL 写回与请求拼接两处仍硬编码 `=`（M67 旧
   形状），op 被丢——浏览器走查抓到（URL 显示 score%3D0.9、结果集空），改为
   `${key}${op}${value}`。③**治理动作进团队动态**（audit_events 人机混排时间线，
   零新表）：血缘物化（asset.lineage_materialize，detail 逐引用结果）/标签传播
   （asset.labels_propagate，detail 下游数与标签数）/快照创建（collection.
   snapshot_create，detail token+条数）/快照吊销（collection.snapshot_revoke）
   四个动作在业务事务内写审计（团队级 project_id=NULL 同资产归档口径）；
   ACTION_LABELS 与 ⌘K 动态跳转名同步补条目（中文名从服务端下发，前端无副本）。
   tests/m68 五项（纯函数两：算子/嵌套/两字符优先/同键覆盖/非法点名、值含 =
   按最早算符归值；端到端三：范围+嵌套+非数值行排除+等值回归+组合交集+非数字
   422、吊销 200→410→清单标注→幂等→外团队 404→可再创建、动态四动作可查+中文名
   下发+action 过滤恰一条）。浏览器实测（demo 团队）：score>=0.9 唯一定位高分
   资产（URL 含 %3E%3D 算符、输入框回显）；集合快照吊销确认弹窗→列表 🚫 已
   吊销→公开页如实显示「该分享快照已被吊销」；动态页过滤下拉新增四动作、时间线
   第一条即刚才的吊销（人机混排实时闭环）。截图：m68-ui-prop-range、
   m68-ui-share-revoked、m68-ui-activity-governance。全量 68 套件 340 项全绿。
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无。已退役：「动态页导出定时快照」——需要作业调度基建的产品级决策
   （引入 worker/cron 属架构扩展，非迭代轮粒度），不再作为迭代候选。
   可选后续方向（M68 后）：AI 草稿质量反馈环（仍需真实使用样本，不伪造）；快照
   过期时间 expires_at（读取时比对可做、到期自动清理需调度基建）；属性筛选 OR
   组合/正则（需括号语法，等值+范围已覆盖治理主流）；如继续迭代，建议再做
   用户走查/收集真实使用反馈，或由用户直接点名需求。
   M69 已完成（日常取用轮，三项；调研笔记 research-M69-usage-efficiency.md）。
   ①**分享快照有效期**（GitHub PAT 过期锚点）：迁移 0029 加 expires_at（创建时
   可选 ISO；UI 按天数换算，默认 30 天、留空=永久）；公开端点读时比对
   `expires_at <= now()` → **410 SHARE_EXPIRED**（与吊销同为 Gone 但文案区分
   「过期」与「吊销」；同时命中吊销优先——更具体的管理动作）；不加定时清理
   （需调度基建，与已退役项同口径）；团队内清单 ⏰ 已过期/「xx 到期」徽标。
   ②**目录清单导出**（CKAN/Dataverse 数据清单口径）：GET /assets/export?format=
   csv|json——过滤参数与 search 完全同一套（q/type/label/lifecycle/typePrefix/
   prop/pinned/sort），走同一条 queryAssetRows/scoreAssetRows 管线（导出与目录
   不可能分叉）；CSV（RFC 4180 引号转义 + BOM + CRLF + attachment 文件名）列=
   名称/类型/版本/生命周期/关联数/近90天使用/别名数/标签数/是否含制品/完整度分/
   内容摘要/登记时间/是否收藏；JSON 结构化（teamId/exportedAt/truncated/total/
   note/items）；**属性明细不下发**（与目录同可见面，JSON note 如实注记；完整
   属性走 bundle）；上限 500 行，达到上限 CSV 尾行/JSON truncated 如实标注；
   导出是敏感可见动作：盖章 asset.export 审计（与 audit.export 同口径，detail
   记格式/条数/过滤范围），动作名进动态过滤与 ⌘K 跳转名；目录页「⬇ 导出
   CSV/JSON」按钮直连当前筛选。③**个人收藏 pin**（GitHub stars/HF likes 锚点）：
   user_asset_pins（迁移 0029；PK(team,user,asset)；资产删除级联；个人便利不是
   治理——不写审计/不进动态，与别名同口径）；POST/DELETE /assets/:id/pin；
   search 行级 pinned（当前用户视角）+ pinned=true 过滤；queryAssetRows 抽
   userId/pinnedOnly 参数（search/summary/export 三端点同源）；目录行 ☆/★
   切换（局部更新不整页刷新）+「★ 只看收藏」开关（URL pinned=1）+ 详情页
   收藏按钮（乐观切换失败回滚）；跨用户隔离：行级 pinned 按 auth.userId 计算，
   他人 pin 不可见。tests/m69 三项（①过期 410/未来 200 回显/永久 null/非法 422/
   吊销优先/清单过期态；②CSV BOM 用原始字节验证（fetch text() 会剥 BOM——
   走查发现）+表头+筛选行+JSON 结构化+边界注记+format 422+审计≥2+外团队 404；
   ③行级视角/只看收藏/跨用户隔离（第二名成员经 /teams/:id/members 加入——
   pin 视角互不混入）/幂等/详情 pinned/取消后为空）。浏览器实测（demo 团队）：
   目录 ☆→★、「只看收藏」唯一定位收藏资产（URL pinned=1）；导出端点 200 +
   text/csv + attachment 文件名 + 表头齐全 + pinned 过滤生效；快照创建 prompt
   输 7 天 → 列表「2026/10/8 到期」标注，过期 token 公开页如实「已过有效期」，
   到期/已过期/已吊销三态并存。截图：m69-ui-pins、m69-ui-share-expired、
   m69-ui-share-expiry。全量 69 套件 343 项全绿。
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无。已退役：「动态页导出定时快照」——需要作业调度基建的产品级决策
   （引入 worker/cron 属架构扩展，非迭代轮粒度），不再作为迭代候选。
   可选后续方向（M69 后）：AI 草稿质量反馈环（仍需真实使用样本，不伪造）；属性
   筛选 OR 组合/正则（需括号语法）；pin 的团队级聚合（「最多人收藏」排序——等
   真实使用积累，不预造指标）；如继续迭代，建议再做用户走查/收集真实使用反馈，
   或由用户直接点名需求。

   M70 已完成（资产弃用与继任治理 + SBOM 标准导出轮，两项；调研笔记
   research-M70-deprecation-sbom.md）。①**资产弃用与继任治理**（MLflow Model
   Registry Archived 阶段 / Docker Hub deprecated images / HF deprecated models
   + Dependabot deprecation alerts 锚点）：坐实真缺口——assets.lifecycle 的
   'deprecated' 枚举自基线 CHECK 约束就存在、前端备好「已弃用」徽标，但全链路
   不可达（无管理端点；queryAssetRows 的 CASE ELSE 'active' 把它当归档悄悄
   过滤；Agent 检索硬编码 ='active'；facets 与目录口径不一致）。迁移 0030 补
   deprecated_at/deprecated_by/deprecation_note/successor_asset_id（复合 FK 同
   团队）；POST /assets/:id/deprecate（note 必填 + successorRef 名称精确→别名
   精确解析；未解析 422/自身 409/归档态 409 ARCHIVED_STATE；重复弃用=幂等更新
   原因继任者，审计标 repeated）与 /undeprecate（清空回 active）；权限同归档
   （创建者或管理员）、meta_version 递增、图投影盖脏标记、send 事务外（M67
   教训）。**语义分层：弃用=目录仍可见（带警示）+ 取用不受阻 + 继任者指引 +
   可逆；归档=隐藏终态**——lifecycle 过滤 active（默认）改含 deprecated、新增
   deprecated 单看（search/summary/export 同源 parseLifecycle）；Agent
   asset.search/graph.assetsByType 返回 active+deprecated（lifecycle 如实标注、
   弃用排后），asset.getRevision 读弃用资产附 deprecation{warning,note,
   successor} 告警（Dependabot 式转述，不阻断）；顺带修通用 asset.search 不过
   滤归档不标 lifecycle 的缺口。UI：详情弃用横幅（日期/原因/继任者直达；继任者
   自身已弃用如实提示）+「弃用资产…/取消弃用」按钮 + 目录「仅已弃用」筛选
   （URL 化）+ 依赖告警文案区分已弃用（请查继任者）/已归档；审计
   asset.deprecate/asset.undeprecate 进动态过滤与 ⌘K 白名单（「看弃用记录」
   L1 句式）。②**SBOM 导出**（OWASP CycloneDX 1.5 锚点，1.5 新增
   machine-learning-model/data 组件类型与七类资产对位）：@taw/domain/sbom 纯
   函数 typeKeyToComponentType（七类映射、未识别回落如实保留原键）+ buildSbom
   （bom-ref 确定性 urn:taw:asset:{id}@r{seq}；dependsOn 只列闭包集内出边——
   截断如实收窄；空依赖显式区分「无/未知」；制品 sha-256 进 hashes；taw:*
   属性带类型/生命周期/修订摘要，弃用附 note/successor）；GET /assets/:id/
   sbom?depth=1..3（默认 1=直接依赖，方向固定 out 与 derivedFrom 断言方向一致）
   attachment RFC 5987 中文文件名；主体计 download 热度 + asset.sbom 审计盖章
   进动态与 ⌘K；详情页「导出 SBOM」直链。tests/m70 八项（纯函数三断言 + 端到端
   五：弃用治理全负例/目录三态可见性/取消弃用回滚/SBOM 结构热度审计外团队
   404/Agent 告警与不误报）；全量 70 套件 351 项全绿（环境注记：宿主重启致
   PG/graphdb 退出，重新拉起后零代码改动全绿）。浏览器实测（新注册团队走真实
   登记链路）：弃用双弹窗（原因+继任者）→ 横幅「请改用继任者」、继任者链接
   直达新引擎详情、新引擎依赖告警「上游已弃用，请查继任者」、SBOM 200
   CycloneDX 1.5+attachment 中文名+dependsOn 指向继任者+弃用属性、目录
   ?lifecycle=deprecated 唯一定位、默认视图两资产并标「已弃用」徽标、动态页
   下拉两新动作+时间线第一条即弃用。截图：m70-ui-deprecate-banner、
   m70-ui-catalog-deprecated-filter、m70-ui-activity-deprecate。
   暂缓项：无新增。可选后续方向（M70 后）：SPDX 第二输出格式（有真实消费方再
   加）；弃用影响面清单（Dependabot 式多下游聚合视图——等真实多下游场景）；
   版本级弃用（与通道回滚关系需先想清楚）；AI 草稿质量反馈环（同 M69 口径）。

### M71 本体关联轮（已完成）

用户点名：把资产管理与本体关联相结合（跨门类搜索/管理）+ 结合 Agent 方便操作 +
调研同类产品 + 功能丰富 + 漏洞修复 + 交互优化防抖动。调研（research-M71-
ontology-catalog.md，Palantir Foundry Ontology 文档本轮 WebFetch 实读；Atlas/
DataHub/Wikidata/OpenMetadata 公开文档既有知识）坐实核心差距：**类型层次（M8
subClassOf）存在但目录搜索 type 过滤是精确匹配——选父类搜不到子类资产**；Agent 只有
graph.assetsByType 有闭包语义，通用 asset.search 没有；Agent 完全没有「浏览本体本身」
的工具；属性筛选要求记忆键名。交付五项 + 三处真 bug：
①**目录类闭包展开**（Wikidata P279*/Foundry Interfaces 锚点）——apps/api ontology.ts
新增 typeKeyClosure（版本感知递归 CTE：根与子版本均须 active）；queryAssetRows type
过滤改闭包（search/export/summary 三端点同源自动一致）；行上 type_key 仍为各自实际
类型（展开如实可见），闭包键集经 /ontology/tree 呈现；未知类型空结果不静默放宽；
闭包×属性筛选同候选集取交集。@taw/graph fallback.sqlTypeClosure 对齐同一版本语义
（B3：此前递归段不看子版本状态）。
②**本体树端点 GET /ontology/tree**（Foundry Ontology Manager 锚点）——每 type_key
最新 active 版本：parentKey/资产计数/closureAssetCount（=目录闭包过滤真实命中数）/
模式声明属性键/必填键/requiresTestEvidence + 关系注册表（domain/range/断言数）；树
构建纯函数 @taw/domain/ontology-tree（层次+闭包计数+悬空父引用升根如实标注+环防御
+展平带 depth+relationsForClosure 空清单=该侧开放语义）。
③**Agent 本体工具**（Foundry AIP「Agent 第一入口是本体层」锚点）——ontology.types
（浏览门类树带闭包计数/属性键/必填键，q 过滤）+ ontology.typeInfo（类型链子→父全
级+必填并集+子类闭包+适用关系 asSource/asTarget+计数；幽灵类型如实报错引导）+
asset.search type 参数闭包对齐（与人类目录同一语义，不再精确匹配漏子类）。
④**属性键发现**（DataHub facet 由数据聚合锚点）——/assets/facets 附 propertyKeys
（head 修订 jsonb_object_keys 聚合 top50 带计数，非归档口径）；目录属性筛选输入框挂
datalist（跨门类公共键 owner/platform 可发现，不必记忆）。
⑤**目录防抖动（真 bug 修复）**——AssetList 此前每次筛选变化 setAssets(null) 整表
卸载闪「加载中…」重挂载、关键词每键击一次请求+一次 URL 写回（B2）；改 stale-while-
revalidate（旧结果保留、.list-wrap data-refreshing 半透明过渡、仅首次/切项目整块
加载态）+ 关键词/属性输入 300ms 防抖（即时回显延迟提交）。
**B1（M70 漏改真 bug）**：/ontology/assets-by-type 的 lifecycle 过滤仍是 M70 前旧
口径（CASE WHEN active 归档二值）——默认 active 视图把已弃用资产排除，与 M70 修正
过的目录/Agent 链路不一致；已对齐（active=active+deprecated，弃用排后）。
tests/m71 八项（纯函数三+端到端五）；全量 71 套件 359 项全绿（+8 零回归）。浏览器
实测（demo 三级层级 vehicle←sat←optical+旁支+弃用项）：层次下拉「vehicle（4，含
2 子类）／└ sat（3，含 1 子类）／└ optical（1）」、选父类提示行列子类与命中数+4
行跨类型命中+URL 写回、本体页闭包检索卡（图同步后）4 项含弃用行排最后（B1 修复前
被排除）、防抖动实测 5 键击仅 1 次 search 请求表格全程在位零闪断、datalist 四键带
计数、闭包×owner=Bob 唯一命中。截图三张：m71-ui-closure-catalog、
m71-ui-closure-prop-filter、m71-ui-ontology-closure-deprecated。环境注记：走查发现
4000/5175 被上一会话孤儿进程占用致浏览器打到旧代码，杀进程重启后全过。
暂缓项：无新增。可选后续方向（M71 后）：类型多继承/接口类型（Foundry Interfaces
全量——需 schema 级改造）；独立业务术语表（labels 已覆盖轻量场景）；全文/向量语义
检索（需搜索引擎基建）；观测属性键进 Agent 工具（ontology.* 已带模式声明键）。
