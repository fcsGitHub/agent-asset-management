// Schema 驱动的登记表单（M62）：类型链 JSON Schema → 表单字段规格，及配套的
// 表单值 → 类型化属性换算与本地预检。调研锚点：react-jsonschema-form（enum →
// select、required → *、schema 顺序即表单顺序）、JSON Forms（schema 与 UI 分层）、
// Formly（先转字段规格再渲染）。这里自建薄纯函数：渲染留在 web，转换可独立单测，
// 并把本项目特有的类型链合并语义（与 validateAgainstChain 对齐）做进转换层。
// 边界：本地预检只覆盖 spec 已知的确定性约束，是咨询性的；完整 JSON Schema
// 语义由 M59 服务端 ajv 关卡权威保证。

import type { FieldScalarType } from "./schema-builder.js";

export type FormInputKind =
  | "enum" // 受控值下拉（schema enum 或单位词表）
  | "boolean"
  | "number"
  | "integer"
  | "text"
  | "json" // 整体 JSON 输入（object / array<object>）
  | "list"; // 逗号分隔列表（array 且元素为标量）

export interface FormFieldSpec {
  key: string;
  title?: string;
  /** 声明的 schema 类型（list/json 仍是 array/object） */
  type: FieldScalarType;
  input: FormInputKind;
  required: boolean;
  enumValues?: string[];
  /** enumValues 来源词表名（来自 unit_vocabularies 时标注） */
  vocabulary?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  /** array 元素声明类型（默认 string） */
  items?: FieldScalarType;
  /** 仅祖先声明时标注「typeKey vX」，UI 提示继承来源 */
  inheritedFrom?: string;
}

export interface FormSpec {
  fields: FormFieldSpec[];
  /** 链上任一环 additionalProperties:false 即封闭——未列出的属性将被拒绝 */
  closed: boolean;
  notes: string[];
}

export interface TypeDefLite {
  typeKey: string;
  version: string;
  jsonSchema: object;
  unitVocabularies: Record<string, string[]>;
}

type SchemaObj = Record<string, unknown>;

function propObj(v: unknown): SchemaObj {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as SchemaObj) : {};
}

function inputKindFor(type: string, enumPresent: boolean, items?: FieldScalarType): FormInputKind {
  if (enumPresent) return "enum";
  if (type === "boolean") return "boolean";
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "object") return "json";
  if (type === "array") return items === "object" ? "json" : "list";
  return "text";
}

/**
 * 类型链（派生在前：子 → … → 根，与 loadTypeChain 同序）→ 合并表单字段规格。
 * 合并语义与 validateAgainstChain 对齐：链上每一环都会校验，因此字段 = 链上声明过
 * 的属性并集；required 取并集（任一环必填即必填）；数值/长度约束取更紧一侧、
 * 枚举取交集（有效约束是各环约束的交集，派生侧漏写不会放松祖先限制）。
 * 仅祖先声明的字段标 inheritedFrom。
 */
