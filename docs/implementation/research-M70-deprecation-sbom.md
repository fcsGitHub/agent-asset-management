# M70 调研笔记：资产弃用与继任治理 + SBOM 标准导出

M69 后无挂账候选。本轮主题回到「资产管理的形式调研」：M53/M54 两批调研已覆盖
DataHub/OpenMetadata/Atlas/NetBox/CKAN/OpenCTI/HF/MLflow/Dataverse/Zenodo/
Backstage/Terraform/npm 十三家平台，但每家都只吸收了各自最亮眼的一两个形态。
本轮沿两条线深挖还没吸收透的治理形态：**弃用（deprecation）生命周期**与
**SBOM（软件物料清单）互操作标准**。

## ① 资产弃用与继任治理（MLflow / Docker Hub / HF / Dependabot 锚点）

### 调研发现

- **MLflow Model Registry**：版本有 Staging/Production/Archived 阶段；2.9 起
  stages 被标记弃用、推荐 aliases（`@prod` 可重指，M55 已吸收别名思想）——但
  「显式标记某版本不要再用了 + 指向替代」这个形态本身没有过时，弃用是治理刚需。
- **Docker Hub deprecated images**：弃用镜像仍可拉取，页面显著警告 + 描述里给
  替代镜像——「弃用 ≠ 删除，弃用 = 可见 + 警示 + 迁移指引」。
- **Hugging Face deprecated models**：模型卡 `deprecated: true` 字段 + 搜索结果
  仍出现但带标签 + 常配「Use this model instead」继任指引。
- **GitHub Dependabot deprecation alerts**：不只是标记——依赖它的下游会收到
  告警（「你依赖的东西弃用了」）。弃用状态要沿依赖链传播为读侧提示。

### 本项目坐实的缺口（真 bug 性质）

`assets.lifecycle` 的 CHECK 约束自基线（0002）就有
`('active','deprecated','archived')` 三态，前端也备好了「已弃用」徽标与文案——
但 **deprecated 全链路不可达**：

1. 没有任何端点能把资产标成 deprecated（只有 archive/restore）；
2. `queryAssetRows` 的 `CASE WHEN $4='archived' THEN 'archived' ELSE 'active'`
   把 deprecated 当 archived 一样悄悄过滤（若手工置位，目录直接消失）；
3. Agent `asset.search` 硬编码 `lifecycle='active'`，弃用资产对 Agent 不可见；
4. M53 的 facets 端点 `lifecycle <> 'archived'`（含 deprecated）与目录默认视图
   （只含 active）口径不一致。

### 实现口径（迁移 0030 + 应用层修正）

- **语义分层**：弃用 = 目录仍可见（带警示）+ 下载/引用/Agent 读取不受阻 +
  继任者指引 + 可逆；归档 = 隐藏 + 禁草稿终态。两态不再共用一条过滤路径。
- 迁移 0030：`deprecated_at / deprecated_by / deprecation_note /
  successor_asset_id`（复合 FK 保证继任者同团队）。
- `POST /assets/:id/deprecate`（note 必填 + successorRef 可选：名称精确→别名
  精确，与 Agent resolveAssetRef 同语义；未解析 422、自身 409、归档态 409
  ARCHIVED_STATE）；重复弃用 = 幂等更新原因/继任者（审计如实标 repeated）；
  `POST /assets/:id/undeprecate` 清空回 active。权限与归档同口径（创建者或
  管理员），meta_version 递增（不绕过 ETag 乐观并发），图投影盖脏标记。
- 可见性修正：lifecycle 过滤 `active`（默认）= active+deprecated、新增
  `deprecated` 单看；search/summary/export 三端点同源（parseLifecycle 共用）。
- Agent 如实可见：`asset.search`/`graph.assetsByType` 返回 active+deprecated
  （lifecycle 字段如实标注、弃用排后）；`asset.getRevision` 读取弃用资产附
  `deprecation: {warning, note, successor}`——Agent 转述告警而不是静默读走
  （Dependabot 锚点）。顺带修通用 asset.search 从不过滤归档资产也不带
  lifecycle 的缺口。
