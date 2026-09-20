# EVIDENCE — 证据台账

每条证据记录：日期、命令、环境、退出码、关键输出/报告路径。只记录真实执行过的命令。

## 环境

| 项 | 值 | 核实命令 |
| --- | --- | --- |
| OS | Windows 10.0.26200 x64（win32，Git Bash） | 系统信息 |
| Node | v24.11.1 | `node --version` |
| npm | 11.6.2 | `npm --version` |
| Python | 3.11.5（miniconda） | `python --version` |
| Git | 2.49.0.windows.1 | `git --version` |
| Docker | 29.2.1，Linux 容器 | `docker info` |
| PostgreSQL | pgvector/pgvector:pg16 容器（taw-postgres，127.0.0.1:5437） | `docker ps` |

## 证据条目

### EV-001 ｜ 2026-09-20 ｜ 环境盘点
- 命令：`node --version; npm --version; python --version; git --version; docker info --format '{{.ServerVersion}} {{.OSType}} {{.Architecture}}'`
- 退出码：0
- 结果：Node v24.11.1 / npm 11.6.2 / Python 3.11.5 / git 2.49.0 / Docker 29.2.1 linux x86_64

### EV-002 ｜ 2026-09-20 ｜ 上游包存在性核实
- 命令：`npm view @earendil-works/pi-ai version` 及 pi-agent-core / pi-coding-agent
- 退出码：0
- 结果：三者均 0.85.1（MIT，earendil-works/pi 官方包）
- 命令：`pip index versions semantica`
- 退出码：0
- 结果：semantica 0.6.8（最新），历史版本自 0.0.5 起

### EV-003 ｜ 2026-09-20 ｜ PostgreSQL 启动 + 首个迁移
- 命令：`docker compose up -d postgres` → `npx tsx scripts/migrate.ts --role=admin`
- 退出码：0
- 输出：`applying 0001_baseline.sql ... ok` / `migrations complete: 1 applied, 1 total`
- 环境：taw-postgres（pgvector:pg16），DATABASE_ADMIN_URL=postgres://taw_admin:***@127.0.0.1:5437/taw

### EV-004 ｜ 2026-09-20 ｜ 依赖安装与 lockfile 固定
- 命令：`npm install fastify@5 @fastify/cookie@11 @fastify/cors@10 @fastify/multipart@9 pg@8 zod@4 react@19 react-dom@19 react-router-dom@7 vite@7 @vitejs/plugin-react@5 @types/react@19 @types/react-dom@19 typescript tsx vitest`
- 退出码：0
- 结果：package-lock.json 生成，依赖版本锁定

### EV-005 ｜ 2026-09-20 ｜ DeepSeek API 连通性（真实调用）
- 命令：`npm run smoke:llm`（scripts/smoke-llm.ts）
- 退出码：0
- 输出：`{"ok":true,"http":200,"latencyMs":342,"model":"deepseek-flash","contentSample":"{\"ok\": true}","totalTokens":34}`
- 环境：https://api.deepseek.com 官方端点；key 从 .env 读取（未入库、未打印）

### EV-006 ｜ 2026-09-20 ｜ 类型检查基线
- 命令：`npx tsc -b tsconfig.json`
- 退出码：0
- 范围：packages/{contracts,storage,domain,agent-adapter}、apps/{api,worker}（TS strict）

### EV-007 ｜ 2026-09-20 ｜ 单元测试基线
- 命令：`npx vitest run tests/baseline.test.ts`
- 退出码：0
- 结果：3 passed（七类类型常量、API 前缀契约、healthz 注入测试）

## M0 结论

出口条件核对（设计 25 章）：可运行基线 ✅（PG 容器 + 迁移 + API healthz + 测试）；真实能力清单 ✅（CAPABILITY_MATRIX.md）；锁定上游版本与许可证记录 ✅（PLAN.md 依赖节 + EV-002；Pi 系 MIT；Semantica 许可证接入时按锁定版本复核）。

### EV-008 ｜ 2026-09-20 ｜ M1 集成测试（真实 PostgreSQL + 真实 HTTP）
- 命令：`npx vitest run`（tests/m1-flow.test.ts + baseline）
- 退出码：0
- 结果：19 passed / 0 failed
- 覆盖：三用户注册、管理员加成员、401/CSRF 负例、项目+Session、七类类型播种、
  真实文件上传与摘要、七类资产登记、非法属性 422（A03）、关系正反向（A04）、
  跨团队关系拒绝（A08）、外人 404 不泄露存在性、RLS 无上下文不可见/写入拒绝、
  B01 应用角色对修订无 UPDATE/DELETE（DB 层）、blob 去重幂等

### EV-009 ｜ 2026-09-20 ｜ M1 端到端（含真实容器重启）
- 命令：`npx tsx scripts/e2e-m1.ts`
- 退出码：0
- 报告：docs/evidence/m1-e2e-report.json
- 关键步骤：两用户注册→加团队→项目/Session→上传→三类资产登记→
  `docker restart taw-postgres`→同一账号重读：项目/Session/资产/摘要/blob 全部保留

### EV-010 ｜ 2026-09-20 ｜ 浏览器端到端（Playwright MCP，真实服务）
- 步骤：注册团队（UI）→建项目（orbit-ui）→建会话→登记资产表单（类型动态属性+
  枚举下拉）→上传真实文件→目录出现资产→详情（修订摘要/关系）→发送会话消息并持久化
- 截图：docs/evidence/m1-desktop-workbench.png（桌面两区）、m1-narrow-chat2.png（窄屏对话）、
  m1-narrow-workspace.png（窄屏工作区，切换条双向可用）
- 修复记录：GET /projects 的 RLS 上下文重构；窄屏切换条移出隐藏面板；CSS 规则顺序

### EV-011 ｜ 2026-09-20 ｜ M2 发布链集成测试
- 命令：`npx vitest run`（全量 31 passed，含 tests/m2-release.test.ts 12 项）
- 覆盖：分支草稿写入（新不可变修订+头移动+STALE_HEAD 409）、差异接口（属性逐字段+二进制摘要，B02）、
  成员提交 CR→prepare-review→管理员发布全链；成员发布 403（B03）；自审自发默认 403、
  单人管理例外需 DB 预配置+留痕说明（发布策略）；prepare 后分支改动 → 发布 409 REVIEW_DIGEST_CHANGED（B04）；
  并发发布同资产：后发者因目标头移动失效（B05）；双资产发布中制品文件被删 → ARTIFACT_MISSING 全事务回滚（B06）；
  同幂等键重复发布返回首次结果且 release_set 唯一（B10）；绑定锁 r1 发布 r2 后不动（B09）+ 复合外键拒绝错配；
  回退生成新 rollback 发布集与事件、历史保留、通道指回（B08 部分）。
- 修复记录：prepare-review 未用参数 42P18；review_snapshots 列级 UPDATE 授权（仅 superseded）；
  序列授权补齐（0008）；发布重算摘要补 expected_channel_head。

