# HANDOFF — 交接

更新时间：2026-09-20（M6–M8 迭代轮后）

## 仓库状态

- 路径：D:\project\agent-asset-management（Windows，Git Bash）
- 分支：main（本仓库为本次目标新建；无用户历史修改，初始文档已保留）
- 工作区：最终提交后干净（keys.txt/.env/data/backups 均在 .gitignore）

## 已完成（详见 PLAN/ACCEPTANCE/EVIDENCE）

- M0–M5 全部里程碑；42 项验收：40 通过 / 1 明确不适用（E06 离线+ARM64 未验证，
  属环境外部限制，如实标记不做声称）
- 测试：16 套件 98 项全部通过（真实 PostgreSQL、真实 HTTP、真实 DeepSeek、真实 semantica；无任何 mock；
  全部断言经审计为真实生效，无空断言）
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
- E06：离线/ARM64 无验证环境，交付物不做此声称。
- Pi（@earendil-works/pi-*）以统一 LLM 层路径适配（ADR-0003），已核实包存在（0.85.1）
  但未打包集成；当前 Agent 经 OpenAI 兼容协议直连 DeepSeek，接口契约一致。

## 恢复入口（新会话从这里开始）

1. 读 docs/implementation/ACCEPTANCE.md（42 项状态）与本文件
2. `docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
3. `npx tsx apps/api/src/server.ts` + `cd apps/web && npx vite --port 5175`
   （可选）outbox 派发：设 OUTBOX_DISPATCH_URL 后 `npm run dev:worker`
4. `npx vitest run` 确认 157 项基线仍绿
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
   候选约定（自 M25 起）：老化优先——连续落选项自动升为下轮必做；汇报只列新增候选
   与暂缓项，不复读全量清单。
   暂缓项：无（M26 清零）。可选后续方向：审计条目原文详情查看、动态页导出计划
   任务（定时快照）、语义队列导出。
