# HANDOFF — 交接

更新时间：2026-09-22（M31 实测走查轮后）

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
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无。已退役：「动态页导出定时快照」——需要作业调度基建的产品级决策
   （引入 worker/cron 属架构扩展，非迭代轮粒度），不再作为迭代候选。
   可选后续方向：暂无积压；M31 走查轮即"从实际使用反馈收集需求"的第一次落地，
   如继续迭代，建议再做用户走查/收集真实使用反馈，或由用户直接点名需求。
