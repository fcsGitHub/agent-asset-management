# M67 调研笔记：候选清单一次清偿（七项一轮）

用户指令「一轮完成所有候选项」——把 M66 后候选清单全部落地。锚点与边界逐项：

## ① 派生血缘字段（HF base_model）

HuggingFace model card 的 YAML metadata 支持 `base_model: org/name`（可多个），
派生模型页面据此自动渲染 "Model tree" 上游并计入 ancestor 计数——**血缘是属性里
的一段文本，平台负责把它变成可查询的图边**。教训：真实团队里用户极不可能手填
两边（属性写一次、再到关系页建一次 derivedFrom 断言），所以平台要么推导要么
物化。推导（读侧虚拟边）会让图/计数/打包深度全部要特判虚拟边，分叉大；我们选
**物化**：属性声明为提示（hint），用户在详情页一键把 base_model 引用物化为
derivedFrom 断言（走既有 createRelationAssertion——domain/range、禁环、重边防护
全部复用）。解析口径保守：名称精确（大小写不敏感）或别名精确；模糊命中不自动
建边（误连血缘比少连更糟，HF 也是显示为链接而非自动建树）。已有同边如实报
already，解析不到如实报 unresolved，不静默跳过。

## ② 属性自定义筛选器（OpenMetadata）

OpenMetadata Explore 支持按任意 entity 属性（含自定义 property）过滤——目录不该
只有平台预设的几个筛选维度。我们的实现：`/assets/search?prop=key=value`（可重复），
SQL 侧 `r.properties->>$n = $m`（操作符右参可参数化，无注入面），作用于 head 修订
属性。格式非法整体 400 并列出问题项（不静默丢弃）。UI 在目录筛选行加一个输入框
（空格分隔多项），与既有 URL 化筛选一并恢复/写回——`?view=assets&prop=owner=alice`。
边界如实：值比较是文本等值（不是范围/正则）；嵌套 key 不支持（一级属性）。

## ③ 分类沿血缘传播写侧（Atlas，治理确认流）

Apache Atlas 的 classification 沿 lineage 自动向下游传播（propagated
classifications）——治理标签打了上游，下游全链生效。但 Atlas 的自动传播在多租户
协作场景有个著名痛点：**错了会蔓延且难以撤销**。我们的取舍：不做自动传播，做
**两步确认的显式传播写侧**——GET 预览（沿 derivedFrom 边 BFS 到全部下游，逐资产
给出「将新增哪些标签」）返回 planDigest；POST 必须带回 confirmPlanDigest（摘要
不符 409，防预览与执行之间拓扑变化，同 C08 share-check 的 TOCTOU 口径）。传播的
是**源资产当前标签**（保守语义：中间节点自己加的标签不再级联，文档如实写明）。
执行直接落 asset_labels（ON CONFLICT DO NOTHING）并递增 meta_version——元数据
ETag 乐观并发不被传播写偷偷绕过。默认关系族=derivedFrom（写侧从血缘传播，不沿
dependsOn 扩散治理标签）。

## ④ 别名进 ⌘K

npm dist-tags / MLflow @alias 的价值在「稳定短名进一切取用入口」。我们的搜索
（M55 起）已命中别名，但 ⌘K 结果行只显示资产名——用户搜别名看到命中的却是另一个
名字的资产，无法理解为何命中。修法：search 行级返回 matched_alias（该资产命中
q 的第一个别名），⌘K 与 @ 引用候选行的副标题显示「别名 xxx」。纯显示层补全，
不改评分。

## ⑤ 集合只读分享快照（Zenodo/HF snapshot 思想）

Zenodo DOI / HF git-tag snapshot 的共同语义：**分享出去的是冻结版本，后续改动
不影响已分享内容**。实现：POST /collections/:id/snapshots（管理权=创建者或管理
员，分享是治理动作）把集合当前「名称/描述/条目（名称、类型、版本、生命周期、
备注、head 内容摘要）」深拷贝进 asset_collection_snapshots（payload jsonb），签发
128-bit 随机 token；GET /share/collections/:token **免登录只读**。隔离设计：新表
RLS 双策略——租户策略（写侧照旧）+ `public_share_read`（仅当事务内
`SET LOCAL app.share_read = 'on'` 才可 SELECT）；该 GUC 只有分享端点这一个代码
路径会设置，其余端点照常被租户策略拦住，跨团队不可见。快照不含 teamId/用户
id/制品内容（只有元数据与内容摘要），集合删除后快照保留（无 FK，冻结语义）。
不可变：无 UPDATE/DELETE 授权（COLLECTION 快照只能新建）。

## ⑥ Agent 对话区可折叠

kimi-code/VS Code 侧栏惯例：面板可一键收起成细条、展开还原（状态记忆）。实现：
AgentPane 加 collapsed 属性——收起时提前 return 只渲染细条与展开按钮（组件保持
挂载，SSE 订阅与输入状态不断线），Workbench 记 localStorage 并隐藏拖动分隔条。

## ⑦ 完整度汇总页（TechInsights 水位）

Backstage TechInsights 的团队视图是「水位 + 拖后腿清单」而非逐行分数罗列。实现：
GET /assets/completeness-summary——复用 search 的行级打分管线，聚合出 count/
average/三档分桶（80+ 绿、50-79 黄、<50 红，与详情卡同阈值）+ 低分清单
（score<60 升序、最多 20 条、每条带未过项标题）。目录页顶部水位卡呈现，低分条目
可点开直达详情补元数据。

## 范围外（如实记录）

- AI 草稿质量反馈环：仍缺真实使用样本，本轮继续不做（不伪造样本）。
- 属性筛选的范围/正则算子、嵌套属性：记为后续候选（等值先满足绝大多数治理筛选用）。
