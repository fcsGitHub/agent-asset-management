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