### EV-012 ｜ 2026-09-20 ｜ M3 项目闭环集成测试
- 命令：`npx vitest run`（全量 40 passed，含 tests/m3-lifecycle.test.ts 9 项）
- 覆盖：需求创建与不可变修订演进；需求基线快照（C02 数据基础）；任务创建（覆盖需求+交付物）
  与依赖环拒绝；任务完成≠验收（C03 反例断言）；测试运行先失败后通过、失败运行不可作验收证据；
  C04：制品更新（r3）后旧证据失效，结题门阻塞并报"证据失效"；C05：关键需求缺验收阻止结题、
  成员豁免 403、豁免缺原因 422、管理员豁免成功留痕；C02：追踪矩阵由真实数据生成
  （需求→任务→交付物→测试→验收，evidence_current=false 正确标记过期证据）；C06：结题包含
  基线/阶段门/豁免留痕/遗留字段。
- 修复记录：基线条目列序、结题包 releases 参数、gate_reviews 歧义列。

### EV-013 ｜ 2026-09-20 ｜ M4 真实 LLM Agent 测试
- 命令：`npx vitest run tests/m4-agent.test.ts`
- 退出码：0（8 passed）
- 真实调用：DeepSeek 官方 API（deepseek-flash），8 次运行完成：
  D01a 资产整理（search→getRevision→proposal.create，提案落库 pending）、
  D01b Issue 处理（search→issue.create，Issue 落库 open）、
  D02 注入发布提示（无 ok 发布调用、release_sets 为零）、
  D04a 预算 blocked、D04b 取消 cancelled、D06 未知外部结果 unknown_reconcile、
  SSE Last-Event-ID 续接重放、错误 key → LlmError 明确失败。
- 修复记录：run_team_index 需创建时写入；工具名 OpenAI 线上格式映射（点→双下划线）；
  run_events 序列授权。

### EV-014 ｜ 2026-09-20 ｜ M5 语义与安全测试
- 命令：`npx vitest run tests/m5-semantic.test.ts tests/m5-security.test.ts`
- 退出码：0（5+6 passed）
- 语义：真实 semantica 0.6.8 worker（Python FastAPI）——中文关系候选（dependsOn←"依赖于"，
  带字符偏移证据与 revision_ref 来源）、同名实体不自动合并、非法单位结构拒绝；
  worker 断连 → 503 DEPENDENCY_UNAVAILABLE，核心登记/检索不受影响（D09）。
- 安全：路径穿越 4 样例 404、用户文件名不落盘、越权下载 404、响应无密钥、
  登出即撤销、blob 强制 octet-stream。

### EV-015 ｜ 2026-09-20 ｜ E03 备份恢复演练（真实容器）
- 命令：`npx tsx scripts/e2e-m5-restore.ts`
- 退出码：0；报告：docs/evidence/m5-restore-report.json
- 全步通过：真实数据（两用户/项目/资产/发布）→ pg_dump + blob 目录备份 →
  全新 pgvector:pg16 容器（5438）→ 先建角色再导库 → 应用角色起 API →
  验证：登录、资产修订摘要、blob sha256 一致、备份前已撤销会话仍 401、outbox 恰一条不重复。
- 演练固化的运维事实：角色是集群级对象不在 dump 内，必须"先建角色、后导库"（BACKUP.md）。

### EV-016 ｜ 2026-09-20 ｜ E05 性能测量
- 命令：`npx tsx scripts/perf.ts`
- 退出码：0；报告：docs/evidence/m5-perf-report.json
- 规模：测量时全库 10,271 资产 / 100,448 修订 / 200,026 关系（超过设计代表量）。
- 结果：assets.search P50/P95 = 23/33ms；assets.detail = 20/27ms；
  channel.view = 5/6ms；发布事务端到端 95ms（成员提交+管理员发布真实链路）。
  全部优于设计目标（列表/详情 ≤1s，发布 ≤2s）。环境：本机 Docker，非生产硬件。

### EV-017 ｜ 2026-09-20 ｜ 最终回归与浏览器复验
- `npx tsc -b tsconfig.json` 退出码 0
- `npx vitest run`：7 套件 59 项全部通过
- 浏览器（Playwright MCP）：重启后服务照常，原会话/消息/资产保留；
  docs/evidence/final-workbench-desktop.png

### EV-018 ｜ 2026-09-20 ｜ C07/C08 补强完成
- 命令：`npx vitest run`（8 套件 62 项全部通过，含 tests/m5-c7c8.test.ts 3 项）
- C07：PATCH /assets/:id/meta + If-Match ETag（meta_version 乐观锁）——缺头 422、
  过期 409 STALE_HEAD（返回当前 ETag）、成功后版本前移。
- C08：POST /sessions/:id/share-check + /share——secret/restricted 引用与 [private]
  消息阻断；检查摘要比对防 TOCTOU；分享后项目成员可见；阻断态保持私有。

### EV-019 ｜ 2026-09-20 ｜ M6 生命周期加固与迁移预览（tests/m6-hardening，7 项）
- 归档权限负例（无关成员 403、未登录 401）、创建者归档 → 默认目录隐藏 +
  `lifecycle=archived` 过滤可见 + audit_events 落库（含原因）、重复归档 409、
  恢复权限与 NOT_ARCHIVED 负例、OPEN_DRAFTS 守卫（有未合并草稿拒绝归档）、
  归档后草稿写入与新 CR 均被 ASSET_ARCHIVED 拦截、
  POST /types/migration-preview（管理员专属；affected/failing/结构变更/被移除属性使用面/
  safe 判定，兼容迁移 safe=true 验证）。

### EV-020 ｜ 2026-09-20 ｜ M6 并发竞态（tests/m6-concurrency，4 项，真并发）
- ① 两个 CR 并发发布同一资产（Promise.allSettled 真并发）→ 恰好一个 200；
  败者 409 且 CR 保留 awaiting_review；退回 → 重新 prepare（expected 头已移动）→ 发布成功。
- ② 同一 CR 并发双发布 → 一次 200 一次 409 CR_STATE；release_set/approval 恰好各一条。
- ③ 并发草稿保存同期望头 → 一次 201 两次 STALE_HEAD，无孤儿修订，分支头=胜者。

### EV-021 ｜ 2026-09-20 ｜ M6 并发负载（scripts/perf-concurrent.ts）
- 命令：`npx tsx scripts/perf-concurrent.ts`；报告：docs/evidence/m6-concurrent-perf.json
- 夹具：2,000 资产 × 5 修订；阶段 R（16 读 worker × 40 op）P50/P95 = 21/42ms、687 op/s、0 错误；
  阶段 W（8 写 worker × 15 草稿）P50/P95 = 16/24ms、404 op/s、0 错误；
  阶段 X 混合：读 P95 = 45ms（写负载下仅 +3ms），写 P95 = 83ms，全程 0 错误。

### EV-022 ｜ 2026-09-20 ｜ M6 韧性演练（scripts/e2e-m6-crash.ts，16 步全绿）
- kill -9 写入突发窗口：崩溃前已确认写入（含 content_digest）重启后全部持久；
  崩溃前登录会话重启后仍有效。
