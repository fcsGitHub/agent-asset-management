# M62 调研笔记：Schema 驱动的登记表单（类型链合并 + 输入部件 + 提交前预检）

日期：2026-09-30 · 位置：`packages/domain/src/schema-form.ts` + `apps/web` AssetRegister

## 问题

M59 之后入库与更新必须过类型链 schema（ajv 全量 + 单位词表），但登记表单仍是「裸 schema 半吊子渲染」：

1. **祖先链字段不可见**——表单只渲染所选类型自身 `json_schema.properties`，而
   `validateAgainstChain` 是对链上每一环分别校验。子类型允许移除父类属性
   （`inheritanceViolations` 只禁 type-changed），父类 required 的字段若被子类
   schema 省略，表单里没有任何输入位，登记必然 400 且用户不知道去哪补。
2. **布尔字段事实上不可用**——渲染成文本框，"true" 以字符串提交，`type: boolean`
   校验必挂。
3. **约束零提示**——min/max/minLength/maxLength/pattern/单位词表全都不显示，
   错误只能在「校验」按钮或提交后的 400 里看到。
4. **数组只按字符串切分**——`items: integer` 的数组输 "1,2" 提交成 `["1","2"]` 必挂。

## 调研：JSON Schema → 表单的既有做法

- **react-jsonschema-form（rjsf，约 15k★）**：事实标准。schema.properties 顺序即
  表单顺序（`ui:order` 可覆盖）；`enum` → select；`type: boolean` → checkbox；
  required → 标题加 `*`；数值 min/max 作为原生 input 属性与校验；object/array 递归
  展开或退化 textarea。错误信息按 instancePath 逐字段定位。
- **JSON Forms（jsonforms.io）**：schema（数据约束）与 ui schema（布局/部件）分离，
  继承场景靠合并后的 schema 渲染；Rule 系统做条件显隐。
- **Angular Formly / formkit**：字段配置驱动（field config）而非直接消费 schema——
  先把 schema 转成一份「字段规格」再渲染，转换单元可独立测试。

## 决策

1. **不引运行时依赖**（rjsf/JSON Forms 都是整套渲染框架），按项目惯例自建薄纯函数
   `schemaToFormSpec`：JSON Schema（链） → `FormFieldSpec[]`（Formly 式字段规格），
   渲染留在 web。可独立单测，且能把「类型链合并」这种本项目特有语义做进去——
   rjsf/JSON Forms 都没有继承链概念。
2. **链合并语义与 `validateAgainstChain` 严格对齐**：链上每一环都会校验，所以表单
   字段 = 链上声明过的属性的并集；required = 任一环 required（并集）；有效约束是
   各环约束的**交集**（数值/长度取更紧一侧、枚举取交集——派生侧漏写 min 不会放松
   祖先的 min，这条是最容易踩的暗雷）；枚举无交集如实报治理债；仅祖先声明的字段
   标 `inheritedFrom`，UI 注明「继承自 typeKey vX」。
3. **单位词表并入字段规格**：词表 `<name>` 约束属性 `<name>Unit`（validate.ts 二次
   校验），spec 生成时把词表值填进对应字段的 enumValues 并标 vocabulary 名——
   受控值在输入端就变成下拉，而不是提交后报「不在受控词表内」。
4. **输入换算共享纯函数** `formValuesToProperties`：字符串表单值 → 类型化属性
   （boolean/integer/number/list 按元素类型换算/JSON 解析），解析失败收集为
   problems 而不是抛异常；提交与「校验」按钮共用，口径不可能分叉（替换原
   `cleanedProps`，顺带修掉布尔/数值数组的必挂路径）。
5. **本地预检是咨询性的，服务端关卡仍是权威**：`checkFormValues` 只覆盖 spec 已知
   的确定性约束（required/枚举/词表/范围/长度/正则/元素类型），不是完整 JSON Schema
   实现——完整语义由 M59 服务端 ajv 关卡保证。预检失败就地显示并阻止提交，
   省掉必然 400 的往返；预检通过仍可点「校验」走服务端 dry-run。
6. **客户端链重建走既有数据**：GET /types 已返回全量类型行（含 json_schema、
   unit_vocabularies、parent_type_key/version），web 按 (parent_type_key,
   parent_version) 走链即可，不新增端点；深度/环防御与 loadTypeChain 同口径。

## 边界（如实）

- 嵌套 object 内部不展开（textarea JSON 整体输入）——M60 推断深度也只有 2 层，
  展开嵌套表单的复杂度与收益不成比。
- array 的 items enum 未在生成器里出现（fieldsToSchema 只产 items.type），预检
  只查元素类型。
- pattern 用 RegExp 直接试；非法正则（schema 里手写坏）跳过该项，交给服务端 ajv
  报权威错误。

## 验收

- tests/m62：spec 生成（顺序/必填/枚举/范围/继承合并/词表）、输入换算（布尔/整数/
  数值数组/JSON 坏值不抛）、预检（各约束命中与放行）、API 级回环（两级类型链，
  表单并集字段填满 → /assets/validate 通过；漏掉继承字段 → 报 [parent vX] 前缀）。
- 浏览器实测：选继承类型 → 祖先字段带「继承自」标注出现、词表字段变下拉、
  缺必填就地预检报错、填满后登记成功。
