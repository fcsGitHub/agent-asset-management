# CAPABILITY MATRIX — 能力矩阵（终稿：2026-09-20）

要求 → 实现 → 代码位置。遗留补强项见 ACCEPTANCE.md。

## 基础设施

| 要求 | 实现 | 位置 |
| --- | --- | --- |
| 真实 PostgreSQL + RLS + 受限应用角色 | docker pgvector:pg16；taw_app 无 DDL/非 owner；事务级 app.team_id（NULLIF 容错） | docker-compose.yml, migrations/0002/0004, apps/api/src/db.ts |
| 内容寻址 BlobStore | `<root>/<teamId>/<sha256>`，同盘 rename，去重，200MB 限制 | packages/storage/src/local-cas.ts, apps/api/src/routes/uploads.ts |
| 持久作业 + outbox | outbox 表 + 事件（ReleasePublished/RolledBack），恢复验证不重复 | migrations/0005, apps/worker（worker 进程骨架） |
| 类型检查/测试 | TS strict + vitest 7 套件 59 项（真实 PG/HTTP/LLM/semantica） | tests/ |

## 领域能力

| 能力 | 实现 | 位置 |
| --- | --- | --- |
| 身份/团队/项目/Session + 登录会话 | scrypt + 服务端会话 + CSRF 双提交 | apps/api/src/auth.ts, routes/auth.ts, routes/projects.ts |
| 七类资产 + 类型定义 + 新类型注册 | asset_type_versions 版本并存 + JSON Schema/词表校验 | packages/domain/src/defaults.ts, validate.ts, routes/catalog.ts |
| 更新与入库全路径 schema 强制（M59，OpenMetadata 数据契约思想） | 登记与分支草稿保存共用同一类型链关卡（apps/api/src/ontology.ts）；prepare-review 复核候选（清存量欠账）；dry-run 端点 /assets/validate | apps/api/src/ontology.ts, routes/branches.ts, releases.ts, catalog.ts |
| Schema 便捷生成（M60，quicktype/unanimity 惯例） | 表单属性行构建 + 样例推断（枚举不机械推断）双通道生成 JSON Schema；三模式表单；生成物仍走全部质量门 | @taw/domain/schema-builder, routes/catalog.ts（/types/infer-schema）, components/OntologyPage.tsx |
| 自然语言生成 schema 草稿（M61） | 真实 DeepSeek 严格 JSON → zod strict 白名单四层防线 → 属性行草稿回填表单；零写入，key 未配置 503 如实降级 | routes/catalog.ts（/types/describe-schema、SchemaDraft）, OntologyPage.tsx |
| 不可变修订 + 分支 + 差异 | DB 权限拒绝覆盖；branch_entries base→head；文本/属性/关系/二进制 diff | migrations/0002/0007, routes/branches.ts, packages/domain/src/diff.ts |
| 关系 + 候选分离 | relation_assertions（confirmed）与语义候选（candidate/proposed）分离 | routes/catalog.ts, routes/semantic.ts, services/semantic-worker |
| Issue/CR/审核发布/回退/绑定 | 审核快照 candidate/review digest；固定顺序锁；单事务发布；幂等键 | routes/releases.ts, migrations/0005/0006 |
| 发布测试门禁（M58，GitHub required checks 思想） | 类型层声明 requires_test_evidence；候选精确修订最新一次测试运行须 pass；prepare 冻结+publish 现场重算双保险 | migrations/0026, @taw/domain/bundle（checkTestGate）, routes/releases.ts |
| 批量关联下载（M58，HF snapshot + BagIt/Frictionless 思想） | 关系闭包/策展集合一次请求 store-only ZIP（manifest.json + manifest-sha256.txt + 制品原文）；路径安全化与重名消解；包内资产计 download 热度 | @taw/domain/bundle, routes/bundles.ts |
| 项目闭环 | 需求不可变修订+基线、任务交付物、测试运行、追踪矩阵、阶段门、结题包 | routes/lifecycle.ts |
| Agent 真实调用 + 工具网关 | DeepSeek Provider（OpenAI 兼容）；读/草稿/人类专属三级；调用全记录 | packages/agent-adapter, apps/api/src/agent/{tools,runner}.ts |
| SSE 续接/预算/取消/对账 | run_events 落库后推送；Last-Event-ID 重放；AbortController；unknown_reconcile | routes/runs.ts, agent/runner.ts |
| 语义增强（可降级） | semantica 0.6.8 worker：中文抽取/冲突/来源；断连 503 明确降级 | services/semantic-worker/main.py, routes/semantic.ts |
| 审计 | audit_events 只追加（应用角色无 UPDATE/DELETE） | migrations/0005 |

## 界面

| 要求 | 实现 | 位置 |
| --- | --- | --- |
| 两区工作台（Agent 区+工作区，可拖动宽度由 CSS 38/62 基线） | React 布局；窄屏 对话/工作区 切换条 | apps/web/src/pages/Workbench.tsx, styles.css |
| 导航抽屉（项目 → Session，可收起） | 抽屉组件 + 建项目/建会话 | 同上 |
| 空态/加载/失败/无权 | 各视图 state/error 分支 | 同上 |
| 不依赖 LLM 的直接操作 | 上传/登记/检索/审核全部为普通表单与按钮 | 全链路（Agent 仅增强） |