- kill -9 发布事务窗口（确定性注入：独立连接持 CR 行锁 → 发布事务开启后停在锁上 → SIGKILL，
  响应"无（进行中被切断）"）：重启后发布事务完整回滚——无 release_set/approval/通道头/
  main 视图/outbox（全有或全无）；outbox 无重复事件。
- 冷启动引导：全新空容器（5439/新卷）→ 预创建角色 → 从零迁移全部 schema →
  注册→资产→分支→CR→发布→通道视图 全链路成功。
- 报告：docs/evidence/m6-crash-drill.json

### EV-023 ｜ 2026-09-20 ｜ M6 UI 流程浏览器验证 + 扩展包（tests/m6-extensibility，4 项）
- 浏览器（Playwright MCP，真实 API）：登记资产 → 资产详情草稿面板（新建分支/保存草稿 r2/
  创建 CR）→ 发布与通道双通道视图 → 作者身份发布被作者分离拦截（错误提示正确显示）→
  管理员退回 → preview 通道重新准备 → 发布成功（preview 通道头 r2 · REL-…，stable 保持空）→
  归档/恢复（原因入审计、过滤切换、徽章展示）。截图 docs/evidence/m6-ui-preview-channel.png。
- 发现并修复真实缺口：GET /projects 原先只按 project_members 过滤，团队管理员看不到团队项目
  （与发布权不一致）；已改为管理员可见全团队项目。
- 扩展包：运行时注册 custom.sensor-grid（含 Hz/kHz 词表）零代码改动 → 词表外单位 422、
  缺必填 422 → 跨类型关系（自定义类型 → 内置 document）→ 草稿/CR/preview 发布/通道视图全链路。
- 回归：`npx vitest run` 11 套件 77 项全部通过。

### EV-024 ｜ 2026-09-20 ｜ M7 outbox 派发 worker（tests/m6-worker，5 项）
- 迁移 0016：outbox 租约列（leased_at/lease_until/last_error）、未投递部分索引、
  专用 taw_worker 角色（表级 RLS 策略，不绕过租户隔离整体）。
- apps/worker/src/dispatcher.ts：FOR UPDATE SKIP LOCKED 租约抢占 + 至少一次投递 +
  5s 超时 + 失败退避（超上限进 1 小时慢车道，保持未投递事实）。
- 测试用真实 HTTP 接收端（测试内 node http server）验证：投递成功且 delivered_at 落库、
  已投递不再重投、500 失败后 attempts/last_error 入账并恢复重投（attempt=2）、
  有效租约阻止重复投递、慢车道长退避。

### EV-025 ｜ 2026-09-20 ｜ M7 Agent 区接真实运行（浏览器验证）
- 新端点 GET /sessions/:id/runs（会话运行历史 + 工具调用轨迹，tests/m7-api）。
- Workbench Agent 区重写：发送即创建真实 DeepSeek 运行 → EventSource 接 SSE
  （tool_call/tool_result/message/completed/blocked/cancelled/failed/unknown_reconcile，
  断线按 Last-Event-ID 自动续传）→ 工具事件块（参数/结果展开、状态图标）→
  取消按钮 → 模型不可用时诚实降级为普通消息（不伪造回复）。
- 浏览器实测：任务"检索团队资产"→ asset.search 工具块"✓ 完成"→ 真实模型回复列出
  库中 2 项资产及修订摘要。截图 docs/evidence/m7-ui-agent-run.png。

### EV-026 ｜ 2026-09-20 ｜ M7 查询层优化
- 迁移 0016 索引 idx_revisions_head (team_id, asset_id, seq DESC)：
  头修订 LATERAL 查找从"取全部修订再排序"降为索引 top-1；
  EXPLAIN ANALYZE 确认 Index Scan 无 Sort 节点，0.17ms。
- GET /assets/:id 修订历史分页（revLimit/revOffset，revisionsTotal），
  长历史资产不再全量返回（tests/m7-api 翻页断言）。
- 去重：catalog.ts 本地 stableStringify 副本删除，与发布摘要共用 @taw/domain/digest 实现。
- 回归：`npx vitest run` 13 套件 84 项全部通过。

### EV-027 ｜ 2026-09-20 ｜ M8 本体治理（吸收 semantica 关系语义层）
- 迁移 0017：asset_type_versions.parent_type_version_id（subClassOf，显式版本引用 + 复合 FK +
  环防御深度上限）；relation_type_versions.source/target_type_keys（类级 domain/range，
  空数组=不限）；idx_assets_type、idx_agent_runs_team_time。
- domain 层新增：ENTITY_KINDS、danglingVocabularies（词表悬挂质量门，<name>/<name>Unit
  双声明任一即可，兼容既有附加属性约定）、inheritanceViolations（子类型只能收窄父类型，
  属性类型改写拒绝）。
- API：POST /types 支持 parentTypeVersionId + 质量门；资产登记按整条类型链校验；
  POST /relations 强制 kind 级 + 类级 domain/range（409 DOMAIN_RANGE_VIOLATION）与
  成环禁止（409 CYCLE_FORBIDDEN，递归 CTE 反向走边——修掉了初版从目标侧出发漏检直接环的 SQL）；
  POST /relation-types 参数化 kinds/type_keys + 悬挂键质量门；GET /relation-types 列表；
  POST /types/migration-preview 覆盖后代类型资产 + 继承违规预演；
  POST /relation-types/migration-preview（收窄违反清单 + 存量环检测）；GET /ontology/export
  （taw-ontology/1：类含 subClassOf、对象属性含 domain/range，stableStringify+sha256 摘要稳定）。
- 测试 tests/m8-ontology（6 项，真实 HTTP/PG）：质量门拒绝、层次收窄校验与链上实例校验、
  预览后代影响、domain/range 违规 409、直接/传递环 409、关系预演、导出摘要稳定与跨团队隔离。
- 期间修复：类型层次预览 CTE 别名 desc 为 PG 保留字 → desc_types。

### EV-028 ｜ 2026-09-20 ｜ M8 项目总览 + 团队动态 + 前端工作台化（吸收 AgentPM）
- 后端：GET /projects/:id/overview（项目域分支/CR 状态分布/发布近30天 + 团队域资产/修订/关系，
  单次聚合）；GET /activity?teamId（事件溯源红利：audit_events 人的治理动作 + agent_runs
  Agent 运行 → 人机混排时间线，零新表）。测试 tests/m8-activity（2 项）：计数一致性、
  倒序/limit/中文动作标签/跨团队 404 隔离/未登录 401。
- 前端：左侧主导航栏（总览/工作台/动态/审批/搜索，窄屏自动横排）；总览仪表盘
  （统计卡行 + 待处理审核 + 最近动态 + 快捷入口）；动态页（20/50/100 条 + 刷新）；
  审批页（CR 队列 + 只读详情 + 快照提示 + 进入发布流程）；登记资产类型下拉显示 ↳ 继承父类型。
