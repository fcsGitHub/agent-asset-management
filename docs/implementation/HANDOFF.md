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
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无。已退役：「动态页导出定时快照」——需要作业调度基建的产品级决策
   （引入 worker/cron 属架构扩展，非迭代轮粒度），不再作为迭代候选。
   可选后续方向（M60 后，按性价比排序）：自然语言生成 schema（对 Agent/⌘K 说
   「我要一个 XX 类型」→ LLM 意图产出草稿 schema 进表单模式，人工确认后登记——
   LLM 只产草稿不落库，权限语义与 NL 命令栏一致）；schema 约束的前端预填（登记
   表单按 min/max/pattern 输入前提示）；bundle 离线校验/回导工具；门禁类型 UI
   提示前移；调研吸收清单余项不变：派生血缘字段（HF base_model）、owner/
   lifecycle 必填引导与完整度 scorecard（Backstage）、属性自定义筛选器
   （OpenMetadata）、分类沿血缘传播写侧（Atlas，需治理确认流）、引用导出
   BibTeX/Markdown（Zenodo）、别名进 ⌘K、集合只读分享快照、Agent 对话区可折叠。
   暂缓项：无。如继续迭代，建议再做用户走查/收集真实使用反馈，或由用户直接
   点名需求。
