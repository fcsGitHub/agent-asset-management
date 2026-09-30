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
| Schema 驱动登记表单（M62，rjsf/JSON Forms 思想） | 类型链→字段规格（字段=链并集、required=并集、约束=各环交集、词表下拉、继承标注）；表单值类型化换算；本地预检拦截，服务端 ajv 仍权威 | @taw/domain/schema-form, apps/web/src/pages/Workbench.tsx（AssetRegister） |
| Schema 表单贯穿草稿编辑 + 门禁提示前移（M64） | 登记与修改共用同一套 SchemaForm（链重建/部件/预检）；草稿双模式（表单预填+额外属性区 / JSON）互转保真，预检按补丁语义合并视图查；需测试证据类型在登记/草稿即提示 | apps/web/src/components/SchemaForm.tsx, Workbench.tsx（DraftPanel）, @taw/domain/schema-form（propertiesToFormValues/chainRequiresTestEvidence） |
| 元数据完整度 scorecard（M65，Backstage TechInsights 思想） | 六项加权检查（链必填/负责人/关联/制品/别名/标签）→ 0-100 分 + 可执行提示；读侧引导不阻断；required 与登记表单同一链合并语义 | @taw/domain/completeness, routes/catalog.ts（详情附 completeness）, Workbench.tsx（CompletenessCard） |
| 批量候选（M66）：制品继承 / tagmanifest / 完整度汇总 / 引用导出 | 草稿 artifacts 缺省=沿用 head、显式=替换（RFC 7386 口径）；bundle 附 tagmanifest-sha256.txt（描述符篡改包内可证，旧包兼容）；search 行级 completenessScore + 低分优先排序；BibTeX/Markdown 引用导出端点与按钮 | routes/branches.ts, bundles.ts, @taw/domain/{bundle-verify,cite}, catalog.ts（search/cite）, Workbench.tsx |
| 不可变修订 + 分支 + 差异 | DB 权限拒绝覆盖；branch_entries base→head；文本/属性/关系/二进制 diff | migrations/0002/0007, routes/branches.ts, packages/domain/src/diff.ts |
| 关系 + 候选分离 | relation_assertions（confirmed）与语义候选（candidate/proposed）分离 | routes/catalog.ts, routes/semantic.ts, services/semantic-worker |
| Issue/CR/审核发布/回退/绑定 | 审核快照 candidate/review digest；固定顺序锁；单事务发布；幂等键 | routes/releases.ts, migrations/0005/0006 |
| 发布测试门禁（M58，GitHub required checks 思想） | 类型层声明 requires_test_evidence；候选精确修订最新一次测试运行须 pass；prepare 冻结+publish 现场重算双保险 | migrations/0026, @taw/domain/bundle（checkTestGate）, routes/releases.ts |
| 批量关联下载（M58，HF snapshot + BagIt/Frictionless 思想） | 关系闭包/策展集合一次请求 store-only ZIP（manifest.json + manifest-sha256.txt + 制品原文）；路径安全化与重名消解；包内资产计 download 热度 | @taw/domain/bundle, routes/bundles.ts |
| Bundle 离线校验与回导（M63，BagIt verify 口径 + CAS 再入库） | verify：complete/valid 分离 + manifest 交叉核对，零网络；import：先校验后走公开 API（同 M59 关卡无旁路），类型精确解析缺失如实跳过，--dry-run 零写入 | @taw/domain/bundle-verify, scripts/bundle-tools.ts |
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
