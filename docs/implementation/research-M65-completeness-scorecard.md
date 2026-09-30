# M65 调研笔记：资产元数据完整度 Scorecard 与引导

日期：2026-09-30 · 位置：`@taw/domain/completeness` + `routes/catalog.ts` 详情 + web 详情卡

## 问题

资产登记门槛（M59 schema 关卡）保证的是「合法」，不保证「完整」：一个只填了必填
字段、没有制品、没有关联、没有负责人的资产完全合法，但它恰恰丢掉了本平台最核心
的价值（关联、可下载、可引用）。用户在详情页看不到「这个资产还缺什么」，治理者
看不到团队资产的整体质量水位。该候选自 M54 起挂账十轮，按老化约定升格。

## 调研锚点

- **Backstage TechInsights Scorecard**：把「数据是否治理好」拆成一组布尔检查
  （checks），每项带权重/说明/修复建议，聚合成 0-100 分；检查失败必须给出可执行
  的下一步（actionable message），而不是只打红叉。这是本功能的直接形态锚点。
- **Backstage Catalog 实体校验与 annotation 引导**：required 字段（kind/name/
  spec.owner）+ 推荐注解（links/description/tags）——「必填」与「推荐」分层，
  推荐项用引导而非阻断（对应本项目：schema required 由 M59 阻断，scorecard 的
  owner/关联/制品等用提示引导，不新增登记门槛）。
- **HF model card 元数据惯例**：owner/author、base_model、tags、license 等推荐字段
  ——owner 类字段名无统一标准（owner/maintainer/author/creator…），检查按惯例
  键集合判定。

## 决策

1. **纯函数 computeCompleteness（@taw/domain/completeness）**：六项加权检查，
   权重合计 100——schema_required 25（链上必填属性齐备：与登记表单同一份
   schemaToFormSpec 链合并结果取 required 并集，兜住 M59 之前的存量欠账资产）、
   owner 20（惯例键 owner/ownerName/maintainer/responsible/author/creator 之一
   非空）、relations 20（已确认关联数 >0——平台核心价值项权重最高档）、
   artifacts 15（当前修订挂有制品，远程可下载）、aliases 10（稳定短引用）、
   tags 10（标签或分类，检索与分面）。每项 check 带 title/detail/hint——未通过
   必须给可执行下一步（TechInsights 口径）。
2. **引导不阻断**：scorecard 是读侧派生，不新增任何登记/更新门槛（M59 关卡强度
   不变）；「推荐项」与「必填项」分层如实呈现。
3. **服务端计算、单一事实源**：GET /assets/:assetId 附 completeness——required
   字段用 loadTypeChain + schemaToFormSpec（与登记表单/预检同一合并语义，不可能
   分叉）；owner/制品取当前 head 修订；关系数补一条 confirmed in+out 计数查询。
   目录列表暂不滚动计算（需要逐行拉属性，查询代价大）——记为边界，scorecard
   先做详情页。
4. **web 详情卡**：分数 + 逐项 ✓/✗ + 未通过项的 hint（下一步动作），紧邻使用
   热度卡；分数条按档着色（80+ 绿 / 50-79 黄 / <50 红）。

## 边界

- 目录列表/工作台汇总不含分数（见上）；如需要，后续可做后台聚合或排序端点。
- owner 惯例键集合是约定不是 schema——类型定义者若用别的键名（如 custodian）
   会被判未设置；hint 里列出全部惯例键供对照（如实告知判定口径）。
- 分数是治理参考不是 SLA：权重固定（写死在纯函数常量，改动即改语义）。

## 验收

- tests/m65：纯函数（全过 100/逐项失败含 hint/owner 惯例键/required 缺失点名/
  权重算术）；API 端到端（裸资产低分+检查明细；补 owner/关系/别名/标签后分数
  上升——引导闭环；详情 completeness.requiredFields 与类型链一致）。
- 浏览器实测：详情页完整度卡渲染、未通过项提示可执行。
