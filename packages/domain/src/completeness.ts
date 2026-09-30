// 资产元数据完整度 scorecard（M65）：一组加权布尔检查 → 0-100 分 + 可执行提示。
// 调研锚点：Backstage TechInsights Scorecard（检查项带权重/说明/修复建议，失败
// 必须给 actionable message）+ Catalog 的「必填阻断 / 推荐引导」分层——schema
// required 由 M59 关卡阻断，本模块的 owner/关联/制品/别名/标签是读侧引导，
// 不新增任何登记门槛。分数是治理参考不是 SLA。

export type CompletenessCheckKey =
  | "schema_required" // 类型链必填属性齐备（兜住 M59 前的存量欠账资产）
  | "owner"           // 负责人惯例字段非空
  | "relations"       // 已确认关联（平台核心价值项）
  | "artifacts"       // 当前修订挂有制品（远程可下载）
  | "aliases"         // 稳定短引用
  | "tags";           // 标签或分类（检索与分面）

export interface CompletenessCheck {
  key: CompletenessCheckKey;
  title: string;
  passed: boolean;
  /** 现状说明（通过=有什么；未通过=缺什么） */
  detail: string;
  /** 未通过时的可执行下一步 */
  hint: string;
  weight: number;
}

export interface CompletenessReport {
  /** 0-100，通过项权重之和 */
  score: number;
  checks: CompletenessCheck[];
}

/** 负责人惯例键（HF model card / Backstage spec.owner 惯例集合；非 schema 强制） */
export const OWNER_KEYS = ["owner", "ownerName", "maintainer", "responsible", "author", "creator"] as const;

function nonEmpty(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);
}

/**
 * 六项加权检查（合计 100）：schema_required 25 / owner 20 / relations 20 /
 * artifacts 15 / aliases 10 / tags 10。requiredFields 应来自类型链合并结果
 * （schemaToFormSpec 的 required 并集），与登记表单同一语义。
 */
export function computeCompleteness(input: {
  requiredFields: string[];
  properties: Record<string, unknown>;
  artifactsCount: number;
  relationsCount: number;
  aliasesCount: number;
  labelsCount: number;
  categoriesCount: number;
}): CompletenessReport {
  const missingRequired = input.requiredFields.filter((k) => !nonEmpty(input.properties[k]));
  const ownerHit = OWNER_KEYS.find((k) => nonEmpty(input.properties[k]) && typeof input.properties[k] === "string");
  const tagsCount = input.labelsCount + input.categoriesCount;

  const checks: CompletenessCheck[] = [
    {
      key: "schema_required",
      title: "必填属性齐备",
      passed: missingRequired.length === 0,
      detail:
        missingRequired.length === 0
          ? input.requiredFields.length > 0
            ? `类型链必填 ${input.requiredFields.length} 项全部齐备`
            : "类型未声明必填属性"
          : `缺少必填属性：${missingRequired.join("、")}`,
      hint: "在「修改资产」补齐后保存（登记与更新受 schema 关卡约束；此检查兜住历史欠账资产）",
      weight: 25,
    },
    {
      key: "owner",
      title: "负责人明确",
      passed: ownerHit !== undefined,
      detail: ownerHit !== undefined ? `负责人字段 ${ownerHit} 已设置` : "属性中没有负责人字段",
      hint: `在属性中填写惯例键之一：${OWNER_KEYS.join(" / ")}（HF model card / Backstage spec.owner 惯例）`,
      weight: 20,
    },
    {
      key: "relations",
      title: "已建立关联",
      passed: input.relationsCount > 0,
      detail: input.relationsCount > 0 ? `已确认关联 ${input.relationsCount} 条` : "尚无已确认关联（孤岛资产）",
      hint: "在图谱或详情建关系（依赖/派生/文档说明等）——寻找并维护关联是本平台的核心价值",
      weight: 20,
    },
    {
      key: "artifacts",
      title: "制品已挂",
      passed: input.artifactsCount > 0,
      detail: input.artifactsCount > 0 ? `当前修订挂有 ${input.artifactsCount} 个制品` : "当前修订没有制品文件",
      hint: "上传制品文件（实现/文档/数据）——制品随资产远程可下载、可批量打包",
      weight: 15,
    },
    {
      key: "aliases",
      title: "别名可引用",
      passed: input.aliasesCount > 0,
      detail: input.aliasesCount > 0 ? `已设 ${input.aliasesCount} 个别名` : "尚无别名",
      hint: "设置别名获得团队唯一的稳定短引用（@alias，MLflow @alias 思想）",
      weight: 10,
    },
    {
      key: "tags",
      title: "标签或分类",
      passed: tagsCount > 0,
      detail: tagsCount > 0 ? `标签 ${input.labelsCount}、分类 ${input.categoriesCount}` : "尚无标签与分类",
      hint: "打标签或归类——全文检索、分面筛选与家族快筛都依赖它们",
      weight: 10,
    },
  ];
  const score = checks.reduce((s, c) => s + (c.passed ? c.weight : 0), 0);
  return { score, checks };
}
