# M64 调研笔记：Schema 表单贯穿草稿编辑 + 门禁提示前移

日期：2026-09-30 · 位置：`apps/web/src/components/SchemaForm.tsx` + `@taw/domain/schema-form` 增补 + Workbench

## 问题（两个连续落选的候选合并一轮）

1. **分支草稿编辑器仍是裸 JSON 文本域**（M62 只覆盖了登记侧）：修改资产属性要手写
   整个 JSON，M59 强制关卡的错误只在保存后暴露；登记表单已有的枚举下拉/范围
   提示/预检在「修改」路径上一概没有。登记和更新是同一套 schema 约束（M59 共用
   关卡），输入体验却割裂。
2. **门禁提示滞后**：requires_test_evidence 类型（M58）只在 CR 卡片与发布时才
   可见——用户登记完资产、写完草稿、建完 CR，到发布才知道要测试证据。提示应
   前移到登记选型时（「这个类型发布前要过测试」影响是否现在就登记）。

## 调研锚点

- **react-jsonschema-form 的 defaultValue 预填**：表单从现有实例值反填（enum 选中、
  number 字符串化），用户只改要改的字段——这是「编辑」与「新建」在 schema 表单
  里的唯一差别；rjsf 的 Form 组件同时服务 create/edit。
- **JSON Forms 的 detail/edit 视图**：同一 schema 驱动列表页与详情编辑页，控件
  一致性由「同一份 ui 绑定」保证——对应本项目：登记与草稿编辑共用同一套
  FieldInput/预检，口径不可能分叉。
- **Backstage Catalog 的 required/annotation 提示前移**：约束在登记/编辑表单上
  即时呈现（必填星号、受控值），而不是等 CI 或 ingest 报错。

## 决策

1. **抽取共享组件 `components/SchemaForm.tsx`**：FieldInput（按 spec 渲染输入部件）、
   fieldHint（约束人读提示）、SchemaFields（字段集渲染）、chainFromTypes（从
   GET /types 全量行按 parent_type_key/version 重建类型链，深度/环防御同
   loadTypeChain）。AssetRegister 与 DraftPanel 同源使用——M62 的链合并/部件/
   预检逻辑只此一份。
2. **域层增补两个纯函数**（可单测）：
   - `propertiesToFormValues(fields, properties)`：类型化属性 → 表单字符串（number
     → String、boolean → "true"/"false"、标量数组 → 逗号串、对象/对象数组 →
     JSON 文本），**schema 外的属性分离为 extra**（additionalProperties 开放时
     保留开放世界表达力，编辑回存时合并）。
   - `chainRequiresTestEvidence(chain)`：链上任一环声明即 required（与 checkTestGate
     的「required 来自类型链上任一定义」语义同源）——登记表单据此提示。
3. **DraftPanel 双模式**：结构化表单（默认，预填现有值 + extra 折叠 JSON 区）/ 原始
   JSON（原文本域保留，高级用户兜底）。保存前本地预检（M62 同款咨询性检查），
   服务端 M59 关卡不变（保存的是 head+patch 合并后的全量校验）。
4. **门禁提示前移**：登记表单选中类型后，链上任一环 requires_test_evidence 即显示
   「此类型链需测试证据」提示条（如实说明：门禁在发布时强制，不拦登记/草稿——
   提示时机提前，不改变关卡位置）。

## 边界与行为发现

- **草稿保存是补丁语义**（M59 既有行为，本轮实测坐实）：服务端按
  `{...head.properties, ...body.properties}` 合并后校验并存储——清空的字段沿用
  head 值（不删除），不会 422。因此草稿侧本地预检按**合并视图**查（head+表单值+
  extra），否则会误拦服务端本会接受的保存；纯函数 checkFormValues 对裸表单值仍
  如实报缺必填（两层口径各有其用，测试分别断言）。
- propertiesToFormValues 的对象数组（array<object>）预填为 JSON 文本；标量数组往返
  逗号串时值内含逗号会失真（如实注记提示走 JSON 模式）。
- extra 区属性不做 schema 校验（schema 未声明即无约束可查），服务端关卡对全量
  属性生效。

## 验收

- tests/m64：chainRequiresTestEvidence 任一环语义；propertiesToFormValues 往返
  （六类型 + extra 分离）；草稿流程端到端（预填 → 改一字段 → 换算合并 → 保存 201；
  预检先拦非法值；服务端 M59 兜底 422）；GET /types 暴露 requires_test_evidence。
- 浏览器实测：登记表单门禁提示；资产详情「修改资产」schema 表单预填 + 保存成功。