- ⌘K 命令栏（页面跳转 + 资产搜索防抖置顶 + Enter 深链打开资产详情）；
  lib/shortcuts.ts 快捷键单一真源（Ctrl/⌘+K、? 帮助浮层、g+字母两级跳转、isTypingTarget 防劫持）；
  统一空状态四件套（Empty 组件）。
- 浏览器实测（Playwright，端口 5174；5173 被另一 agent 的设计原型占用不冲突）：
  仪表盘真实统计与动态渲染（docs/evidence/m8-ui-dashboard.png）；
  登记→分支→草稿→CR 后审批队列显示"1 个待处理"及详情/快照提示（m8-ui-approvals.png）；
  ⌘K 输入"轨道"资产置顶 → Enter 直开资产详情；? 浮层；g→d 跳总览均通过。
- 回归：`npx vitest run` 15 套件 92 项全部通过（期间放宽词表质量门以兼容 M6 扩展包
  附加属性词表约定，质量门语义更新为 <name>/<name>Unit 双声明任一即可）。

### EV-029 ｜ 2026-09-20 ｜ M9 真实 LLM 深化：NL 命令解析（tests/m9-llm，6 项）
- 新端点 POST /nl/parse：解析器链 = L1 规则（确定性短命令，零模型成本）→ L2 真实 DeepSeek
  （严格 JSON + zod 白名单校验，意图仅 navigate / search_assets / fill_register_form，
  全部映射到既有只读/表单预填动作，不新增服务端写权限面）。
  溯源如实返回 parser.kind/model/tokens；LLM 不可达或输出越白名单时回退"按原文搜索"
  并在 note 中如实标注（注入式指令在真实运行中模型自行抵抗返回合法意图，回退路径亦被覆盖）。
- 浏览器实测（真实 DeepSeek）：⌘K 输入自然语言 → Ctrl+Enter 解析 → 意图卡（LLM·deepseek-chat
  · 229/244 tokens）→ 执行：search_assets 回填关键词并呈现资产结果；
  fill_register_form 跳转登记页并预填类型（document）与名称。截图 m9-ui-nl-search.png、
  m9-ui-nl-register.png。

### EV-030 ｜ 2026-09-20 ｜ M9 语义候选抽取接真实 LLM 增强 + 诚实降级
- services/semantic-worker/main.py：/extract_candidates 增加 enhance_llm——调用真实 DeepSeek
  （OpenAI 兼容，stdlib urllib 无新依赖，key 只从环境读取）提出候选关系；
  词表约束 + 端点必须原文可定位（不采信模型编造的词）+ 与规则候选合并去重；
  LLM 候选同样 status=candidate，extractor_version 如实追加 "+llm/deepseek"；
  无 key / 上游失败 → 警告明确、回退规则候选、不伪造 LLM 候选。
- API /semantic/extract 透传 enhanceLlm，超时放宽至 45s。
- 同名冲突修复（真产品缺陷）：semantica ConflictDetector 的 value 冲突按"同一实体 id、
  不同来源"分组，此前按不同 entity_id 送检永远检不出冲突；改为按名字作为分组键送检
  （候选场景中同名即候选同一现实实体，仅检测不合并），m5-semantic 同名冲突用例转真后通过。

### EV-031 ｜ 2026-09-20 ｜ 测试诚实化：空洞断言清零，暴露并修复 5 个真产品缺陷
- 审计发现 vitest 中不带匹配器的裸 `expect(cond, msg)` 不做任何断言（空断言），
  全仓 10 个测试文件共 80 处用脚本统一改写为真实断言（`expect(cond, msg).toBe(true)`），
  m6-concurrency 内联两处与 m8 一处人工改写。
- 转真后暴露并逐一定位修复的真产品缺陷：
  1) 发布事务缺少分支漂移守卫：prepare 后分支被改，持旧审核摘要仍可发布过期候选
     （B04 守卫只存在于 prepare-review）→ review-and-publish 补齐同一 head_moved 检查；
  2) 并发首发布竞态 500：两个 CR 同时发布到尚不存在的通道时，通道 INSERT 撞唯一约束
     → 改为 ON CONFLICT DO NOTHING + 重读，败者被目标头失配守卫正常 409；
  3) 单人例外配置路径失效：team_settings 无播种行，文档化的 UPDATE 静默零行
     → 注册事务内建立租户上下文并播种默认行；
  4) unknown_reconcile 从未生效：工具网关把 UnknownOutcomeError 吞成普通错误回喂模型
     → 网关先落审计记录再重抛，D06 对账语义端到端真实生效（真实 LLM 验证）；
  5) m2 STALE_HEAD 负例传入的是新头而非旧头（幽灵修订级联 4 个用例）等测试侧错误一并修正；
  m6-worker 补"排干遗留未投递事件"基线步骤，消除对干净 outbox 的隐含假设。
- 全量：`npx vitest run` 16 套件 98 项全部通过（每一条断言都真实生效）。

### EV-032 ｜ 2026-09-20 ｜ M10 迭代轮：NL 写类意图（预览-确认）+ 关系图谱 + 本体 Turtle 导出
- NL 意图扩展到写类（create_issue）：解析端点保持零副作用（POST /nl/parse 只产草稿，
  create_issue 无标题即判白名单校验失败、诚实回退）；界面命令栏卡片预览标题/正文，
  点「执行」才调用既有 POST /issues 真实落库——写类操作双重确认，服务端不新增写权限面。
  L1 规则新增确定性句式（报告/提交/新建/建/提 + 问题/工单/Issue：标题；打开/跳到 图谱），
  L2 提示词白名单扩为四意图并注明"仅描述问题而非明确要求建工单时用 search_assets"。
- 关系图谱页（rail「图谱」，g+m）：数据全部来自真实端点（团队级 GET /relations 不带
  assetId + /assets/search lifecycle=all）；本地力导向布局（确定性圆环初始化、斥力+弹簧+
  向心、alpha 收敛），节点按 type_key 着色、度数决定半径、拖拽重排（>2px 移动不误触
  点击）、点击打开资产详情；关系类型/状态过滤、孤立资产如实提示隐藏数量。
- 本体导出 Turtle：GET /ontology/export?format=turtle → RDF 1.1 Turtle（text/turtle），
  确定性序列化（时间戳不入正文，ontologyDigest 以 owl:versionInfo 关联 JSON 文档；
  类 owl:Class + rdfs:subClassOf、类属性 owl:DatatypeProperty + tk:enum、关系类型
  owl:ObjectProperty + rdfs:domain/range（多值 owl:unionOf）、kind 层伪类）。
  修复序列化顺序缺陷：kind 段原在对象属性遍历前渲染，而 kindIris 由该遍历收集——
  调整为遍历后渲染。
- 总览新增「最近问题」卡片（GET /projects/:id/issues），闭环 NL/Agent 建工单的可见性；
  flash 操作反馈（6s 自动消失）替代无声成功。
