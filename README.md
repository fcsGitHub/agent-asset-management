# 工作集 · Team Asset Workspace

小型团队（5–30 人）自托管的 LLM Agent 资产协同管理软件：文档、软件、仿真模型、仿真引擎、
测试库、Agent 库、场景七类资产统一身份与不可变修订；成员提出变更，管理员审核发布；
项目从需求受理走到结题，全程可追溯。

设计基线：`team_asset_design.html`（29 章）+ `team_asset_goal.md`（目标正文）。
实施台账：`docs/implementation/`（PLAN / CAPABILITY_MATRIX / ACCEPTANCE / EVIDENCE / HANDOFF）。

## 当前状态（2026-09-20）

M0–M5 里程碑已按目标正文完成并通过真实测试（非 mock）：

| 里程碑 | 交付 | 证据 |
| --- | --- | --- |
| M0 仓库与环境基线 | 迁移链、台账、ADR | EV-001~007 |
| M1 资产目录骨架 | 登录/团队/项目/Session、文件库、七类资产、关系、两区工作台 | EV-008~010，tests/m1-flow |
| M2 变更与发布 | 分支、CR、审核快照、管理员发布事务、回退、精确绑定 | EV-011，tests/m2-release |
| M3 项目全过程 | 需求基线、任务、测试运行、追踪矩阵、阶段门、结题包 | EV-012，tests/m3-lifecycle |
| M4 真实 Agent | DeepSeek 真实调用、工具网关、SSE 续接、预算/取消/对账 | EV-013，tests/m4-agent |
| M5 语义与硬化 | semantica 语义 worker、备份恢复演练、安全负例、性能 | EV-014~016，tests/m5-* |

42 项验收的状态与证据逐项见 `docs/implementation/ACCEPTANCE.md`。

**M6–M8 迭代轮补强（同样真实测试，EV-019~028）**：

| 轮次 | 交付 | 证据 |
| --- | --- | --- |
| M6 加固 | 归档/恢复、本体迁移预演、并发竞态复验、kill -9 中段事务崩溃注入、冷启动引导、并发压测 | EV-019~023，tests/m6-* |
| M7 运行时 | outbox 真实派发 worker（租约/至少一次/退避）、Agent 区接真实运行（SSE 工具事件+取消+历史）、头修订索引与修订分页 | EV-024~026，tests/m6-worker、m7-api |
| M8 本体与项目域 | 类型层次（subClassOf 收窄继承）、关系 domain/range 强制执行与成环禁止、本体质量门、双迁移预演、本体导出（taw-ontology/1）、项目总览仪表盘、团队动态（审计+Agent 人机混排）、审批队列、⌘K 命令栏、快捷键单一真源、统一空状态 | EV-027~028，tests/m8-* |
| M9 真实 LLM 深化 | ⌘K 自然语言命令（规则 L1 + 真实 DeepSeek L2 解析，白名单意图+溯源+诚实回退）、语义候选抽取 LLM 增强（词表约束+端点原文可定位+无 key 诚实降级）、同名冲突检测修复、测试诚实化（清零 80 处空断言并修复 4 个被掩盖的产品缺陷） | EV-029~031，tests/m9-* |

当前测试基线：16 套件 98 项全部通过。

## 环境要求

- Node ≥ 22（开发使用 v24.11.1）、npm 11
- Docker（Linux 容器）+ `pgvector/pgvector:pg16` 镜像
- Python 3.11 + `services/semantic-worker/requirements.txt`（可选：语义增强关闭不影响核心流程）
- DeepSeek API key（可选：Agent 功能需要；其余功能不需要）

## 启动（以下命令均在本仓库实际执行过）

