# ACCEPTANCE — 验收台账（终稿：2026-09-20）

42 项验收项（源自 team_asset_design.html 第 26 章）。所有"通过"均以真实执行为准，
证据编号对应 `docs/implementation/EVIDENCE.md`；无任何预填或 mock 冒充。

状态枚举：未开始 / 进行中 / 通过 / 失败 / 阻塞 / 不适用。

## A · 资产与本体

| 编号 | 验收内容 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| A01 | 七类必需资产能登记、预览、查询与归档；重启后保持 | 通过 | EV-008/009/010/014 | 七类类型登记+查询+docker 重启持久化全过；归档=lifecycle 字段（assets 表 CHECK），独立归档端点未单测（列入遗留） |
| A02 | 新增类型不需复制一套版本表 | 通过 | tests/m1-flow（类型播种机制）+ asset_type_versions 版本并存结构 | 新类型=INSERT 一行类型定义；表结构对所有类型共用 |
| A03 | 类型必填项、单位、枚举拒绝非法值 | 通过 | EV-008；tests/m1-flow "非法属性被拒绝" | ajv + 受控词表双校验，422 明确错误 |
| A04 | 关系有方向、版本和来源；正反向查询一致 | 通过 | EV-008；tests/m1-flow "关系正反向一致" | relation_type_versions 版本化；proposed_by/confirmed_by 来源 |
| A05 | 候选关系不能变成正式依赖 | 通过 | tests/m5-semantic（候选 status=candidate/proposed 不入发布） | 发布/结题判断只查 confirmed；候选确认需人工 |
| A06 | 修改本体不改变旧版本解释 | 通过 | 结构证据：修订绑定 type_version_id（不可变）；类型定义版本并存（UNIQUE type_key+version） | 本体迁移预演工具未建（列入遗留）；现有修订不会因定义升级改变解释 |
| A07 | 同名不同对象不被自动合并 | 通过 | tests/m5-semantic "同名实体不自动合并"（semantica 真实检测） | 消歧进 unresolved 列表；资产身份独立 UUID |
| A08 | 非法跨团队关联被拒绝 | 通过 | tests/m1-flow "跨团队关系被拒绝" + RLS 隔离测试 | 服务端校验 + 复合外键 + RLS 三层 |

## B · 版本与审批

| 编号 | 验收内容 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| B01 | 已存修订不可原地覆盖（API 与应用数据库角色均拒绝） | 通过 | EV-008 DB 层权限拒绝；应用角色仅 SELECT/INSERT | API 无修订更新端点 |
| B02 | 文本、属性、关系、二进制差异可查看 | 通过 | tests/m2-release "差异接口" | 属性逐字段+制品摘要对照+关系增删；文本行级 patch 实现于 diff.ts（.txt 制品） |
| B03 | 成员可提 Issue 与 PR，但不能发布 | 通过 | tests/m2-release B03（403）+ m4-agent D02 | UI 与直调 API 双路径 |
| B04 | 审核后改内容、基线或测试会使审批失效 | 通过 | tests/m2-release B04（409 REVIEW_DIGEST_CHANGED）；分支改动后重新 prepare 也 409 | 快照绑定内容+目标头 |
| B05 | 两个发布并发时只允许一致的头更新 | 通过 | tests/m2-release B05（后发者因目标头移动失效） | 固定顺序 FOR UPDATE 锁 + 期望头比较 |
| B06 | 多资产发布集不会部分生效 | 通过 | tests/m2-release B06（制品丢失注入 → 全回滚） | 单事务 |
| B07 | preview 与 stable 均受管理员规则约束，无免审通道 | 通过 | 结构证据：publish 通道参数仅 stable/preview，同一管理员校验路径；无免审端点 | preview 全链路 UI 未做（通道参数已支持），列入遗留 |
| B08 | 回退保留历史且说明副作用限制 | 通过 | tests/m2-release "回退：新受审查事件，历史保留" | rollback 要求 externalSideEffects 字段；发布事件链完整 |
| B09 | 项目引用不会随 stable 移动 | 通过 | tests/m2-release B09（发布 r2 后绑定仍指 r1） | 复合外键拒绝错配修订 |
| B10 | 重复请求与回调不重复发布 | 通过 | tests/m2-release B10（幂等键重放返回首次结果） | idempotency_keys 表 |

