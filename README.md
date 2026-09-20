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
| M10 图谱与写类意图 | NL 写类意图 create_issue（解析零副作用+界面预览-确认双重门）、关系图谱页（本地力导向布局、类型着色、拖拽/点击联动、过滤）、本体导出 Turtle 序列化（确定性输出）、总览「最近问题」卡片 | EV-032，tests/m10-* |
| M11 活动流实时化 | 活动流 SSE 实时推送（Postgres 触发器 pg_notify 提交时投递 → 单例 LISTEN 扇出，事件与列表同源、Agent 状态原地更新、团队隔离）、实时连接状态徽标、图谱页本体导出下载（Turtle/JSON） | EV-033，tests/m11-* |
| M12 运行流实时化 | 运行事件流迁移 NOTIFY（去 400ms 轮询，线格式/续传不变、前端零改动）、终态先事件后状态时序不变量、取消健壮性修复（cancel_requested 每轮兜底 + 两轮间取消误标修正）、图谱聚焦模式 | EV-034，tests/m12-* |
| M13 本体治理台 | 本体治理页（类层次树、关系类型表+断言计数、管理员登记类型/关系类型、双迁移预演、导出 Turtle/JSON）、图谱聚焦多跳展开、修复 .primary 白底白字按钮缺陷 | EV-035，tests/m13-* |
| M14 语义候选工作台 | 工作区「语义候选」标签：真实抽取（规则+LLM 增强）→ 候选端点自动映射资产 → 人工确认断言为正式关系（domain/range/成环服务端强制执行）→ 图谱联动；后端零改动 | EV-036，tests/m14-* |
| M15 候选审核队列 | 候选持久化（0020，RLS+状态机）、关系断言核心重构为共享函数、入队/队列/确认/忽略四端点（确认原子、违规保持 pending）、跨成员待审核队列界面 | EV-037，tests/m15-* |
| M16 活动流项目过滤 | 审计事件补 project_id（发布类动作真实盖章、团队级动作 NULL 的明确语义）、/activity 与 SSE 流 projectId 过滤、动态页项目过滤选择器 | EV-038，tests/m16-* |
| M17 Agent 提案审核 | GET /projects/:id/proposals + POST /proposals/:id/review（状态机+jsonb 审核回执）、工作区「Agent 提案」标签（结构化展示/筛选/接受与忽略/登记类提案预填登记表单） | EV-039，tests/m17-* |
| M18 候选队列批审与详情 | 批量确认/忽略（SAVEPOINT 逐条隔离、逐条如实回执）、候选详情（决策留痕+断言去向）、队列批选与详情展开 UI、本体页受控单位词表（worker 同源暴露） | EV-040，tests/m18-* |

当前测试基线：25 套件 136 项全部通过。

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
