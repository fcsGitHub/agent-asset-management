# M71 调研笔记：本体关联的资产管理（跨门类搜索 / Agent 本体操作 / 目录防抖动）

本轮目标（用户点名）：把资产管理与本体关联相结合，便于**跨门类搜索和管理**；结合
Agent 方便操作；调研同类产品；功能丰富 + 漏洞修复 + 交互优化（避免抖动等显示 bug）。

## 一、同类产品调研

> 现场注记：本轮 WebSearch 配额受限（周配额 2026-10-07 重置），Palantir 官方文档经
> WebFetch 直读成功（权威来源）；Atlas/DataHub/Wikidata/OpenMetadata 依据其公开文档
> 的既有领域知识整理，与 M49–M67 各轮调研同口径。

### 1. Palantir Foundry Ontology —— 语义层是组织资产的操作层
（来源：palantir.com/docs/foundry/ontology/overview，本轮实读）

- **Object Types / Properties / Link Types / Action Types / Functions**：把数据资产映射为
  带类型、属性、关系的业务对象；Action 是受治理的写回动作。
- **Interfaces（多态）**：描述「形状相同的一族对象类型」——按接口检索能命中全部实现
  类型。这正是**按父类检索应命中全部子类**的类闭包语义。
- **Object Explorer**：搜索对象后可按链接跳转（pivot to linked objects）、按类型过滤。
- **AIP Agent 经本体工具操作**：Agent 不碰原始数据，而是查询对象类型、执行受治理
  动作——**Agent 的第一入口是本体（类型层），不是单条资产**。
- 对位差距：本项目类型层次（M8 subClassOf）与关系注册表已有，但目录搜索的 type 过滤
  是**精确 type_key 匹配**——选父类搜不到子类资产，「接口/父类检索」能力缺席；
  Agent 工具里只有 graph.assetsByType 有闭包语义，通用 asset.search 没有；Agent 完全
  没有「浏览本体本身」（有哪些门类、某类型要填什么属性、哪些关系可连）的工具。

### 2. Apache Atlas —— 类型系统 + 业务术语表
（来源：atlas.apache.org 公开文档，既有知识）

- 类型系统：Entity/Classification/Relationship/Struct/Enum；**实体按类型检索**
  （basic search by type + 属性过滤，DSL `from hive_table where …`）。
- 业务术语表（Business Glossary）：**broader/narrower 层次术语**，术语可挂到任意类型
  实体上——跨类型的组织维度。
- 对位差距：本项目 asset_labels/categories 接近术语表，但类型浏览没有层次视图；
  术语/标签与类型层次是两套平铺下拉。

### 3. DataHub —— browse API 与分面
（来源：docs.datahub.com，既有知识）

- browse API 按**容器路径**组织实体，返回**分组 + 每组计数 + 总数**——浏览即导航。
- 搜索带 facet（类型/平台/标签），facet 由真实数据聚合而来。
- 对位差距：本项目 /assets/facets 的 typeKeys 是平铺 distinct 列表（无计数、无层次、
  不含空类型）；属性筛选（M67②）要求用户**记住属性键名**——没有「观测到的属性键」
  发现面（DataHub facet 思想：过滤器选项由数据聚合而来）。

### 4. Wikidata —— 类闭包检索的公共参照
- SPARQL `wdt:P279*`（subclass-of 传递闭包）是跨域实体检索的标准姿势：「属于某类或
  其任意子类的实例」。本项目 M49 已在图库实现 SUBCLASS_OF 闭包
  （graph.assetsByType），但 SQL 目录链路没用上。

### 5. OpenMetadata（前轮已吸收 prop-filter）——本轮再吸收一点
- 左侧导航按**实体类型树**浏览；glossary 术语可带同义词。
- 对位：目录类型下拉按层次分组展示（optgroup），父类型标注「含子类 N」。

## 二、吸收定稿（本轮五项交付 + 三处真 bug）

1. **目录搜索类闭包展开（①）**：`type` 过滤从精确匹配升级为类闭包（自身 + 全部子类
   type_key），SQL 递归 CTE 一致于 M49 图库闭包语义（Wikidata P279* / Foundry
   Interfaces）；search/export/summary 同源 queryAssetRows 自动一致。展开如实可见：行上
   `type_key` 仍是各自实际类型（不虚报为父类），闭包键集经 /ontology/tree 的
   subclassKeys/closureAssetCount 呈现（search 响应保持数组形状不破坏既有消费方；
   queryAssetRows 内部返回 typeClosure 供后续端点需要时取用）。**跨门类搜索核心**：
   选 simulation 门类基类能一次检索全部子门类资产。
