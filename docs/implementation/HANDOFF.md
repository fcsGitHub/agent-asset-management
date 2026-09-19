# HANDOFF — 交接

更新时间：2026-09-20（M0–M5 终稿）

## 仓库状态

- 路径：D:\project\agent-asset-management（Windows，Git Bash）
- 分支：main（本仓库为本次目标新建；无用户历史修改，初始文档已保留）
- 工作区：最终提交后干净（keys.txt/.env/data/backups 均在 .gitignore）

## 已完成（详见 PLAN/ACCEPTANCE/EVIDENCE）

- M0–M5 全部里程碑；42 项验收：39 通过 / 2 进行中（C07 ETag 头、C08 显式分享链接）/
  1 明确不适用（E06 离线+ARM64 未验证，如实标记）
- 测试：7 套件 59 项全部通过（真实 PostgreSQL、真实 HTTP、真实 DeepSeek、真实 semantica）
- 演练：M1 重启持久化（docker restart）、E03 备份恢复到新容器、E05 性能（≥1 万资产规模）
- 文档：README（真实执行过的命令）、docs/ops/{ADMIN,BACKUP,CONFIG}.md
- 安全基线：RLS + 受限应用角色、作者分离、审核快照失效、幂等发布、工具分级、
  密钥不出服务端、CSRF、路径穿越/越权负例

## 未完成 / 遗留（8 项，见 ACCEPTANCE.md 遗留清单）

归档端点、本体迁移预演、preview UI、ETag 头、分享链接、kill -9 崩溃注入、
全新宿主机冷启动重放、并发压测。均为补强项，不阻塞 42 项验收的当前判定。

## 风险

- 性能结论为单用户延迟口径（本机 Docker），并发容量未测。
- E06：离线/ARM64 无验证环境，交付物不做此声称。
- Pi（@earendil-works/pi-*）以统一 LLM 层路径适配（ADR-0003），已核实包存在（0.85.1）
  但未打包集成；当前 Agent 经 OpenAI 兼容协议直连 DeepSeek，接口契约一致。

## 恢复入口（新会话从这里开始）

1. 读 docs/implementation/ACCEPTANCE.md（42 项状态）与本文件
2. `docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
3. `npx tsx apps/api/src/server.ts` + `cd apps/web && npx vite --port 5175`
4. `npx vitest run` 确认 59 项基线仍绿
5. 从"遗留清单"取任务，或响应用户新指令
