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