- 测试诚实化延续：m4 D04b（取消传播）原为与真实模型的单次赛跑，全量中偶发 completed
  先于取消——改为至多 3 轮真实重试、断言至少一轮取消真实传播（不 mock、不放宽语义）。
- 全量：`npx vitest run` **17 套件 105 项全部通过**（新增 tests/m10-graph-nl-turtle 7 项：
  L1 写意图规则确定性、L2 真实 DeepSeek 建工单解析、白名单注入防护、解析零副作用 +
  确认路径真实落库、图谱数据端点、Turtle 结构/digest 关联/确定性）。
- 浏览器实测（真实 DeepSeek）：「报告问题：轨道衰减数据与实测偏差过大」规则解析 → 预览卡
  → 执行 → 工单落库并在总览可见；自然口吻建工单 LLM·deepseek-chat·334 tokens 准确提取
  标题/正文 → 执行 → flash「问题工单已创建（404bf709…）」；图谱页 2 节点 1 边正常渲染、
  点击节点打开资产详情、拖拽不误触；⌘K「打开图谱」导航直达。
  截图 m10-ui-nl-issue-preview.png、m10-ui-nl-issue-llm.png、m10-ui-issue-flash.png、
  m10-ui-graph.png。

### EV-033 ｜ 2026-09-21 ｜ M11 迭代轮：活动流实时推送（Postgres NOTIFY → SSE）+ 本体导出下载
- 数据链路完全事件驱动、零轮询：迁移 0018 在 audit_events / agent_runs 上建 AFTER
  INSERT（运行含 UPDATE OF status）触发器，事务提交时 pg_notify('taw_activity')
  ——NOTIFY 提交后才投递，回滚不产生幻影事件；通知只携带 kind/team_id/id
  （id 统一转 text 防 JS 大数失真）。
- apps/api/src/activityHub.ts：单例 LISTEN 连接（只收通知不查表，断线自动重连并
  重 LISTEN），按 team_id 扇出订阅者回调；GET /activity/stream（SSE）：鉴权同列表
  接口（成员校验），事件正文按 id 实时取（与 GET /activity 同一标签语义、同源），
  25s 心跳注释，断开时取消订阅并清理。
- Agent 运行的 INSERT 与每次 status 变化都推送；事件带稳定 key（audit:<id> /
  agent:<runId>），GET /activity 同步补 key —— 界面按 key 原地覆盖运行状态、新事件
  头插并按 limit 截断；断线重连成功后整体重取对齐。动态页头部加「● 实时 / ○ 未连接」
  真实连接状态徽标。
- 图谱页新增本体导出下载按钮（Turtle / JSON，文件名带项目代号）——M10 的确定性
  Turtle 序列化从 API 工件变为界面可取的交付物，实测下载文件 digest 与 JSON 一致。
- 测试 tests/m11（4 项，真实 NOTIFY + 真实 SSE 流式解析，非轮询模拟）：审计事件
  推送（归档落库即达，summary/actor/key 与列表同源）、团队隔离（外团队动作有界窗口
  内零泄漏）、Agent 运行推送（创建即达 + 取消状态按 key 原地更新）、鉴权（匿名
  401/403、非成员 404）。
- 全量：`npx vitest run` **18 套件 109 项全部通过**。
- 浏览器实测：动态页显示「● 实时」；curl 归档资产后约 1.5s 内列表未刷新即出现
  「归档资产 asset.archive」条目（截图 m11-ui-activity-live.png）；图谱页点击
  「导出 Turtle / 导出 JSON」真实下载，TTL 头部与 owl:versionInfo digest 与 JSON
  文档一致（8f67d617…，7 类）。

### EV-034 ｜ 2026-09-21 ｜ M12 迭代轮：运行事件流迁移 NOTIFY（去轮询）+ 取消健壮性修复 + 图谱聚焦
- 迁移 0019：run_events 插入与 agent_runs 状态变化在提交时 pg_notify('taw_run')；
  activityHub 扩展为单例 LISTEN 双通道（taw_activity + taw_run），按 team_id:run_id 扇出。
- /runs/:id/events 重写：Last-Event-ID 重放语义不变（线格式 id/event/data + done 完全兼容，
  前端零改动），400ms 轮询循环删除——事件经 NOTIFY 即时推送，每个连接不再反复查库；
  通知回调串行化（修复并发 drain 以同一游标重复取事件的竞态，全量回归中实测暴露）；
  不存在的运行现在静默关闭而非无限等待。终态时序不变量：runner 全部终态路径改为
  先写 run_events 再更新 agent_runs 状态——状态 NOTIFY 必然晚于该运行全部事件 NOTIFY，
  done 不会早到。
- **真产品缺陷修复（取消健壮性）**：cancel 请求若在执行器注册 AbortController 之前到达
  （慢机/排队积压窗口），进程内 abort 丢失且数据库里的 cancel_requested 从未被读取——
  取消被静默吞掉，运行照跑到完成。现在 runner 每轮开始复查 cancel_requested 兜底；
  同时修复取消恰好落在两轮之间会被误标为 blocked「运行轮数达到上限」的边界
  （改为正确的 cancelled 终态）。
- 图谱聚焦模式：按资产聚焦一跳邻域（节点虚线高亮环 + 计数提示），孤立资产也可聚焦。
- 测试 tests/m12（3 项，真实 NOTIFY + 真实 DeepSeek 运行 + 流式帧解析）：真实运行
  run_started→completed→done 全程送达且 seq 严格递增；Last-Event-ID 部分续传只补其后
  事件且与全量尾部逐帧一致；匿名/非成员/不存在的运行边界。m11 运行推送用例同步加固：
  等任意终态推送并与库中真实状态核对（与模型速度解耦，不编造状态）。
- 全量：`npx vitest run` **19 套件 112 项全部通过**（57s）。
  连续全量压测中暴露的偶发失败均已溯源修复（上述两处产品缺陷），非环境问题。
- 浏览器实测：对话区真实运行「检索资产清单」工具事件即时流式呈现、完成态与总结正常
  （截图 m12-ui-run-stream.png）；图谱聚焦切换 2 节点↔1 节点（虚线环+提示）验证通过。

### EV-035 ｜ 2026-09-21 ｜ M13 迭代轮：本体治理台（M8 治理能力首次开放给人类界面）+ 图谱多跳
- 新本体治理页（rail「本体」，g+o，NL「打开本体」）：类层次树（subClassOf 父子缩进 +
  版本/状态徽章 + 可展开属性表：类型/必填/枚举）；关系类型表（domain/range 的
  kind 级与类级 type_keys、可成环/对称/需修订约束、**断言计数**——GET /relation-types
  新增 lateral count 列）。
- 管理员变更能力从 curl 走进界面：登记新类型（typeKey/版本/标题/父类型/JSON Schema，
  质量门错误如实展示）；登记关系类型（kind 多选 + 类级 type_keys + 约束）；
  类型迁移预演（选 active 类型 → 编辑新 schema → 影响资产数/头修订失败样例/结构变化/
  层次波及）；关系类型迁移预演（domain/range/成环 → 违规明细/存量环/安全结论）。
  预演结果 safe 绿 / 阻塞红；所有表单服务端二次校验角色（界面隐藏只是第一道门）。