2. **本体树端点 GET /ontology/tree（②）**：类型层次树 + 每类型资产计数 + 模式声明
   属性键 + 关系注册表（domain/range/断言数），UI 与 Agent 同源（Foundry Ontology
   Manager 思想）；树构建纯函数进 @taw/domain（可测）。
3. **Agent 本体工具（③）**：`ontology.types`（浏览门类树）/ `ontology.typeInfo`
   （某类型的链上必填字段、子类、适用关系、资产数）+ `asset.search` 类型闭包对齐
   ——Agent 第一入口从单条资产上移到本体层（Foundry AIP 锚点）。
4. **属性键发现（④）**：facets 附观测属性键 top50（head 修订 jsonb_object_keys 聚合，
   DataHub facet 思想），UI 属性筛选框挂 datalist——跨门类公共键（owner/platform）
   可发现、无需记忆。
5. **目录防抖动（⑥）**：stale-while-revalidate（筛选变更不再整表闪「加载中…」重挂
   载）+ 关键词/属性输入 300ms 防抖（每键一次请求 → 防抖后一次）。

真 bug 三处（本轮修）：
- **B1**：`/ontology/assets-by-type`（graph.ts）lifecycle 过滤仍是 M70 前旧口径——
  默认 active 视图排除已弃用资产，与 M70 修正过的目录/Agent 链路不一致（M70 漏改）。
- **B2**：目录页每次筛选变化 `setAssets(null)` 整表卸载闪「加载中…」，且关键词输入
  无防抖每键一次请求 + 一次 URL 写回（UI 抖动根因）。
- **B3**：`@taw/graph` sqlTypeClosure 递归段不过滤子版本 status，且 SQL 目录闭包与图库
  闭包两处实现各自为政——本轮统一为版本感知单一语义（根/子均须 active 版本）。

## 三、刻意不做（诚实边界）

- 类型多继承/接口类型（Foundry Interfaces 全量）：当前 subClassOf 单父模型够用，
  引入多继承是 schema 级改造，等真实需求。
- 术语表（glossary term）独立实体：labels/categories 已覆盖轻量场景，且 M67③ 已做
  沿血缘传播；单独 glossary 表是新产品面。
- 全文检索/语义向量检索（Foundry semantic search）：需要搜索引擎基建，非迭代轮粒度。
- 属性键建议进 Agent 工具：ontology.types/typeInfo 已带模式声明键；观测键聚合对
  Agent 回答价值有限，先服务 UI。

## 四、验证记录（实施后回填）

- **测试**：tests/m71-ontology-catalog.test.ts 八项——纯函数三（层次构建+闭包计数、
  展平+悬空父引用如实标注、关系分侧适配含空清单=开放语义）+ 端到端五（目录闭包：基类
  闭包 4 项含弃用/子类不反渗/未知类型空/导出同源 CSV 5 行/闭包×属性交集；本体树：层次
  + closureAssetCount 与目录一致 + 属性键/必填键 + 关系注册表 + 外团队 404；Agent 工具：
  ontology.types 闭包计数一致 / typeInfo 链上必填并集 + 适用关系 / asset.search 闭包对齐
  含未知类型空；属性键发现 owner=5/accuracy=3/fmiVersion=1 跨类型聚合；⑤B1 修复：
  /ontology/assets-by-type 默认视图 4 项、弃用排后、图同步前置 + SQL 回落闭包版本感知
  直查）。全量 71 套件 359 项全绿（M70 后 +1 文件 +8 测试，零回归）。
- **浏览器实测**（demo 团队 M71演示项目，三级层级 vehicle←sat←optical + 旁支 + 弃用项）：
  层次化类型下拉「m71demo.vehicle（4，含 2 子类）／　└ sat（3，含 1 子类）／　　└
  optical（1）」；选父类 → 提示行如实列子类与命中数 + 4 行跨类型命中 + URL type= 写回；
  弃用资产目录默认视图可见带徽标；本体页闭包检索卡（图数据库引擎，图同步后）4 项含
  弃用行且排最后（B1 修复前该行被排除）；**防抖动**：快速连打 5 字符仅 1 次
  /assets/search 请求、表格全程在位零「加载中」闪断（旧代码每键一次请求+整表卸载重挂
  载）、data-refreshing 半透明过渡态生效；属性键 datalist 下拉建议 owner（5 项在用）等
  四键；闭包×属性筛选 owner=Bob 唯一命中。截图三张：m71-ui-closure-catalog /
  m71-ui-closure-prop-filter / m71-ui-ontology-closure-deprecated。
- **环境注记**：走查中发现 4000/5175 被上一会话孤儿进程占用导致浏览器访问到旧代码
  （选项无闭包计数、检索不展开）——杀掉孤儿进程重启后全部通过；这不影响代码本身，
  但坐实了「浏览器实测必须对着本轮进程」的走查纪律。