export function schemaToFormSpec(chain: TypeDefLite[]): FormSpec {
  const notes: string[] = [];
  const fields: FormFieldSpec[] = [];
  const byKey = new Map<string, FormFieldSpec>();
  const requiredSets: Set<string>[] = [];
  let closed = false;

  for (const member of chain) {
    const schema = propObj(member.jsonSchema);
    const properties = propObj(schema.properties);
    const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
    requiredSets.push(required);
    if (schema.additionalProperties === false) closed = true;

    for (const [key, rawProp] of Object.entries(properties)) {
      const p = propObj(rawProp);
      const type = (typeof p.type === "string" ? p.type : "string") as FieldScalarType;
      const enumValues = Array.isArray(p.enum) ? p.enum.map((v) => String(v)) : undefined;
      const items = propObj(p.items).type as FieldScalarType | undefined;
      const existing = byKey.get(key);
      if (existing) {
        // 链上每一环都会校验（validateAgainstChain 逐环 ajv），有效约束是各环的交集：
        // 数值/长度取更紧一侧，枚举取交集（按派生侧顺序），required 取并集；
        // 派生侧未给的 title 从祖先回填（提示信息不丢）。
        existing.required = existing.required || required.has(key);
        if (typeof p.minimum === "number") {
          existing.minimum = existing.minimum === undefined ? p.minimum : Math.max(existing.minimum, p.minimum);
        }
        if (typeof p.maximum === "number") {
          existing.maximum = existing.maximum === undefined ? p.maximum : Math.min(existing.maximum, p.maximum);
        }
        if (typeof p.minLength === "number") {
          existing.minLength = existing.minLength === undefined ? p.minLength : Math.max(existing.minLength, p.minLength);
        }
        if (typeof p.maxLength === "number") {
          existing.maxLength = existing.maxLength === undefined ? p.maxLength : Math.min(existing.maxLength, p.maxLength);
        }
        if (enumValues) {
          if (existing.enumValues === undefined) existing.enumValues = enumValues;
          else existing.enumValues = existing.enumValues.filter((v) => enumValues.includes(v));
          if (existing.enumValues.length === 0) {
            notes.push(`属性 "${key}" 在类型链上的枚举无交集——该类型的资产无法满足链校验，请治理类型定义`);
          }
        }
        if (existing.pattern === undefined && typeof p.pattern === "string") existing.pattern = p.pattern;
        else if (typeof p.pattern === "string" && existing.pattern !== p.pattern) {
          notes.push(`属性 "${key}" 在类型链上有多重格式要求（${existing.pattern} 与 ${p.pattern}），表单只提示派生侧，两则都会校验`);
        }
        if (existing.title === undefined && typeof p.title === "string" && p.title.trim() !== "") {
          existing.title = p.title.trim();
        }
        const memberItems = propObj(p.items).type as FieldScalarType | undefined;
        if (memberItems !== undefined && existing.items !== undefined && existing.items !== memberItems) {
          notes.push(`属性 "${key}" 的数组元素类型在 ${member.typeKey} v${member.version} 中为 ${memberItems}，与派生侧 ${existing.items} 不一致——请治理类型定义`);
        }
        if (existing.type !== type) {
          notes.push(`属性 "${key}" 在 ${member.typeKey} v${member.version} 中类型为 ${type}，与派生侧声明的 ${existing.type} 不一致——请治理类型定义`);
        }
        continue;
      }
      const field: FormFieldSpec = {
        key,
        ...(typeof p.title === "string" && p.title.trim() !== "" ? { title: p.title.trim() } : {}),
        type,
        input: inputKindFor(type, enumValues !== undefined, items),
        required: required.has(key),
        ...(enumValues !== undefined ? { enumValues } : {}),
        ...(typeof p.minimum === "number" ? { minimum: p.minimum } : {}),
        ...(typeof p.maximum === "number" ? { maximum: p.maximum } : {}),
        ...(typeof p.minLength === "number" ? { minLength: p.minLength } : {}),
        ...(typeof p.maxLength === "number" ? { maxLength: p.maxLength } : {}),
        ...(typeof p.pattern === "string" ? { pattern: p.pattern } : {}),
        ...(type === "array" ? { items: items ?? "string" } : {}),
        ...(chain.length > 1 && member !== chain[0] ? { inheritedFrom: `${member.typeKey} v${member.version}` } : {}),
      };
      fields.push(field);
      byKey.set(key, field);
    }
  }

  // 单位词表并入：词表 <name> 运行时约束属性 <name>Unit（或 <name> 本体）。
  // 派生侧词表优先（先遍历先命中）；字段已有 schema enum 时 schema 优先。
  const vocabSeen = new Set<string>();
  for (const member of chain) {
    for (const [vocabName, values] of Object.entries(member.unitVocabularies ?? {})) {
      if (vocabSeen.has(vocabName)) continue;
      vocabSeen.add(vocabName);
      const field = byKey.get(`${vocabName}Unit`) ?? byKey.get(vocabName);
      if (!field || field.type !== "string" || field.enumValues !== undefined) continue;
      field.enumValues = values;
      field.vocabulary = vocabName;
      field.input = "enum";
    }
  }

  const inheritedCount = fields.filter((f) => f.inheritedFrom).length;
  if (chain.length > 1 && inheritedCount > 0) {
    notes.push(`${inheritedCount} 个字段仅由祖先类型声明，已并入表单（required 为链上并集）`);
  }
  if (closed) {
    notes.push("类型链已关闭未声明属性：不在表单中的属性将被拒绝");
  }
  return { fields, closed, notes };
}

// ---------------------------------------------------------------------------
// 表单字符串值 → 类型化属性（提交与「校验」按钮共用，口径不可能分叉）

export interface CoercedForm {
  properties: Record<string, unknown>;
  /** 解析失败清单（不抛异常，就地展示） */
  problems: string[];
}

function coerceScalar(raw: string, key: string, type: FieldScalarType, problems: string[], where: string): unknown {
  if (type === "integer") {
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      problems.push(`属性 "${key}"${where}应为整数，得到 "${raw}"`);
      return undefined;
    }
    return n;
  }
  if (type === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      problems.push(`属性 "${key}"${where}应为数字，得到 "${raw}"`);
      return undefined;
    }
    return n;
  }
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    problems.push(`属性 "${key}"${where}应为布尔（true/false），得到 "${raw}"`);
    return undefined;
  }
  return raw;
}

