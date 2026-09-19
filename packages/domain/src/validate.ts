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
