# HANDOFF — 交接

更新时间：2026-09-20

## 仓库状态

- 路径：D:\project\agent-asset-management（Windows，Git Bash）
- 分支：main（本仓库为新建 git 仓库；此前无任何历史，无用户未提交修改可保护——初始内容仅 keys.txt 与两份设计/目标文档，均已保留）
- 注：keys.txt 含真实 API key，已加入 .gitignore，不入库。

## 已完成

- 完整读取 team_asset_design.html（29 章）与 team_asset_goal.md，提取 42 项验收项入台账
- 环境盘点（Node24/Python3.11/Docker/PG16 容器），证据见 EVIDENCE.md EV-001~004
- git 仓库初始化、.gitignore/.env.example、npm workspaces 单体仓库
- docker-compose PostgreSQL（5437）+ 自研迁移 runner + 0001 基线迁移已真实执行

## 未完成

- M1 及全部业务功能（见 PLAN.md、CAPABILITY_MATRIX.md）
- 42 项验收全部"未开始"

## 风险

- Windows 宿主开发：目标设计以 Linux 服务端为主；开发期用 Docker 化 PG，部署/离线/ARM64 验证受限（E06 预计部分标记未验证）
- Pi/Semantica 上游 API 细节需按锁定版本写契约测试，不能凭名称猜方法

## 恢复入口

1. 读 docs/implementation/PLAN.md（当前下一步）
2. 读 docs/implementation/ACCEPTANCE.md + HANDOFF.md
3. `docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
4. 继续 PLAN.md"当前下一步"清单
