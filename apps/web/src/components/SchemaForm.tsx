// Schema 驱动表单的共享部件（M64 抽取）：登记（AssetRegister）与草稿编辑
// （DraftPanel）共用同一套链重建/字段渲染/约束提示——同一 schema 约束在「新建」
// 与「编辑」两条路径上的输入体验与口径不可能分叉（rjsf/JSON Forms 同一表单
// 组件同时服务 create/edit 的惯例）。纯逻辑在 @taw/domain/schema-form。
import { useMemo } from "react";
import {
  schemaToFormSpec,
  type FormFieldSpec,
  type FormSpec,
  type TypeDefLite,
} from "@taw/domain/schema-form";

/** GET /types 的类型行（web 侧所需字段的超集，登记与草稿共用） */
export interface TypeRow {
  id: string;
  type_key: string;
  version: string;
  title: string;
  parent_type_key?: string | null;
  parent_version?: string | null;
  requires_test_evidence?: boolean;
  unit_vocabularies?: Record<string, string[]>;
  json_schema: {
    required?: string[];
    properties?: Record<string, { type?: string; enum?: string[]; title?: string }>;
    additionalProperties?: boolean;
  };
}

/**
 * 从 GET /types 全量行重建类型链（子 → … → 根）：按 (parent_type_key,
 * parent_version) 走链；深度/环防御与服务端 loadTypeChain 同口径。
 */
export function chainFromTypes(types: TypeRow[], type: TypeRow): TypeDefLite[] {
  const chain: TypeDefLite[] = [];
  const seen = new Set<string>();
  let cursor: TypeRow | undefined = type;
  while (cursor && chain.length <= 16 && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.push({
      typeKey: cursor.type_key,
      version: cursor.version,
      jsonSchema: cursor.json_schema ?? {},
      unitVocabularies: cursor.unit_vocabularies ?? {},
      requiresTestEvidence: cursor.requires_test_evidence === true,
    });
    const pk = cursor.parent_type_key;
    const pv = cursor.parent_version;
    cursor = pk && pv ? types.find((t) => t.type_key === pk && t.version === pv) : undefined;
  }
  return chain;
}

/** memo 版：类型行集合与选中类型不变则不重算。 */
export function useFormSpec(types: TypeRow[], type: TypeRow | undefined): FormSpec | null {
  return useMemo(
    () => (type ? schemaToFormSpec(chainFromTypes(types, type)) : null),
    [types, type]
  );
}

/** 字段规格 → 输入部件（M62：枚举/词表与布尔下拉，数值输入模式，JSON/列表）。 */
export function FieldInput({ f, value, onChange }: { f: FormFieldSpec; value: string; onChange: (v: string) => void }) {
  if (f.input === "enum") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {(f.enumValues ?? []).map((v) => (
          <option key={v} value={v}>{v}</option>
        ))}
      </select>
    );
  }
  if (f.input === "boolean") {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (f.input === "integer" || f.input === "number") {
    return (
      <input
        inputMode={f.input === "integer" ? "numeric" : "decimal"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.input === "integer" ? "整数" : "数字"}
      />
    );
  }
  if (f.input === "json") {
    return (
      <textarea
        rows={3}
        style={{ width: "100%", fontFamily: "var(--mono, monospace)", fontSize: 12 }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.type === "array" ? 'JSON 数组，如 [{"name":"a"}]' : 'JSON 对象，如 {"name":"a"}'}
      />
    );
  }
  if (f.input === "list") {
    return (
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`逗号分隔的 ${f.items ?? "string"} 列表，如 a, b`}
      />
    );
  }
  return <input value={value} onChange={(e) => onChange(e.target.value)} />;
}

/** 字段约束的人读提示（范围/长度/格式/词表）；无约束返回空串不渲染。 */
export function fieldHint(f: FormFieldSpec): string {
  const parts: string[] = [];
  if (f.minimum !== undefined || f.maximum !== undefined) {
    parts.push(`范围 ${f.minimum ?? "-∞"} ~ ${f.maximum ?? "+∞"}`);
  }
  if (f.minLength !== undefined || f.maxLength !== undefined) {
    parts.push(`长度 ${f.minLength ?? 0}–${f.maxLength ?? "不限"}`);
  }
  if (f.pattern) parts.push(`格式 ${f.pattern}`);
  if (f.vocabulary) parts.push(`受控词表 ${f.vocabulary}`);
  return parts.join(" · ");
}

/** 字段集渲染（登记与草稿共用）：必填星号、继承来源标注、约束提示、链说明。 */
export function SchemaFields({
  spec, values, onChange, legendExtra,
}: {
  spec: FormSpec;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  legendExtra?: string;
}) {
  if (spec.fields.length === 0) return null;
  return (
    <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8 }}>
      <legend style={{ fontSize: 13, color: "var(--muted)" }}>
        类型属性（* 必填；含继承链共 {spec.fields.length} 项{legendExtra ?? ""}）
      </legend>
      {spec.fields.map((f) => (
        <div className="field" key={f.key}>
          <label>
            {f.title || f.key}
            {f.required ? " *" : ""}
            {f.inheritedFrom && (
              <span style={{ fontSize: 11, color: "var(--muted)" }}>（继承自 {f.inheritedFrom}）</span>
            )}
          </label>
          <FieldInput f={f} value={values[f.key] ?? ""} onChange={(v) => onChange(f.key, v)} />
          {fieldHint(f) && <div className="hint" style={{ fontSize: 11, marginTop: 2 }}>{fieldHint(f)}</div>}
        </div>
      ))}
      {spec.notes.map((n, i) => (
        <div key={i} className="hint" style={{ fontSize: 11 }}>{n}</div>
      ))}
    </fieldset>
  );
}