- UI：详情弃用横幅（日期/原因/继任者直达链接，继任者自身已弃用也如实提示）、
  「弃用资产…/取消弃用」按钮、目录「仅已弃用」筛选（URL 化）、依赖告警文案
  区分「已弃用（请查继任者）」与「已归档」。
- 审计：`asset.deprecate`/`asset.undeprecate` 盖章进动态，动作名进过滤下拉
  与 ⌘K NL 白名单（「看弃用记录」L1 句式）。

## ② SBOM 导出（OWASP CycloneDX 1.5 锚点）

### 调研发现

软件物料清单（SBOM）是资产/供应链管理互操作的事实标准（SPDX 与 CycloneDX
两大家；美国 2021 行政令后采购合规标配）。CycloneDX 1.5 新增
`machine-learning-model` 与 `data` 组件类型——与本项目「仿真模型/引擎/测试库/
文档/Agent 库」七类资产天然对位。SBOM 的核心结构：`components[]`（每个组件带
bom-ref/type/hashes）+ `dependencies[]`（ref → dependsOn 依赖图）——恰好是
本项目「资产 + confirmed 关系闭包 + 制品 sha256」的标准化投影。M58 的 bundle
manifest 是自定义格式（面向离线取用），SBOM 是同一份数据面向供应链工具的
标准视图，两者互补。

### 实现口径

- `@taw/domain/sbom` 纯函数：`typeKeyToComponentType`（七类→CycloneDX 组件
  类型，未识别回落 application、原键如实入 properties）+ `buildSbom`
  （bom-ref 确定性规则 `urn:taw:asset:{id}@r{seq}`；dependsOn 只列闭包集内
  出边目标——截断如实收窄、不虚报；每个集合内资产都有 dependencies 条目，
  空数组显式区分「无依赖」与「未知」；制品 sha-256 进 hashes；taw:* 属性带
  类型/生命周期/修订摘要，弃用时附 note/successor 供消费方告警）。
- `GET /assets/:id/sbom?depth=1..3`（默认 1=直接依赖；方向固定 out：
  dependsOn=依赖方→被依赖方，与 derivedFrom 断言方向一致）；attachment 文件名
  RFC 5987（中文资产名）；主体计一次 download 使用热度；`asset.sbom` 审计盖章
  （detail 记格式/深度/组件数），动作名进动态过滤与 ⌘K。
- 详情页「导出 SBOM」直链按钮（与 bundle/BibTeX 同区）。

## 顺带修复的真 bug

1. deprecated 枚举不可达（上文 4 点，本轮主体）。
2. facets 与目录 lifecycle 口径不一致（facets 含 deprecated 而目录默认视图
   不含——目录修正后自动对齐）。
3. Agent 通用 `asset.search` 不排除已归档资产且不返回 lifecycle（Agent 能搜到
   归档资产却无从知晓状态）——改为排除归档 + 附 lifecycle + 弃用排后。

## 验证

tests/m70 八项：纯函数两（类型映射/结构+确定性/闭包外边不虚报）+ 端到端五
（弃用治理含负例与幂等、目录可见性三态、取消弃用回滚、SBOM 结构/热度/审计/
外团队 404、Agent 工具告警与不误报）。全量 70 套件 351 项全绿。浏览器实测：
弃用双弹窗流程→横幅、继任者直达、依赖告警「已弃用，请查继任者」、SBOM 200
（CycloneDX 1.5/attachment 中文名/dependsOn/弃用属性）、目录「仅已弃用」URL
直达、默认视图含弃用徽标、动态页下拉两新动作+时间线第一条即弃用——截图
m70-ui-deprecate-banner / m70-ui-catalog-deprecated-filter / m70-ui-activity-deprecate。

## 后续候选（如实记录，不预造）

- SBOM 的 SPDX 格式第二输出（有真实消费方再加，不预造格式）；
- 弃用沿依赖链的批量告警视图（Dependabot 式「影响面清单」——等真实多下游
  场景出现再做）；
- 版本级弃用（当前是资产级；修订不可变，版本级弃用语义需先想清楚与通道
  回滚的关系）。
