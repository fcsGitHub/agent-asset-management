# 工作集 · Team Asset Workspace

小型团队（5–30 人）自托管的 LLM Agent 资产协同管理软件：文档、软件、仿真模型、仿真引擎、
测试库、Agent 库、场景七类资产统一身份与不可变修订；成员提出变更，管理员审核发布；
项目从需求受理走到结题，全程可追溯。

设计基线：`team_asset_design.html`（29 章）+ `team_asset_goal.md`（目标正文）。
实施台账：`docs/implementation/`（PLAN / CAPABILITY_MATRIX / ACCEPTANCE / EVIDENCE / HANDOFF）。

## 当前状态（2026-09-28）

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
| M19 实时层自愈 | activityHub 健康探测+退避重连+resync（运行流游标精确回填、活动流客户端重取）、LISTEN 连接可观测（application_name）、队列状态筛选视图、NL 打开提案页 | EV-041，tests/m19-* |
| M20 历史分页+提案批审 | 活动流键集分页（精确时间戳游标、同 instant 跨源边界语义、修复相等比较器缺陷）、提案批量审核（共享核心、逐条回执）、动态页加载更早、提案批审条 | EV-042，tests/m20-* |
| M21 导入去重+图谱聚焦 | 候选导入去重（pending/confirmed 拒入、dismissed 放行、逐条回执）、NL 图谱聚焦（L1 句式+L2 assetName、直达聚焦模式） | EV-043，tests/m21-* |
| M22 审计导出+单位校验 | 审计导出 CSV（共享分页核心全量遍历、audit.export 盖章、RFC 4180+BOM、上限如实截断）、登记类型单位词表在线校验（实时 ⚠/✓） | EV-044，tests/m22-* |
| M23 入队预演+批量备注 | 入队前去重预演（planImport 与真实入队同源判定：队列已有/批内重复跳过、dismissed 放行、只判不写）、提案批量审核备注留痕 | EV-045，tests/m23-* |
| M24 动态过滤+导出 JSON | 动态按 action 过滤（列表/翻页/导出/SSE 同源，选项同源下发）、审计导出 JSON（结构化条目、truncated 如实标注、盖章带格式与过滤范围） | EV-046，tests/m24-* |
| M25 跳数记忆+批量重映射 | 图谱聚焦跳数记忆（localStorage、容错回退）、队列候选批量重映射端点（空侧不改、仅改映射不自动确认） | EV-047（纯前端，无新增测试） |
| M26 时间范围+NL 过滤+提案 diff | 导出/列表时间范围（同源闭区间、窗口翻页、盖章记录范围）、NL「看归档记录」直达过滤视图（L1+L2 白名单）、提案与现有资产 diff 对比 | EV-048，tests/m26-* |
| M27 审计详情+队列导出 | 审计条目详情（回执原文按需拉取、动态页展开）、语义队列导出（CSV/JSON×状态过滤、semantic.queue.export 盖章） | EV-049，tests/m27-* |
| M28 队列导出件回导 | 导出件回导入队（planImportDedup 三端点同源、per-item assetName 跨团队解析、unresolved 如实标记、幂等） | EV-050，tests/m28-* |
| M29 CSV 回导+图谱快照 | 回导件兼容 CSV（宽容 RFC 4180、与 JSON 同管线、转义往返）、图谱 SVG 快照导出（样式内联独立文件） | EV-051，tests/m29-* |
| M30 操作者筛选+PNG 导出 | 按操作者过滤（与项目×动作×时间正交同源、actors 同源下发、导出/盖章/实时同口径）、图谱 PNG 位图导出（2x） | EV-052，tests/m30-* |
| M31 实测走查修复 | 关系断言防重（API 守卫+0022 唯一索引+存量清理）、关系撤回端点（权限口径+审计盖章+动作标签同源）、worker .env 加载器（防 LLM 环境丢失）、走查发现的过时文案修正 | EV-053，tests/m31-* |
| M32 生命周期走查修复 | 项目成员添加（端点+UI+盖章）、发布快照兜底、回滚 UI（release-sets 历史+管理员按钮）、摘要口径修正；作者分离/成员禁发实测确认；worker 计划任务托管 | EV-054，tests/m32-* |
| M33 UI 全面翻新 | 设计令牌双主题（浅/暗、跟随系统+手动覆盖、首帧防闪烁）、Agent 对话区对标 kimi-code desktop 重写（气泡/状态药丸/工具卡渐进展开/流式 Markdown/贴底滚动/输入法保护）、自研零依赖安全 Markdown 渲染器（无 dangerouslySetInnerHTML）、SVG 图标集；修复历史运行正文丢失与时间线倒序 | lib/markdown 单测 7 项，详见 HANDOFF |
| M34 @ 引用+工具网关健壮性 | Composer @ 资产检索引用（chips 随运行落库 context_refs、历史时间线重建）；工具调用 SAVEPOINT 隔离（单工具 SQL 失败不再毒化整轮事务）；asset.getRevision 缺省读 head | tests/m33 三项 |
| M35 全页面视觉走查 | 全部页面 × 亮/暗双主题真实用户走查；修复资产目录搜索行被挤压缺陷 | 全量保持全绿 |
| M36 会话管理 | PATCH /sessions/:id 改名/归档（创建者或管理员、FOR UPDATE 防竞态）、已归档会话折叠区可恢复、回复复制按钮、SSE 断线重连如实提示 | tests/m34 五项 |
| M37 运行状态药丸 | 顶栏静态「已连接」替换为真实运行状态药丸（空闲绿点/流式琥珀脉冲）；「提交整理提案」真实链路与深色主题走查 | 浏览器实测 |
| M38 思考过程可视化 | 多轮运行的中间 assistant 文本收入可折叠「思考过程（N 轮）」块；发布与通道带真实数据走查（作者分离确认） | 浏览器实测 |
| M39 布局自主调节+语义候选走查 | 对话/工作区可拖拽分隔条（持久化、键盘微调、双击复位）；语义候选真实抽取→确认/忽略全链路走查 | 浏览器实测 |
| M40 运行预算实时可视化 | 修复预算默认值从未生效（zod `.partial()` 吞 default，存量运行预算闸门形同虚设）；usage 事件实时用量条（工具次数/tokens/阈值变色）；历史端点补 budget | tests/m40 三项 |
| M41 工具卡资产直达 | lib/toolRefs 从工具参数/结果解析资产引用，工具卡展开区「相关资产」chips 点击直达详情 | lib 单测 4 项 |
| M42 待办徽标 | 审批导航琥珀角标、「语义候选」「Agent 提案」标签待处理计数徽标（与列表端点同源，轮询+变更事件即时刷新） | 浏览器实测 |
| M43 CR 冻结差异视图 | CR 详情变更项携带 base/candidate 固化修订 diff（复用 domain diffRevisions），发布/通道 CR 详情可展开差异卡片 | tests/m43 |
| M44 正文资产名链接化 | Markdown 渲染器 renderText 钩子 + lib/linkifyAssets：回复正文/思考过程命中资产名渲染为行内链接；修复消息先响应后提交的 read-your-writes 竞态（C08 偶发失败根因） | lib 单测 6 项 + m5-c7c8 加固 |
| M45 审批队列复用差异视图 | 差异组件抽为共享 CrDiff.tsx，审批队列与发布/通道同一组件同一数据源，无第二份实现 | 浏览器实测 |
| M46 用量汇总+图谱平行边 | 顶栏会话用量药丸（近 20 次运行 Σ tokens）；资产详情「在图谱中查看」补齐导航闭环；平行边车道分配修复边与标签全部叠合 | 浏览器实测 |
| M47 CR 评审留痕 | CR 详情补 comments（退回原因自 M2 落库但一直无端点无界面可见），共享留痕区在审批队列与发布/通道两处展示 | tests/m43 增项 |
| M48 空会话引导提示词 | 空态三张可点击任务卡（检索总结/整理提案/关系缺口检查）经 send(override) 直达真实运行 | 浏览器实测 |
| M49 图数据库本体检索层 | Memgraph 投影（类型层次/资产/存活关系）+ worker 脏标记对账重建；类闭包/按类检索（图引擎，离线回落 SQL 并如实标注）、多跳邻域、两资产最短路径（图库边集+应用 BFS）；本体页检索卡（状态徽标/手动同步/资产直达），写路径同事务盖脏标记（0023） | tests/m49 十项 + worker 漂移对账实测（1859 团队/293 重建/0 失败） |
| M50 Agent 图检索工具 | 工具网关新增三只读工具：graph.assetsByType（类闭包检索，离线回落 SQL 如实标注 engine）、graph.path（两资产关联路径，assetId/名称两用，歧义列候选）、graph.neighbors（多跳邻域）；闭包解析抽为 @taw/graph resolveTypeClosure 与 API 路由同源；toolRefs 泛化使图工具卡带「相关资产」chips | tests/m50 八项 + 真实 DeepSeek 走查（问出 2 跳关联链与闭包检索，引擎标注如实） |
| M51 NL 关联路径直达图谱 | ⌘K 说「A和B怎么关联/A与B有什么关系/从A到B的路径」→ L1 规则（引号/查一下前缀容错）或 L2 白名单（新增第五意图 graph_path，缺端不通过）→ 图谱页路径模式：横幅链条（relKey 箭头按真实方向、节点可点）+ 链上边加粗提色/其余暗化 + 退出按钮；未找到/图库离线如实横幅提示；空会话任务卡新增关联路径示例 | tests/m51 八项 + 浏览器实测（一句话直达高亮 2 跳链路） |
| M52 资产详情多跳关联 | 资产详情新增「多跳关联（图数据库）」卡：跳数 1–3 可选，graph.neighbors 邻域 + 前端 BFS（lib/hopChains 纯函数）为每个关联资产生成从本资产出发的最短关联链（relKey 箭头按真实方向，终点可点直达）；图库停机 503/投影滞后如实提示、恢复自愈 | lib 单测 4 项 + 浏览器实测（含 docker stop 图库降级→恢复自愈） |