- 修复潜伏 UI 缺陷：`.btn-row button`（0,1,1）覆盖 `.primary`（0,1,0），凡位于 .btn-row
  的主按钮一律白底白字不可见——浏览器计算样式实测确认后，以后置同级特异性规则修复。
- 图谱聚焦多跳展开：聚焦资产 1/2/3 跳 BFS 邻域（跳数选择器仅在聚焦时出现）；
  本体导出按钮从图谱页迁至本体页（主题归属更合理）。
- 测试 tests/m13（4 项）：关系类型断言计数 0→1 如实增长（顺带修复 COALESCE
  text/integer 类型错误的 500）；登记类型管理员门（成员 403）；收窄继承质量门
  （改写父属性类型被拒）；NL「打开本体」规则导航。全量 **20 套件 116 项全部通过**（59s）。
- 浏览器实测：g+o 与 rail 进入本体台；展开 agent.template 属性表与子类型挂载展示；
  界面真实登记 m13live 类型（8 类版本刷新可见）；livedepends 预演 range 收窄为
  software → 红色阻塞警告（safe=false + target 侧违规明细）。
  截图 m13-ui-ontology.png、m13-ui-ontology-forms.png。

### EV-036 ｜ 2026-09-21 ｜ M14 迭代轮：语义候选工作台（M5/M9 抽取闭环的最后一块——人工确认入口）
- 新工作台标签「语义候选」（SemanticPanel）：粘贴文本 + 来源资产（证据锚定其最新修订）
  + 实体提示 + LLM 增强开关 → POST /semantic/extract（真实 worker；规则基线与
  DeepSeek 增强合并）→ 候选关系列表：类型徽章、规则/LLM 提议来源、置信度、
  原文证据引文。
- 确认闭环：端点文本自动预映射团队资产名（精确/包含匹配，可改选）；关系类型按
  候选 type 映射到已注册词表（未注册如实提示"需先在本体治理台登记"并禁用确认）；
  确认 = 既有 POST /relations（confirm:true）——domain/range 与成环禁止由服务端
  强制执行，违规错误逐条回显。断言成功后候选卡转为"✓ 已断言"态；忽略则隐藏。
  抽取端无候选 / worker 不可达（503 DEPENDENCY_UNAVAILABLE）/ LLM 降级警告均如实呈现。
- 后端零改动（纯既有端点的编排）；语义抽取从"只出报告"变为可操作的确认流水线。
- 测试 tests/m14（3 项，真实 worker + 真实 DeepSeek）：规则抽取 → 端点精确映射 →
  确认断言 → /relations 目录可见 confirmed 边；LLM 增强抽取（+llm/deepseek 版本或
  如实降级）候选仍为 candidate 且经人工确认可断言；worker 不可达 503 如实报错。
  全量：`npx vitest run` **21 套件 119 项全部通过**（57s）。
- 浏览器实测（真实 DeepSeek）：粘贴文本抽取 → 抽取器 +llm/deepseek，2 条候选
  （dependsOn 规则 50% + documentedBy LLM 提议 75%）；端点自动映射正确，确认断言
  转"✓ 已断言（a2c08e02…）"；图谱页随之显示 2 节点 2 关系（新 dependsOn 边）。
  无 key worker 场景的降级警告（"LLM 增强失败，已降级为规则候选: DEEPSEEK_API_KEY
  未配置"）同样实测确认。截图 m14-ui-semantic.png。

### EV-037 ｜ 2026-09-21 ｜ M15 迭代轮：候选审核队列（持久化 + 跨成员 + 原子确认）
- 迁移 0020 semantic_candidates：候选持久化（RLS 租户隔离），状态机
  pending → confirmed/dismissed（decided_by/decided_at/resolved_relation_id 全留痕）。
- 重构：关系断言核心从 POST /relations 抽出为共享函数 createRelationAssertion
  （kind/类级 domain/range、成环禁止、修订绑定校验唯一入口；可选传入事务 client），
  HTTP 端点与候选确认走同一条校验路径。修复随重构暴露的隐患：conditions 缺省时
  JSON.stringify(undefined) → NULL 违反非空约束（HTTP 层 schema 默认值掩盖了它）。
- 端点四则：POST /semantic/candidates/import（入队，≤50 条，created_by 留痕）、
  GET /semantic/candidates?status=（队列，含入队人/来源资产）、
  POST .../confirm（FOR UPDATE 锁候选 + 共享断言 + 状态更新同一事务——断言违规时候选
  保持 pending 可修正重试；类型未注册 / 已处理分别 409 如实区分）、
  POST .../dismiss。
- UI：SemanticPanel 新增「存入审核队列」按钮与「待审核队列」区（跨会话/跨成员持久；
  按资产名自动预映射可改选；确认/忽略即时刷新队列）。
- 测试 tests/m15（5 项）：入队 → 成员队列可见（如实标注入队人与来源资产）；
  成员经确认端点断言成功且 relation 目录可见 confirmed、重复确认 409；
  DOMAIN_RANGE_VIOLATION 时候选保持 pending；忽略后移出待审且重复忽略 409；
  非成员 404。全量：`npx vitest run` **22 套件 124 项全部通过**（58s）。
- 浏览器实测：抽取（+llm/deepseek，2 条）→ 存入审核队列 → 队列（2）→ 确认一条
  （documentedBy LLM 提议 75%）→ 队列（1）；DB 复核状态机
  （documentedBy confirmed t 0.75 / dependsOn pending f 0.5）。
  截图 m15-ui-candidate-queue.png。

### EV-038 ｜ 2026-09-21 ｜ M16 迭代轮：活动流按项目过滤（审计补项目维度）
- 迁移 0021：audit_events 增加 project_id（可空）+ (team_id, project_id, created_at) 索引。
  过滤语义明确定义：**项目级动作**（review_prepared / release_published / release_rollback、
  Agent 运行）携带 project_id，按项目过滤时显示；**团队级动作**（资产归档/恢复等，
  project_id 为 NULL）仅在"全部项目（团队视图）"出现——不虚构归属。
- releases.ts 三处审计写入真实盖章：prepare-review、review-and-publish、rollback
  （rollback 的通道 FOR UPDATE 查询顺带补 SELECT project_id 与存在性检查）。
- GET /activity 与 GET /activity/stream 支持可选 projectId：列表 SQL 过滤；
  SSE 流在事件回查时按项目比对（团队级事件不进入项目过滤流）。
- ActivityPage 新增项目过滤选择器（当前团队项目列表），切换即重取历史并重订阅
  实时流；「● 实时」状态保持。
