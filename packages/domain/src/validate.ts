// 类型属性校验：JSON Schema（ajv，锁定版本）+ 单位受控词表检查。
// 设计 8 章：非法单位/枚举必须拒绝（验收 A03）。
import { Ajv, type ErrorObject } from "ajv";
import type { DefaultTypeDefinition } from "./defaults.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProperties(
  def: Pick<DefaultTypeDefinition, "jsonSchema" | "unitVocabularies">,
  properties: unknown
): ValidationResult {
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return { valid: false, errors: ["properties 必须是对象"] };
  }
  const validate = ajv.compile(def.jsonSchema as object);
  const ok = validate(properties) as boolean;
  const errors: string[] = ok
    ? []
    : (validate.errors ?? []).map(
        (e: ErrorObject) => `${e.instancePath || "/"} ${e.message ?? "不满足约束"}`
      );
  if (ok && errors.length === 0) {
    // 单位词表二次校验：属性名匹配 <name>Unit 且词表有定义时值必须在词表内
    const props = properties as Record<string, unknown>;
    for (const [vocabName, values] of Object.entries(def.unitVocabularies)) {
      const key = `${vocabName}Unit`;
      const v = props[key];
      if (v !== undefined && !values.includes(String(v))) {
        errors.push(`${key}="${String(v)}" 不在受控词表 [${values.join(", ")}] 内`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function compileTypeSchema(jsonSchema: object): boolean {
  try {
    ajv.compile(jsonSchema);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 类型定义结构对比（本体迁移影响预览用） ---------------- */

export interface SchemaChange {
  kind:
    | "required-added"      // 新增必填属性：存量数据可能缺失
    | "property-removed"    // 属性被移除：存量数据将被丢弃
    | "property-type-changed" // 属性类型改变：存量数据可能不再满足
    | "enum-narrowed"       // 枚举收窄：存量值可能越界
    | "additional-properties-closed"; // 关闭扩展：未知属性将被拒绝
  path: string;
  detail: string;
}

type SchemaObj = Record<string, unknown>;

function jsonTypeOf(schema: unknown): string | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const t = (schema as SchemaObj)["type"];
  if (typeof t === "string") return t;
  if (Array.isArray(t)) return t.slice().sort().join("|");
  return undefined;
}

function enumValues(schema: unknown): string[] | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const e = (schema as SchemaObj)["enum"];
  if (Array.isArray(e)) return e.map((v) => String(v));
  return undefined;
}

/**
 * 对比两版 JSON Schema，输出保守的破坏性变更清单。
 * 只识别确定性模式（必填新增 / 属性移除 / 类型变更 / 枚举收窄 / 关闭扩展），
 * 不做完整 JSON Schema 语义等价判断 —— 真实影响以逐资产校验结果为准。
 */
export function diffJsonSchemas(oldSchema: unknown, newSchema: unknown): SchemaChange[] {
  const changes: SchemaChange[] = [];
  if (typeof oldSchema !== "object" || oldSchema === null) return changes;
  if (typeof newSchema !== "object" || newSchema === null) return changes;
  const o = oldSchema as SchemaObj;
  const n = newSchema as SchemaObj;

  const oldRequired = new Set(Array.isArray(o.required) ? o.required.map(String) : []);
  const newRequired = new Set(Array.isArray(n.required) ? n.required.map(String) : []);
  for (const key of newRequired) {
    if (!oldRequired.has(key)) {
      changes.push({ kind: "required-added", path: `/${key}`, detail: "新版本将该属性设为必填，缺失的存量资产将校验失败" });
    }
  }

  const oldProps = (typeof o.properties === "object" && o.properties !== null ? o.properties : {}) as SchemaObj;
  const newProps = (typeof n.properties === "object" && n.properties !== null ? n.properties : {}) as SchemaObj;
  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      changes.push({ kind: "property-removed", path: `/${key}`, detail: "属性在新版本被移除，存量值将不再可见" });
      continue;
    }
    const oldType = jsonTypeOf(oldProps[key]);
    const newType = jsonTypeOf(newProps[key]);
    if (oldType !== undefined && newType !== undefined && oldType !== newType) {
      changes.push({ kind: "property-type-changed", path: `/${key}`, detail: `类型 ${oldType} → ${newType}，存量数据可能不再满足` });
      continue;
    }
    const oldEnum = enumValues(oldProps[key]);
    const newEnum = enumValues(newProps[key]);
    if (oldEnum && newEnum) {
      const removed = oldEnum.filter((v) => !newEnum.includes(v));
      if (removed.length > 0) {
        changes.push({ kind: "enum-narrowed", path: `/${key}`, detail: `移除枚举值 [${removed.join(", ")}]，存量值可能越界` });
      }
    }
  }

  const oldAdditional = o.additionalProperties;
  if (oldAdditional !== false && n.additionalProperties === false) {
    changes.push({ kind: "additional-properties-closed", path: "", detail: "新版本关闭未声明属性，带额外属性的存量资产将失败" });
  }
  return changes;
}

/** 统计属性在存量数据中的使用次数（预览展示影响面）。 */
export function countPropertyUsage(revisions: { properties: unknown }[]): Record<string, number> {
  const usage: Record<string, number> = {};
  for (const rev of revisions) {
    if (typeof rev.properties !== "object" || rev.properties === null || Array.isArray(rev.properties)) continue;
    for (const key of Object.keys(rev.properties as SchemaObj)) {
      usage[key] = (usage[key] ?? 0) + 1;
    }
  }
  return usage;
}