当前测试基线：49 套件 230 项全部通过（45 个 `tests/` 集成套件 + 4 个前端 lib 单测套件；M31 起以 vitest 文件数为准）。M33–M52 迭代明细见 `docs/implementation/HANDOFF.md`。

## 环境要求

- Node ≥ 22（开发使用 v24.11.1）、npm 11
- Docker（Linux 容器）+ `pgvector/pgvector:pg16` 镜像
- 图数据库（可选，M49 本体检索）：`memgraph/memgraph:2.19.0` 镜像；不启动时系统诚实降级（闭包检索回落 SQL，多跳/路径端点 503）
- Python 3.11 + `services/semantic-worker/requirements.txt`（可选：语义增强关闭不影响核心流程）
- DeepSeek API key（可选：Agent 功能需要；其余功能不需要）

## 启动（以下命令均在本仓库实际执行过）

```bash
# 1) 安装依赖（lockfile 固定版本）
npm install

# 2) 配置环境变量（key 不入库；.env 已在 .gitignore）
cp .env.example .env
#   编辑 .env：DEEPSEEK_API_KEY=你的 key；其余开发默认值可直接用

# 3) 启动 PostgreSQL（端口 5437，数据在 docker 卷 taw_pgdata）与图数据库（可选，本体检索 7687）
docker compose up -d postgres graphdb

# 4) 数据库迁移（0001–0023，幂等）
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
npx vitest run                    # 全量测试（49 套件 230 项：tests/ 集成 + lib 单测，需 PostgreSQL 运行中）
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
packages/graph/     图数据库投影与检索（Memgraph/Bolt；闭包·邻域·路径·对账）
services/semantic-worker/  Python 语义服务（真实 semantica 0.6.8 适配）
migrations/          0001–0022 SQL 迁移（含 RLS 与受限应用角色）
scripts/             迁移、冒烟、端到端、恢复演练、性能
tests/               vitest 集成测试 + 前端 lib 单测（真实 PG/HTTP/LLM）
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
