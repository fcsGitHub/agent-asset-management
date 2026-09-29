# Research M59 — 更新与入库的全路径 Schema 强制（2026-09-29）

用户点名：「本体能否关联或者设置 schema，保证更新与入库必须经过设定的 schema」。

## 现状核对（先审计后动手）

类型↔schema 的**关联**早已存在：asset_type_versions 每个类型定义版本自带 json_schema +
单位词表，不可变、版本并存（M1 起）；登记（POST /assets）自 M2/A03 起按类型链全量校验。
全仓库修订写入点只有两处：登记（已校验）与**分支草稿保存（POST /branches/:id/revisions，
未校验）**——即资产的「更新」主路径（草稿→CR→发布）此前可完全绕过 schema。Agent 草稿
工具只写提案不写修订，无第三条路。缺的是**强制执行的完备性**，不是关联机制本身。

## 业界锚点

1. **OpenMetadata：实体定义即数据契约**（docs.open-metadata.org High Level Design）——
   后端对**所有**接收数据按实体 JSON Schema 校验；官方明确「任意 JSON 文档不能存成实体」
   （Discussion #2689），API 边界即校验边界。
   → 吸收：校验必须覆盖一切属性写入路径，登记与更新同关卡，不能只在入口设卡。
2. **Backstage Software Catalog 的 validate 端点**（backstage.io API 文档：validate that a
   passed in entity has no errors in schema）——ingestion 之前可单独调用校验，YAML 描述符
   与 JSON API 表示以 *.v1alpha1.schema.json 为边界契约。
   → 吸收：提供 dry-run 校验端点（POST /assets/validate），表单/Agent/外部集成可在
   落库前拿到与登记完全同源（同一纯函数、同一类型链）的判定，而不是复制一套规则。

## 落地（M59）

1. 共享关卡：apps/api/src/ontology.ts——loadTypeChain（子→父→根，防环+深度上限）+
   validateAgainstChain（全链逐定义校验，错误带 [typeKey vN] 前缀）；登记与分支保存
   共用同一实现，规则不可能分叉。
2. 更新强制：分支草稿保存对**合并后的属性**做全链校验，不合规 422——「更新必须经过
   设定的 schema」自此闭环（草稿→CR→发布的候选内容全部产生自已校验修订）。
3. 发布复核（纵深+清欠账）：prepare-review 对候选修订属性重验全链，不合规
   409 CANDIDATE_SCHEMA_INVALID——堵住 M59 之前存量的不合规历史草稿（它们创建时无校验），
   也保证「进入正式审核的内容必合规」不依赖创建时点的代码版本。
4. dry-run：POST /assets/validate（成员可用，零副作用）返回 valid/errors，与登记同源；
   登记表单加「校验」按钮（提交前即可见全链错误）。
5. 类型定义本身仍由既有本体治理约束（jsonSchema 可编译、词表无悬挂、子类收窄、
   版本不可变、迁移影响预演）——schema 的"设定"侧不新增机制。

## 与既有机制的关系

- 修订不可变 + 类型定义版本不可变 ⇒ 校验在创建时通过即永久有效；prepare 复核是
  防御纵深与历史欠账清理，不是对不可变性的不信任。
- M58 测试门禁管「证据」，本轮管「结构」；两者都在 prepare/publish 边界生效，
  共同构成「入库与更新必须经过设定 schema + 部分模型必须过测试」的完整闸门。