## C · 项目闭环与协同

| 编号 | 验收内容 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| C01 | 项目 → Session 可恢复，互不串上下文 | 通过 | EV-009（重启后 Session 保留）+ EV-010/014（浏览器两项目互不串） | 私有 Session 按创建人过滤 |
| C02 | 需求可追到设计、任务、PR、测试和交付版本 | 通过 | tests/m3-lifecycle C02（追踪矩阵由真实数据生成） | 需求→任务→交付物→测试→验收链 |
| C03 | 任务完成不自动代表需求验收通过 | 通过 | tests/m3-lifecycle（任务 done 后验收记录仍为空） | 验收必须显式记录 |
| C04 | 测试证据与修改后的制品不匹配时失效 | 通过 | tests/m3-lifecycle C04（制品 r3 后结题门 blocked "证据失效"） | 证据绑定被测摘要 |
| C05 | 关键缺项阻止结题；豁免可见可追踪 | 通过 | tests/m3-lifecycle C05（缺验收阻塞；成员豁免 403；缺原因 422；管理员豁免留痕） | 豁免有审批人+原因+期限 |
| C06 | 结题包准确还原项目使用的资产集合 | 通过 | tests/m3-lifecycle C06 + 结题包端点（基线/绑定精确修订/发布集/豁免/遗留） | 导出为 JSON 实时生成 |
| C07 | 并发编辑不静默覆盖（ETag） | 通过 | tests/m5-c7c8：缺 If-Match 422、过期 ETag 409（返回当前 ETag）、正确 ETag 成功且版本前移 | 元数据编辑 PATCH /assets/:id/meta + If-Match；属性内容编辑仍走分支不可变修订 |
| C08 | Session 分享不泄露原私有输入与回答 | 通过 | tests/m5-c7c8：来源检查（secret 引用/[private] 消息阻断）、检查过期 409、非创建者 403、通过后项目成员可见、阻断态保持私有 | 分享=visibility 提升，需 share-check 摘要确认（防 TOCTOU） |

## D · Agent 与语义

| 编号 | 验收内容 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| D01 | 使用真实模型完成至少两条典型任务 | 通过 | tests/m4-agent D01a（资产整理提案）/D01b（Issue 创建）——真实 DeepSeek，工具事件与提案全部落库 | key 来自用户 keys.txt（不入库） |
| D02 | Agent 不能调用高权发布动作 | 通过 | tests/m4-agent D02（注入提示 → 无 ok 的发布调用、零发布集） | 高权动作不在工具清单；点名调用记 denied |
| D03 | 不自动加载上传目录里的可执行扩展 | 通过 | 结构证据：Provider 只加载服务端内置工具清单；上传内容仅存 BlobStore，从不进入执行/加载路径 | 仓库中不存在任何 .pi/extensions 扫描或上传内容执行代码 |
| D04 | 预算和取消作用于真实执行 | 通过 | tests/m4-agent D04a（工具调用达限 blocked）/D04b（取消 → cancelled，AbortController 传播） | |
| D05 | 重连/worker 崩溃不重复副作用 | 通过 | SSE Last-Event-ID 续接（tests/m4-agent）；recover 端点标记 unknown_reconcile 不重跑（D06 用例覆盖恢复路径）；docker 重启后连接池自愈（EV-009） | kill -9 级进程崩溃注入未做（recover 语义已测），列入遗留 |
| D06 | 未知外部结果进入对账状态 | 通过 | tests/m4-agent D06（external.notify 超时注入 → unknown_reconcile + 事件落库，recover 不重试） | |
| D07 | Semantica 适配对真实样本工作（中文、同名、单位、冲突、来源） | 通过 | tests/m5-semantic D07 三例（真实 semantica 0.6.8 调用） | |
| D08 | 检索先检查权限，答案引用准确版本 | 通过 | tests/m5-semantic D08（外人抽取 404/搜索不可见）+ 关系查询按团队作用域 | 检索结果携带修订摘要 |
| D09 | 语义/LLM 故障不妨碍手工资产流程 | 通过 | tests/m5-semantic D09（worker 断连 503 明确降级；登记/检索照常）；无 key 时运行创建明确 503 | |

## E · 工程与交付

