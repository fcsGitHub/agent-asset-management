// Schema 便捷生成（M60）：表单属性行 → JSON Schema（fieldsToSchema）与
// 示例样例 → JSON Schema（inferSchemaFromSamples）。API 端点 /types/infer-schema
// 与单测共用同一实现；生成物仍走既有质量门（可编译/词表悬挂/子类收窄/迁移预演），
// M59 的入库与更新强制关卡不变——生成只降低「设定 schema」的门槛，不降低校验强度。
// 调研锚点：quicktype --lang schema / jsonschema.net；required 推断惯例为
// unanimity（所有样例都出现才必填，单样例则全部必填）；枚举不做机械推断
// （样例区分不了「恰好这两个值」与「自由文本」），如实写进 notes 请人工设定。

export type FieldScalarType = "string" | "number" | "integer" | "boolean" | "object" | "array";

export interface SchemaFieldDraft {
  key: string;
  title?: string;
  type: FieldScalarType;
  required: boolean;
  /** 逗号分隔的枚举值（仅 string 型生效） */
  enumValues?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** array 元素类型（默认 string） */
  items?: FieldScalarType;
}

export interface BuiltSchema {
  jsonSchema: object;
  /** 构建期问题（key 非法/重复、类型不匹配的约束被忽略等）；空数组可直接使用 */
  problems: string[];
}

const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;

/** 表单属性行 → JSON Schema。忽略与类型不匹配的约束并如实列入 problems。 */
export function fieldsToSchema(fields: SchemaFieldDraft[]): BuiltSchema {
  const problems: string[] = [];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const seen = new Set<string>();
  for (const f of fields) {
    const key = f.key.trim();
    if (!KEY_RE.test(key)) {
      problems.push(`属性名 "${key || "(空)"}" 不合法（字母开头，仅字母/数字/下划线，≤64 字符）`);
      continue;
    }
    if (seen.has(key)) {
      problems.push(`属性名 "${key}" 重复，已忽略后一条`);
      continue;
    }
    seen.add(key);
    const prop: Record<string, unknown> = { type: f.type };
    if (f.title?.trim()) prop.title = f.title.trim();
    if (f.type === "string") {
      const enumRaw = (f.enumValues ?? "").split(/[,，]/).map((s) => s.trim()).filter((s) => s !== "");
      if (enumRaw.length > 0) prop.enum = enumRaw;
      if (f.minLength !== undefined) prop.minLength = f.minLength;
      if (f.maxLength !== undefined) prop.maxLength = f.maxLength;
    } else if (f.enumValues?.trim()) {
      problems.push(`属性 "${key}" 是 ${f.type} 型，枚举仅支持 string（已忽略）`);
    }
    if (f.type === "number" || f.type === "integer") {
      if (f.minimum !== undefined) prop.minimum = f.minimum;
      if (f.maximum !== undefined) prop.maximum = f.maximum;
    } else if (f.minimum !== undefined || f.maximum !== undefined) {
      problems.push(`属性 "${key}" 是 ${f.type} 型，min/max 仅支持数值型（已忽略）`);
    }
    if (f.type === "array") prop.items = { type: f.items ?? "string" };
    properties[key] = prop;
    if (f.required) required.push(key);
  }
  return {
    jsonSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    problems,
  };
}

// ---------------------------------------------------------------------------
// 示例样例 → JSON Schema（推断）

export interface InferredSchema {
  jsonSchema: object;
  /** 推断说明（机械推断的边界，如实告知请人工复核） */
  notes: string[];
}

function jsTypeOf(v: unknown): FieldScalarType | null {
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return "object";
  return null; // null/undefined：样例里没有信息
}

const MAX_DEPTH = 2;

function inferProperty(values: unknown[], key: string, depth: number, notes: string[]): Record<string, unknown> | null {
  const types = new Set(values.map(jsTypeOf).filter((t): t is FieldScalarType => t !== null));
  if (types.size === 0) {
    notes.push(`属性 "${key}" 的样例全为 null，无信息，已跳过`);
    return null;
  }
  if (types.size > 1) {
    notes.push(`属性 "${key}" 样例类型不一致（${[...types].join(" / ")}），已回落为不约束类型的宽松定义，请人工收窄`);
    return {};
  }
  const type = [...types][0]!;
  const prop: Record<string, unknown> = { type };
  if (type === "object") {
    if (depth >= MAX_DEPTH) {
      notes.push(`属性 "${key}" 嵌套对象已到推断深度上限（${MAX_DEPTH} 层），内部结构未展开，请人工补充`);
    } else {
      const merged = inferObjectProperties(values.filter((v): v is Record<string, unknown> => jsTypeOf(v) === "object"), depth + 1, notes, `${key}.`);
      if (Object.keys(merged.properties).length > 0) {
        if (merged.required.length > 0) prop.required = merged.required;
        prop.properties = merged.properties;
      }
    }
  }
  if (type === "array") {
    const flat = values.filter(Array.isArray).flat();
    const elementTypes = new Set(flat.map(jsTypeOf).filter((t): t is FieldScalarType => t !== null));
    if (elementTypes.size === 1) prop.items = { type: [...elementTypes][0] };
    else if (elementTypes.size > 1) notes.push(`属性 "${key}" 数组元素类型混杂，items 未约束，请人工补充`);
  }
  return prop;
}

function inferObjectProperties(objs: object[], depth: number, notes: string[], keyPrefix: string): { properties: Record<string, unknown>; required: string[] } {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  const total = objs.length;
  const allKeys = [...new Set(objs.flatMap((o) => Object.keys(o)))];
  for (const key of allKeys) {
    const present = objs.filter((o) => key in (o as Record<string, unknown>));
    const values = present.map((o) => (o as Record<string, unknown>)[key]);
    const prop = inferProperty(values, keyPrefix + key, depth, notes);
    if (prop === null) continue;
    properties[key] = prop;
    // unanimity 惯例：所有样例对象都出现才必填；单样例 ⇒ 全部必填
    if (present.length === total) required.push(key);
    else notes.push(`属性 "${key}" 仅在 ${present.length}/${total} 个样例中出现，未设为必填`);
  }
  return { properties, required };
}

/**
 * 从一个或多个样例对象推断 JSON Schema。samples 须全部是对象（顶层必须是对象——
 * 资产属性是键值结构）；类型冲突回落宽松并注明；枚举不机械推断（区分不了受控值
 * 与自由文本），在 notes 中提示人工设定。
 */
export function inferSchemaFromSamples(samples: unknown[]): InferredSchema {
  const notes: string[] = [];
  const objs = samples.filter((s): s is Record<string, unknown> => jsTypeOf(s) === "object");
  if (objs.length === 0) {
    return {
      jsonSchema: { type: "object", properties: {} },
      notes: ["样例里没有任何对象：请提供至少一个属性对象（资产属性是键值结构）"],
    };
  }
  if (objs.length < samples.length) {
    notes.push(`已忽略 ${samples.length - objs.length} 个非对象样例（顶层必须是对象）`);
  }
  const { properties, required } = inferObjectProperties(objs, 1, notes, "");
  if (Object.keys(properties).length > 0) {
    notes.push("推断是机械的：必填按「全部样例都出现」判定，字符串未区分枚举与自由文本——请复核 required 与枚举后再登记");
  }
  return {
    jsonSchema: { type: "object", properties, ...(required.length > 0 ? { required } : {}) },
    notes,
  };
}