/** 表单原始字符串值 → 类型化属性。空值跳过；JSON/数组/布尔等按 spec 换算。 */
export function formValuesToProperties(fields: FormFieldSpec[], raw: Record<string, string | undefined>): CoercedForm {
  const properties: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const f of fields) {
    const value = raw[f.key];
    if (value === undefined || value === "") continue;
    if (f.input === "boolean") {
      if (value === "true") properties[f.key] = true;
      else if (value === "false") properties[f.key] = false;
      else problems.push(`属性 "${f.key}" 应为布尔（true/false），得到 "${value}"`);
    } else if (f.input === "json") {
      try {
        const parsed: unknown = JSON.parse(value);
        const expectArray = f.type === "array";
        if (expectArray && !Array.isArray(parsed)) {
          problems.push(`属性 "${f.key}" 应为 JSON 数组，解析结果不是数组`);
        } else if (!expectArray && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
          problems.push(`属性 "${f.key}" 应为 JSON 对象，解析结果不是对象`);
        } else {
          properties[f.key] = parsed;
        }
      } catch (err) {
        problems.push(`属性 "${f.key}" 不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (f.input === "list") {
      const items = f.items ?? "string";
      const parts = value.split(/[,，]/).map((s) => s.trim()).filter((s) => s !== "");
      const out: unknown[] = [];
      for (const part of parts) {
        const v = coerceScalar(part, f.key, items, problems, " 的元素");
        if (v !== undefined) out.push(v);
      }
      properties[f.key] = out;
    } else if (f.input === "integer" || f.input === "number") {
      const v = coerceScalar(value, f.key, f.input, problems, "");
      if (v !== undefined) properties[f.key] = v;
    } else {
      properties[f.key] = value;
    }
  }
  return { properties, problems };
}

// ---------------------------------------------------------------------------
// 本地预检（咨询性）：只覆盖 spec 已知的确定性约束；完整 JSON Schema 语义
// 由服务端 M59 关卡（ajv + 链）权威保证。

/** 对类型化属性做轻量预检，返回逐条错误（空数组 = 未发现问题）。 */
export function checkFormValues(fields: FormFieldSpec[], properties: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const f of fields) {
    const v = properties[f.key];
    if (v === undefined || v === null) {
      if (f.required) errors.push(`缺少必填属性 "${f.key}"`);
      continue;
    }
    if (f.enumValues && !f.enumValues.includes(String(v))) {
      errors.push(`属性 "${f.key}" 的值 "${String(v)}" 不在受控值 [${f.enumValues.join(", ")}] 内${f.vocabulary ? `（词表 ${f.vocabulary}）` : ""}`);
      continue;
    }
    if (f.input === "integer" || f.input === "number") {
      if (typeof v !== "number" || (f.input === "integer" && !Number.isInteger(v))) {
        errors.push(`属性 "${f.key}" 应为${f.input === "integer" ? "整数" : "数字"}，得到 ${JSON.stringify(v)}`);
        continue;
      }
      if (f.minimum !== undefined && v < f.minimum) errors.push(`属性 "${f.key}"=${v} 低于下限 ${f.minimum}`);
      if (f.maximum !== undefined && v > f.maximum) errors.push(`属性 "${f.key}"=${v} 超过上限 ${f.maximum}`);
    } else if (typeof v === "string") {
      if (f.minLength !== undefined && v.length < f.minLength) errors.push(`属性 "${f.key}" 长度 ${v.length} 低于最小 ${f.minLength}`);
      if (f.maxLength !== undefined && v.length > f.maxLength) errors.push(`属性 "${f.key}" 长度 ${v.length} 超过最大 ${f.maxLength}`);
      if (f.pattern !== undefined) {
        try {
          if (!new RegExp(f.pattern).test(v)) errors.push(`属性 "${f.key}" 不满足格式要求（正则 ${f.pattern}）`);
        } catch {
          // schema 里手写的坏正则：跳过本地检查，交给服务端 ajv 报权威错误
        }
      }
    } else if (f.input === "list") {
      if (!Array.isArray(v)) {
        errors.push(`属性 "${f.key}" 应为数组`);
        continue;
      }
      const items = f.items ?? "string";
      for (const el of v) {
        const ok =
          items === "string" ? typeof el === "string" :
          items === "integer" ? Number.isInteger(el) :
          items === "number" ? typeof el === "number" :
          items === "boolean" ? typeof el === "boolean" : true;
        if (!ok) {
          errors.push(`属性 "${f.key}" 的元素应为 ${items}，存在 ${JSON.stringify(el)}`);
          break;
        }
      }
    } else if (f.input === "json" && f.type === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) {
        errors.push(`属性 "${f.key}" 应为对象`);
      }
    }
  }
  return errors;
}