```bash
# 1) 安装依赖（lockfile 固定版本）
npm install

# 2) 配置环境变量（key 不入库；.env 已在 .gitignore）
cp .env.example .env
#   编辑 .env：DEEPSEEK_API_KEY=你的 key；其余开发默认值可直接用

# 3) 启动 PostgreSQL（端口 5437，数据在 docker 卷 taw_pgdata）
docker compose up -d postgres

# 4) 数据库迁移（0001–0013，幂等）
npx tsx scripts/migrate.ts --role=admin

# 5) 启动后端 API（127.0.0.1:4000）
npx tsx apps/api/src/server.ts

# 6) 启动前端（Vite，127.0.0.1:5175，/api 代理到 4000）
cd apps/web && npx vite --port 5175

# 7)（可选）启动语义 worker（127.0.0.1:8100；需要 .venv）
python -m venv .venv-sema
.venv-sema/Scripts/pip install -r services/semantic-worker/requirements.txt   # Linux: .venv-sema/bin/pip
.venv-sema/Scripts/python services/semantic-worker/main.py
```

浏览器打开 http://localhost:5175 注册团队（首个成员为管理员）即可使用。

## 测试与验证

```bash
npx tsc -b tsconfig.json          # 类型检查（TS strict）
npx vitest run                    # 全量集成测试（62 项，需 PostgreSQL 运行中）
npm run smoke:llm                 # DeepSeek 真实连通冒烟（消耗少量 token）
npx tsx scripts/e2e-m1.ts         # M1 端到端 + docker 重启持久化演练
npx tsx scripts/e2e-m5-restore.ts # E03 备份恢复演练（pg_dump → 新容器 → 验证）
npx tsx scripts/perf.ts           # E05 性能测量（生成 5k/50k/100k 夹具）
npx tsx scripts/perf-concurrent.ts # M6 并发负载（读/写/混合三阶段，真实并发）
npx tsx scripts/e2e-m6-crash.ts   # M6 韧性演练（kill -9 中段事务崩溃注入 + 冷启动引导）
```

> tests/m4-agent.test.ts 会发起真实 DeepSeek 调用（8 次运行 × 数次工具调用），
> 仅消耗少量额度；无 key 时该套件失败属预期（运行创建会明确拒绝并返回 503，不用 mock 充数）。

## 目录结构

```
apps/api/            Fastify API（认证、领域路由、Agent 运行器、SSE）
apps/web/            React + Vite 两区工作台
packages/domain/     类型定义默认值、JSON Schema 校验、摘要规范化、差异
packages/storage/    本地内容寻址 BlobStore（<root>/<teamId>/<sha256>）
packages/agent-adapter/  DeepSeek Provider（OpenAI 兼容）+ env 加载
services/semantic-worker/  Python 语义服务（真实 semantica 0.6.8 适配）
migrations/          0001–0013 SQL 迁移（含 RLS 与受限应用角色）
scripts/             迁移、冒烟、端到端、恢复演练、性能
tests/               62 项 vitest 集成测试（真实 PG/HTTP/LLM）
docs/implementation/ 计划、能力矩阵、验收台账、证据、交接
docs/ops/            管理员手册、备份恢复手册、配置说明
```

## 安全边界摘要（详见设计文档与 ADR）

- 修订不可变：应用角色 `taw_app` 对 `asset_revisions` 只有 SELECT/INSERT；
  RLS 以事务内 `app.team_id` 隔离租户（NULLIF 容错空串）。
- 发布是单一人类动作 `review-and-publish`：服务端校验管理员身份、作者分离、
  review digest 匹配、固定顺序锁后单事务落库；Agent 工具清单中不存在该动作。
- 幂等：发布支持 Idempotency-Key；重复回调不重复发布。
- 秘密只从服务端环境读取；不在 Prompt、日志、导出中出现（tests/m5-security 覆盖）。

## 许可证

- 本仓库代码：MIT
- 关键上游：`@earendil-works/pi-*`（MIT，未打包使用，适配路径见 ADR-0003）、
  semantica 0.6.8（MIT，services/semantic-worker 实际依赖）、
  fastify/pg/react/vite 等 npm 依赖见 package-lock.json。
- DeepSeek API 为商业服务，账号与额度由部署方自行管理。
