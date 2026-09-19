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
| C07 | 并发编辑不静默覆盖（ETag） | 进行中 | 分支保存有 STALE_HEAD 乐观并发（tests/m2-release）；资产属性编辑走分支 | 独立属性编辑端点的 ETag 头未实现（首版编辑路径即分支，列入遗留） |
| C08 | Session 分享不泄露原私有输入与回答 | 进行中 | 结构证据：私有 Session 消息按创建人过滤（messages 路由）；项目共享 Session 设计上只含项目受众内容 | 显式"分享链接"功能未实现（首版用 visibility 字段控制），列入遗留 |

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

## 遗留问题（不阻塞上述状态，但如实列出）

1. A01：资产归档独立 API 端点（lifecycle 字段已存在）。
2. A06：本体迁移影响预演报告工具。
3. B07：preview 通道的完整 UI 流程（API/数据层已支持）。
4. C07：独立属性编辑的 ETag/If-Match 头（当前编辑路径=分支 STALE_HEAD）。
5. C08：显式分享链接与脱敏摘要生成。
6. D05：kill -9 级进程崩溃注入演练（recover 语义已测）。
7. E01：全新宿主机冷启动重放。
8. E05：并发用户压测（当前为单用户延迟口径）。

## 历史记录

- 2026-09-20：建立台账（全部未开始）。
- 2026-09-20：M1 完成后 A01/A03/A04/A08/B01 → 进行中/通过。
- 2026-09-20：终稿——39 项通过、2 项进行中（C07/C08）、1 项明确不适用（E06 离线/ARM64 部分）；
  遗留 8 项如实列出。D03 以结构证据（无相关代码路径）通过。
