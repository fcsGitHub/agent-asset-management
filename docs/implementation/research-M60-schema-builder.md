# Research M60 — Schema 便捷生成（2026-09-29）

用户点名：「完成 schema 便捷生成功能」。现状：注册类型要手写 JSON Schema 文本，
门槛高——schema 的「设定侧」成了 M59 强制关卡前的瓶颈。

## 业界锚点

1. **JSON → JSON Schema 推断工具**（quicktype `--lang schema`、jsonschema.net 等，
   见 jsonic.io《JSON Schema from JSON: Tools, Inference Rules》与 Awesome JSON Schema
   目录）：从样例数据机械推断结构。公认边界：**推断捕捉结构、缺失意图**——哪些字段
   真必填、哪些字符串是受控枚举，样例本身说明不了。
   → 吸收：推断产物如实标注边界（notes 逐条列出），**枚举不做机械推断**；产物可继续
   人工微调（切「手写」模式）后走既有质量门。
2. **required 的 unanimity 惯例**（toolsura/bytefork 等生成器共识）：属性只有在
   **所有**观测样例中都出现才进 required；只有单样例时全部字段必填（一个样例对
   可选性没有信息量）。
   → 吸收：支持多对象样例（整体 JSON 数组或每行一个对象），按 unanimity 判必填，
   部分出现的字段在 notes 中给出「x/N 个样例中出现」供人工决策。
3. **结构化表单构建**（各低代码/数据目录的 schema 编辑器，如 CKAN 的 dataset
   schema 字段编辑）：属性名/类型/必填/枚举/范围用表单控件填，实时预览生成物。
   → 吸收：表单属性行编辑器（类型联动约束输入：string→枚举、number/integer→
   min/max、array→元素类型），生成物实时预览并回流到统一的 schema 文本框。

## 落地（M60）

1. @taw/domain/schema-builder 纯函数两件（API 端点与单测同源）：
   - fieldsToSchema：属性行 → JSON Schema；键非法/重复、类型不匹配的约束（枚举配
     数值、min/max 配字符串）如实列 problems 并忽略，不静默。
   - inferSchemaFromSamples：样例 → JSON Schema；unanimity 必填、嵌套对象展开
     （深度上限 2 层，超出如实注明）、数组元素类型一致才约束 items、类型冲突回落
     宽松 {} 并注明、null 字段跳过、非对象样例忽略计数。
2. POST /types/infer-schema：成员可用、零副作用；产物经 compileTypeSchema 防御
   性复核。web 经 workspace 直引 schema-builder 子路径（无 ajv 依赖负担）。
3. 本体页类型表单三模式：表单构建（默认）/ 样例推断 / 手写 JSON——产物统一写入
   schemaText（单一事实源），任意模式产物可切手写微调；提交仍走 POST /types
   全部质量门（可编译/词表悬挂/子类收窄）与 M59 入库更新强制关卡。
   **生成只降低「设定」门槛，不降低「校验」强度**——端到端测试证明：推断产物
   注册成类型后，符合样例的资产可登记、违反的被 M59 关卡 422 拦下。
