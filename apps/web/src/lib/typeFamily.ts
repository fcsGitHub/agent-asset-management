// 类型家族映射（M53，吸收 CKAN 分面筛选思路）：把团队的 type_key 前缀归入
// 中文家族快筛 chips（文档/代码/测试/仿真/数据）。纯前端启发：不改服务端类型系统，
// 自定义 type_key 不命中任何前缀时回落为 null（只出现在「全部类型」下拉里，不强行归类）。
export interface TypeFamily {
  key: string;
  label: string;
  prefix: string;
  icon: string;
}

export const TYPE_FAMILIES: TypeFamily[] = [
  { key: "document", label: "文档", prefix: "document", icon: "📄" },
  { key: "software", label: "代码", prefix: "software", icon: "💻" },
  { key: "test", label: "测试", prefix: "test.", icon: "🧪" },
  { key: "simulation", label: "仿真", prefix: "simulation.", icon: "🧭" },
  { key: "data", label: "数据", prefix: "data", icon: "🗃" },
];

/** type_key → 家族；未命中返回 null（如团队自定义 qa.checklist、design.spec）。 */
export function typeFamilyOf(typeKey: string): TypeFamily | null {
  for (const f of TYPE_FAMILIES) {
    if (typeKey === f.prefix || typeKey.startsWith(f.prefix)) return f;
  }
  return null;
}