- 测试 tests/m16（3 项）：真实 prepare-review 流程产生的审计带 P1 盖章并进入 P1
  过滤视图；过滤语义（团队级审计仅在全部视图、P1/P2 互不可见对方运行、全部视图
  皆有）；SSE 项目隔离（P2 插入的运行 3 秒有界窗口零泄漏，P1 插入即时到达）。
  全量：`npx vitest run` **23 套件 127 项全部通过**（57s）。
- 浏览器实测：动态页过滤下拉（全部项目/M10实测项目）；选 M10实测项目后仅显示
  项目级 Agent 运行，团队级「归档资产」审计隐藏；「● 实时」保持。
  截图 m16-ui-activity-filter.png。

### EV-039 ｜ 2026-09-21 ｜ M17 迭代轮：Agent 提案审核闭环（proposal.create 首次开放给人类）
- 排查发现又一处断头闭环：Agent 的 proposal.create 工具（M4）一直把整理提案写入
  agent_proposals，但没有任何读取端点与界面——人永远看不到 Agent 建议了什么。
- 新端点：GET /projects/:id/proposals?status=（列表：kind 排除 issue_triage 回执、
  状态筛选、关联来源运行的指令与发起人、审核人）；POST /proposals/:id/review
  （FOR UPDATE + pending 校验，decision accepted/rejected，可选备注以 jsonb 合并进
  payload.review，审核人/时间如实留痕；重复审核 409 PROPOSAL_NOT_PENDING）。
  无需迁移——0011 建表时已内置状态机。
- UI：工作区新标签「Agent 提案」（状态筛选 + 结构化卡片：kind 徽章、从自由 payload
  兼容提取建议名称/类型提示、审核备注、来源运行指令、JSON 原文可展开）；
  asset_registration 提案提供「按提案预填登记…」——跳登记表单预填名称与类型
  （人工完成真实登记，接受不自动写库）。逐条错误如实回显。
- 测试 tests/m17（3 项）：真实 DeepSeek 运行调用 proposal.create → 提案在待审列表
  可见（kind/发起人/来源运行如实）；成员接受带备注（payload 合并审核回执、
  reviewed_by 如实、重复审核 409 PROPOSAL_NOT_PENDING、issue_triage 回执被列表排除）；
  非成员 404。全量：`npx vitest run` **24 套件 130 项全部通过**（61s）。
- 浏览器实测（真实 DeepSeek）：对话区派任务 → Agent 调用 proposal.create（提案
  b37d1116…）→「Agent 提案」待审列表出现（建议名称"轨道仿真数据集 2026 · 类型
  提示 document"自动提取）→ 点接受 → 待审清空、已接受视图显示审核人。
  截图 m17-ui-proposals.png。

### EV-040 ｜ 2026-09-21 ｜ M18 迭代轮：候选队列批审与详情 + 本体页单位词表
- M15 的候选队列只能逐条审核；入队量大时人工成本线性增长。本轮补齐批量通道，
  并把候选的完整留痕（原文定位/抽取器/决策人/断言去向）开放给审核人。
- API：confirmCandidate 抽为共享核心（候选锁 + 状态机 + 类型解析 + 断言，单条与
  批量同一路径）；POST /semantic/candidates/batch-confirm（≤50 条，每条 SAVEPOINT
  隔离——一条失败回滚到保存点后继续，逐条如实回执 ok/relationId 或 code/message，
  部分成功不伪装全成功；整单恒 200）；POST .../batch-dismiss（逐条回执，已处理
  条目标 CANDIDATE_NOT_PENDING 不中断）；GET /semantic/candidates/:id（全字段 +
  created_by/decided_by 双留痕 + resolved relation 的类型与版本去向）；
  GET /semantic/units（代理 worker 词表，不可达 503 DEPENDENCY_UNAVAILABLE）。
- worker：UNIT_VOCAB 提升为模块级唯一定义点（校验执行与对外展示同源），新增
  GET /units。
- UI：待审核队列批审条（全选/已选 n/批量确认/批量忽略；未映射端点的勾选项不送审、
  行内如实提示）；每行批选框与「详情」展开（状态/证据来源可点击开资产/原文
  spans/抽取器/入队人与时间/决策留痕或待定）；失败逐行回显。本体治理台新增
  「受控单位词表」卡片（4 属性键真实词表；worker 降级时如实提示，不影响本体治理）。
- 测试 tests/m18（6 项，全部真实集成）：混合批量确认（2 确认 + DOMAIN_RANGE_VIOLATION
  + RELATION_TYPE_UNREGISTERED 逐条回执、违规保持待审、断言真实落地目录可见）；
  重复批审逐条回执 CANDIDATE_NOT_PENDING；批量忽略（幽灵 id 如实回执不中断）；
  详情（决策留痕/断言去向/spans/404）；越权（51 条 422、非成员批审与详情 404 且
  数据未被改动）；单位词表（真实 worker 同源 + 不可达 503 降级）。
  全量：`npx vitest run` **25 套件 136 项全部通过**（61s）。
- 浏览器实测（真实 API 造数 + 真实 worker）：队列 3 条全选自动映射 → 批量确认
  全部落地（图谱 2 节点 3 关系可见）→ 补入 verifies 候选 → 「详情」展开六项留痕
  正确 → 勾选批量忽略 → 队列清空；本体页单位词表卡片渲染 positionUnit m/km/AU、
  timeScale TAI/UTC/TT/TDB/GPST 等真实词表。

### EV-041 ｜ 2026-09-21 ｜ M19 迭代轮：实时层自愈（LISTEN 断线检测/退避重连/断窗补齐）
- 自审发现 M11/M12 实时层的真实可用性缺口：activityHub 的单 LISTEN 连接是单点——
  静默断链（网络分区/Postgres 重启且 TCP 未报错）不触发 error，SSE 订阅者的通知
  从此静默丢失且永不恢复（旧重连只在 error 时尝试一次）；HTTP 连接还活着，
  浏览器侧的重取对齐逻辑根本不会触发。
- 自愈三件套（activityHub 重写）：① 周期健康探测（15s SELECT 1 带 5s 超时）主动
  发现死链并拆除；② 指数退避重连链（500ms 起步、8s 封顶，TAW_LISTEN_BACKOFF_MS
  可调），Postgres 恢复后自动重新 LISTEN；③ 重连成功且有既有订阅者时扇出 resync
  信号——运行流路由按 DB 游标精确补取断窗事件（seq 单调、恰好一次，终态 done 由
  DB 状态兜底，两路殊途同归）；活动流路由转发 SSE resync 帧、客户端整体重取
  （与列表同源的诚实对齐，不虚构补推）。连接期失败的 connecting 缓存拒绝一并修复
  （旧代码会让枢纽此后永久拿到同一个被拒 promise）。
- LISTEN 连接加 application_name=taw_activity_hub：pg_stat_activity 精准识别
  （运维排障与断线注入测试都靠它；健康探测的 SELECT 1 会让 query 列失配，
  应用名是唯一可靠锚点）。
