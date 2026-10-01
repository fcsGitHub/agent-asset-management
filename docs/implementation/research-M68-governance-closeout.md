# M68 调研笔记：治理收口轮（三项）

M67 清偿了候选清单，走查发现三个收口缺口——都是「能力有了、治理出口没跟上」
的典型。锚点与边界逐项：

## ① 分享快照吊销（Zenodo/GitHub token revoke 治理出口）

M67⑤ 的快照设计是不可变 + 无 UPDATE/DELETE 授权——但这带来一个真实安全缺口：
**链接一旦泄漏就永远有效**。GitHub PAT / Zenodo 版本管理都把「可吊销」作为分享
能力的配套治理出口（secret scanning 的核心闭环是 revoke，不是假装不泄漏）。

实现：迁移 0028 加 `revoked_at`/`revoked_by` 两列，**列级 UPDATE 授权**
（`GRANT UPDATE (revoked_at, revoked_by) ON asset_collection_snapshots TO taw_app`）——
payload/token/创建信息在 DB 层仍然不可改（列级授权下 UPDATE 其他列直接
permission denied），吊销是唯一被授权的更新路径，代码与数据库两层都说得通。
POST /collections/:id/snapshots/:snapshotId/revoke（管理权=创建者或管理员，
与创建分享同级）；公开端点对已吊销 token 返回 **410 SHARE_REVOKED**（Gone 语义
如实：不是 404 装不存在——持有者应知道链接被主动吊销而非猜错地址）；团队内
快照清单标注已吊销；重复吊销幂等 ok。吊销动作本身进审计（见③）。

## ② 属性筛选算子扩展（OpenMetadata 完整口径：范围 + 嵌套属性）

M67② 记录的边界：只支持一级属性文本等值。OpenMetadata Explore 实际支持任意
自定义属性的范围过滤与嵌套字段。补齐：`prop=key=value`（文本等值，不变）、
`prop=key>=value` / `prop=key<=value`（数值范围）、key 支持**点号嵌套路径**
（`metrics.accuracy>=0.9` → `properties #>> '{metrics,accuracy}'`）。

SQL 安全边界：范围比较用 `CASE WHEN 文本 ~ 数值正则 THEN ::numeric ELSE NULL
END`——非数值属性行被排除而不是抛错（PG 直接 ::numeric 会对坏数据 22P02）；
路径与值全部参数化（#>> 右参是数组参数，无注入面）。解析器按最早算符位置切分
且优先匹配两字符算符（`>=` 不会被切成 `>` + `=x`）。M67 的等值语义与非法项
点名行为完全保留（同键后项覆盖规则不变）。

## ③ 治理动作进团队动态（事件溯源红利：audit_events 零新表）

M67 的三个治理写动作（血缘物化、标签传播、快照创建/吊销）不产生任何团队可见
痕迹——协作平台里「谁改了什么」与「改了什么」同等重要（GitHub audit log /
GitLab 的所有治理动作进 activity feed）。项目既有架构是现成的：动态流直接读
append-only 的 audit_events + agent_runs（M16 人机混排时间线），动作中文名
从服务端 ACTION_LABELS 下发（前端不硬编码副本）。

落地：四个动作写审计（团队级，project_id=NULL 同资产归档口径）——
`asset.lineage_materialize`（物化血缘关联）/ `asset.labels_propagate`（沿血缘
传播标签）/ `collection.snapshot_create`（创建分享快照）/ 
`collection.snapshot_revoke`（吊销分享快照）；ACTION_LABELS 与 ⌘K 动态跳转名
同步补条目。detail 里放治理决策所需的事实（物化了哪几条引用/传播了几个下游
几个标签/快照 token 与条数/吊销了哪个快照）。

## 范围外（如实记录）

- AI 草稿质量反馈环：仍缺真实使用样本，继续搁置（不伪造）。
- 快照「过期时间」：需要定时判定基建（读取时比对 expires_at 可做，但到期
  自动清理属调度范畴）——本轮只做主动吊销；expires_at 记为后续候选。
- 属性筛选 OR 组合/正则：语法复杂度陡增（需括号语法），等值+范围已覆盖治理
  主流场景；记为后续候选。
