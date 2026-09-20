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
4. `npx vitest run` 确认 105 项基线仍绿
5. M9 已完成：NL 命令解析（真实 DeepSeek，⌘K 自然语言模式）、语义候选抽取 LLM 增强、
   测试诚实化清零 80 处空断言并修复 4 个被掩盖的产品缺陷（EV-029~031）。
   M10 已完成：NL 写类意图 create_issue（解析零副作用 + 界面预览-确认双重门）、
   关系图谱页（本地力导向布局，g+m）、本体导出 Turtle 序列化（确定性）、
   总览「最近问题」卡片（EV-032）。
   下一步候选：活动流按项目过滤与 SSE 推送、worker 多播订阅、NL 意图再扩展
   （如登记资产草稿直通）、图谱按项目/类型子图聚焦、Turtle 导出接入界面下载按钮。