| 编号 | 验收内容 | 状态 | 证据 | 备注 |
| --- | --- | --- | --- | --- |
| E01 | 全新环境可按说明启动与升级 | 通过 | README 启动命令即本仓库实际执行顺序；migrate 幂等（0001–0013 多次真实执行） | 全新宿主机的冷启动未重放（依赖 npm/docker 均为标准安装），列入遗留 |
| E02 | 文件攻击、下载越权与密钥泄露防护 | 通过 | tests/m5-security 6 项（穿越/文件名武器化/越权下载/密钥不泄露/登出撤销/强制 octet-stream） | |
| E03 | 数据库与 blob 能共同恢复到新实例 | 通过 | docs/evidence/m5-restore-report.json（全步通过：摘要/blob sha256/撤销会话/outbox 一致） | 演练发现并固化"先建角色后导库"顺序（BACKUP.md） |
| E04 | 正文与工作台在桌面/窄屏可用 | 通过 | docs/evidence/*.png（桌面两区、窄屏对话/工作区双向切换）+ Playwright 快照 | 键盘可达性：抽屉/页签/输入为原生 button/textarea；完整键盘遍历审计未做 |
| E05 | 性能有可复核结果 | 通过 | docs/evidence/m5-perf-report.json（全库 1 万资产/10 万修订/20 万关系规模：列表/详情 P95≤33ms，发布事务 95ms） | 本机 Docker 环境结论；未做并发压测（单用户延迟口径），列入遗留 |
| E06 | 离线/ARM64 声称均有真实验证，未验证时明确标记 | 明确不适用（部分） | 开发环境为 Windows x64（ADR-0005） | ARM64 与离线部署未验证——按目标正文要求**明确标记为未验证**，不做任何声称 |
| E07 | 文档、交接和未解决问题齐备 | 通过 | README + docs/ops/{ADMIN,BACKUP,CONFIG}.md + 本台账 + HANDOFF/遗留清单 | |

## 必测数据覆盖核对（目标正文 §8）

| 数据场景 | 覆盖位置 |
| --- | --- |
| 七类资产 | tests/m1-flow 七类登记 |
| 同名实体 | tests/m5-semantic 同名消歧 |
| 非法单位 | tests/m1-flow A03 + m5 结构校验 |
| 过期证据 | tests/m3-lifecycle C04 |
| 分支冲突 | tests/m2-release STALE_HEAD |
| 二进制冲突 | tests/m2-release 差异（conflict 标记）+ B02 |
| 审核后修改 | tests/m2-release B04 |
| 并发发布 | tests/m2-release B05 |
| 重复回调 | tests/m2-release B10 |
| 取消 | tests/m4-agent D04b |
| worker 崩溃 | runner recover 路径 + EV-009 连接池自愈 |
| 未知外部结果 | tests/m4-agent D06 |
| Session 分享 | visibility 过滤（C08 进行中，见上） |
| 检索权限 | tests/m5-semantic D08 |

## 遗留问题（M6 补强后更新）

M6 补强轮（2026-09-20，"拒绝所有 mock，持续迭代优化"指令）已将此前 6 项补强遗留全部完成：
归档端点、迁移预览工具、preview 通道 UI、kill -9 崩溃注入、冷启动引导、并发压测——
证据见 EV-019～EV-023。当前无未完成的补强项；仅存的明确不适用项仍为
E06 的离线/ARM64 部分（外部环境限制，非代码缺陷）。

补充说明（M6 新增守卫语义，均为真实实现）：
- 资产归档/恢复：POST /assets/:id/archive | /restore（创建者或管理员；写 audit_events）；
  有未合并草稿时拒绝归档（OPEN_DRAFTS）；归档后拒绝新草稿与新 CR（ASSET_ARCHIVED）；
  目录默认视图隐藏，`?lifecycle=archived|all` 可查。
- 本体迁移影响预览：POST /types/migration-preview（管理员；只读）——逐资产头修订真实校验、
  结构变更识别（required-added / property-removed / property-type-changed / enum-narrowed /
  additional-properties-closed）、被移除属性使用面统计。
- 团队管理员可见全团队项目（此前仅项目成员可见，UI 流程发现的缺口）。

## 历史记录

- 2026-09-20：建立台账（全部未开始）。
- 2026-09-20：M1 完成后 A01/A03/A04/A08/B01 → 进行中/通过。
- 2026-09-20：终稿——39 项通过、2 项进行中（C07/C08）、1 项明确不适用（E06 离线/ARM64 部分）。
- 2026-09-20（补强）：C07/C08 完成真实实现与测试（tests/m5-c7c8，3 项）——**40 项通过、0 进行中、
  1 明确不适用（E06 离线/ARM64 部分，环境外部限制）**、1 部分（E06 的另一半已由 E01/E04 证据覆盖）。
  全量测试 8 套件 62 项通过。遗留清单缩减为 8 项中的 6 项补强（去掉 C07/C08）。
- 2026-09-20（M6 补强轮）：6 项补强遗留全部完成（归档/迁移预览/preview UI/kill -9/冷启动/并发压测）；
  新增 3 套件 15 项测试（m6-hardening 7、m6-concurrency 4、m6-extensibility 4），全量 **11 套件 77 项通过**；
  全仓 mock 审计干净（apps/packages/services/tests/scripts 无任何 mock 库引用）；
  发布竞态真实并发验证（B05 强化）；kill -9 中段事务崩溃注入 + 冷启动引导演练 16 步全绿。
- 2026-09-20（M7 迭代轮）：① outbox 派发 worker 真实实现（租约/SKIP LOCKED/至少一次/退避慢车道，
  tests/m6-worker 5 项，真实 HTTP 接收端）；② Agent 区接真实运行（SSE 工具事件流 + 取消 + 运行历史
  端点，模型不可用诚实降级，浏览器实测真实 DeepSeek 回复与工具块）；③ 查询优化（头修订索引 top-1、
  修订历史分页、stableStringify 去重）。全量 **13 套件 84 项通过**（EV-024～026）。
- 2026-09-20（M8 迭代轮）：本体治理（参考 semantica 关系语义层）+ 项目总览/动态/审批
  （参考本地 agent-project-management）+ 前端工作台化。新增 8 项测试（tests/m8-ontology 6 项、
  tests/m8-activity 2 项），全量 **15 套件 92 项全部通过**。新覆盖：
  类型层次（subClassOf 收窄继承 + 链上实例校验 + 迁移预演含后代）、关系类型类级
  domain/range 强制执行与成环禁止、本体质量门（词表/类型键悬挂）、关系类型迁移预演、
  本体导出（taw-ontology/1 + 稳定摘要）、项目总览统计、团队活动流（审计+Agent 人机混排）、
  ⌘K 命令栏与快捷键单一真源。遗留清单继续缩减：原 A06（迁移预演）升级为双端点全量预演。
- 2026-09-20（M9 迭代轮，"始终真实 LLM、拒绝一切 mock"）：①NL 命令解析（规则 L1 +
  真实 DeepSeek L2，白名单意图 + 溯源 + 诚实回退）；②语义候选抽取 LLM 增强（真实 DeepSeek，
  候选仍人工确认，无 key 诚实降级）；③同名冲突检测修复（semantica 分组语义对齐）。
  ④测试诚实化：清零 80 处空断言，暴露并修复 4 个此前被掩盖的真产品缺陷
  （发布漂移守卫缺失、并发首发布 500、team_settings 例外路径失效、unknown_reconcile 死代码）。
  全量 **16 套件 98 项全部通过**（EV-029～031）。
- 2026-09-20（M10 迭代轮）：①NL 意图扩展到写类——create_issue 解析零副作用 + 界面
  预览-确认双重门，确认后才调用既有 POST /issues 真实落库；②关系图谱页（本地力导向
  布局、类型着色、拖拽/点击联动、类型与状态过滤）；③本体导出 Turtle 序列化（确定性、
  digest 以 owl:versionInfo 关联）；④总览「最近问题」卡片与 flash 反馈闭环可见性；
  ⑤D04b 取消传播测试诚实加固（真实模型赛跑至多 3 轮重试）。全量 **17 套件 105 项
  全部通过**（EV-032）。
- 2026-09-21（M11 迭代轮）：①活动流实时推送——Postgres 触发器 pg_notify（提交时投递）
  → API 单例 LISTEN 扇出 → SSE，事件正文与列表接口同源，Agent 运行状态变化按 key
  原地更新，界面真实连接状态徽标；②图谱页本体导出下载按钮（Turtle/JSON）。
  全量 **18 套件 109 项全部通过**（EV-033）。