- 顺带：候选队列新增状态筛选视图（待审可批审/已确认/已忽略只读历史，详情含决策
  留痕与断言去向）；NL 规则新增「打开/跳到 提案（页）」→ navigate proposals
  （工作台「Agent 提案」标签）；修复 CommandBar 意图名映射漏 ontology 的存量小缺陷
  （「打开本体」预览曾显示「跳转到「undefined」」）。
- 测试 tests/m19（3 项，真实断线注入非 mock）：pg_terminate_backend 终止 LISTEN
  后端（application_name 精准定位），断窗内 SQL 落库两条运行事件 + 转终态 → 重连
  后 resync 补齐：SSE 收到的 seq 序列与 DB 完全一致（无重复、保序）+ done 到达；
  活动流断窗审计事件 → resync 帧到达、重取可见、恢复后新事件实时到达（通道真正
  恢复而非一次性补齐）；NL 提案页三条句式 L1 确定性命中。
  全量：`npx vitest run` **26 套件 139 项全部通过**（64s）。
- 浏览器实测：动态页 ● 实时 → 终止 dev API 的 hub 后端 + 断窗内落库审计事件
  （audit id 1225）→ 约 1.5s 重连后条目「归档资产」未经手动刷新自动出现，且
  ● 实时保持（SSE 未断，证明走服务端 resync 而非浏览器重连）；候选队列「已确认」
  视图 3 条只读、详情显示 断言 1ad8968f…（dependsOn v1.0.0）+ 决策人/时间；
  ⌘K 输入「打开提案页」→ 规则解析卡片「跳转到「Agent 提案」」→ 执行后直接落到
  工作台「Agent 提案」标签。

### EV-042 ｜ 2026-09-21 ｜ M20 迭代轮：活动流历史分页 + 提案批量审核
- 自审发现两处治理闭环的数据可达性缺口：① 审计历史无限增长但 GET /activity 只有
  limit 截断——超过最近一页的历史人类永远看不到（治理产品的审计可达性缺陷）；
  ② Agent 一次运行可产出多条提案，却只能逐条审核。
- 活动流键集分页：游标 = 页尾条目（精确时间戳, kind, id），时间戳以 Postgres 原生
  文本往返（to_jsonb），避免 JS Date 毫秒截断丢微秒导致漏项。合并全序 = (ts DESC,
  kind [audit 先于 agent], id DESC)；跨源同 instant 的边界语义显式化：边界是 audit
  → 同 ts 的 agent 全部落入下一页；边界是 agent → 同 ts 的 audit 已全部加载。
  响应新增 next 游标（null = 历史已翻尽）。**顺带修复真实产品缺陷**：合并排序的
  比较器在 ts 相等时双向返回 -1（不一致比较器），同 instant 跨源条目顺序由排序
  实现内部决定——即使没有分页也会随机乱序；改为相等返回 0 + 稳定排序保证
  audit 先于 agent。测试的等集断言正是靠这个缺陷暴露的。
- 提案批量审核：reviewProposal 抽为共享核心（锁 + pending 状态机 + jsonb 审核
  回执合并，单条与批量同一路径）；POST /projects/:id/proposals/batch-review
  （≤50 条，逐条独立判定、逐条如实回执 ok/status 或 code/message，同批重复或
  已处理条目标 PROPOSAL_NOT_PENDING 不中断，幽灵 id 标 NOT_FOUND）。
- UI：动态页「加载更早」按钮（游标追加、按 key 去重、翻尽显示「已加载全部动态」，
  实时推送与分页共存互不干扰）；「Agent 提案」批审条（全选/已选计数/批量接受/
  批量忽略，逐行错误如实回显）。
- 测试 tests/m20（3 项，真实集成）：SQL 造 3 运行 + 7 审计（含 run 与 audit **同一
  instant** 的跨源并列）→ 以 limit=3 逐页翻完：页数收敛、并集恰为 DB 全集、每条
  恰好一次、页间单调不越界；游标三类不合法格式如实 422（不静默从头重放）；批量
  审核（成功 2 + 幽灵 NOT_FOUND + 同批重复 PROPOSAL_NOT_PENDING、审核人与备注
  留痕、非成员 404 且数据未动、51 条 422、单条路径 409 状态机不回归）。
  全量：`npx vitest run` **27 套件 142 项全部通过**（63s）。
- 浏览器实测：动态页 26 条历史、限 20 条 → 「加载更早」点击后补齐至最早一条、
  按钮消失显示「已加载全部动态」；⌘K 派真实 DeepSeek 任务调用 proposal.create
  两次（提案 28881c6f…、5cd61e5c…）→「Agent 提案」全选 → 批量接受 → 待审清空、
  已接受视图两条均带审核人留痕。

### EV-043 ｜ 2026-09-21 ｜ M21 迭代轮：候选导入去重 + NL 图谱聚焦
- 两处日常动线打磨：① 同一段文本反复抽取/入队会在审核队列堆积完全重复的候选
  （确认过的关系再被提议也会产生新待审项）；② 图谱聚焦模式（M13）只能先进图谱
  再手动选资产，无法从自然语言直达。
- 导入去重（队列卫生）：POST /semantic/candidates/import 逐条检查同（团队，类型 +
  端点文本）是否已有 pending/confirmed 候选——pending 是重复待审、confirmed 说明
  关系已成立，都拒入；dismissed 放行（被否决过的候选允许重新入队重审）。
  响应新增 skipped 与 duplicateIndexes，逐条如实回执，部分跳过不伪装全部成功。
- NL 图谱聚焦：NlIntent 白名单新增 assetName（仅 page=graph 时有意义）；L1 规则
  三种句式（「聚焦X的图谱」「打开X的关系图谱」「图谱聚焦：X」，书名号/冒号兼容）
  与纯「打开图谱」无冲突；L2 提示词同步教给模型。Workbench 将 assetName 经
  /assets/search 解析为资产（精确名优先，退回首个命中），注入 RelationGraph 的
  initialFocusId 进入聚焦模式；解析失败如实 flash「未找到资产」，不静默装作聚焦。
- 测试 tests/m21（3 项，真实集成）：去重状态机全链（首入 2 → 原样重入 0/2 跳过
  并标注意见 → 确认后仍拒入 → 忽略后放行重入 + 新键不受影响 → 待审恰一条）；
  聚焦三句式 L1 命中 + 「打开图谱」「打开提案页」回归；真实 DeepSeek 口语指令
  「帮我在关系图里聚焦看看推进模块接口文档」经 L2 白名单解析为 navigate graph +
  assetName。全量：`npx vitest run` **28 套件 145 项全部通过**（61s）。
- 浏览器实测（真实 worker + DeepSeek）：⌘K「聚焦推进模块接口文档的图谱」→ 规则
  解析卡片「聚焦「推进模块接口文档」的关系图谱」→ 执行后图谱页聚焦资产已选中、
  1 跳邻域（2 节点 3 关系）；语义工作台真实抽取 4 条候选（LLM 增强）→ 首次入队
  显示「已入队 2 条；跳过重复 2 条」（M18 确认过的同键候选被拒）→ 再次入队显示
  「已入队 0 条；跳过重复 4 条」。
