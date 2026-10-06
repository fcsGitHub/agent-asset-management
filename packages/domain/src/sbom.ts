// SBOM 导出（M70）：把「资产 + confirmed 关系闭包 + 制品校验和」输出为 CycloneDX 1.5 JSON。
// 调研吸收：OWASP CycloneDX——软件物料清单是资产/供应链互操作的事实标准，1.5 新增
// machine-learning-model 与 data 组件类型，与本项目七类资产天然对位；依赖图用
// bom-ref/dependsOn 表达，与 M58 bundle 的自定义 manifest 同一份数据的标准化视图
// （bundle 面向离线取用，SBOM 面向供应链工具消费）。纯函数：API 路由与单测共用。

// CycloneDX 1.5 component.type 枚举（本项目用到的子集）
export type CdxComponentType =
  | "application"
  | "library"
  | "framework"
  | "container"
  | "operating-system"
  | "device"
  | "firmware"
  | "file"
  | "machine-learning-model"
  | "data";

/** 类型键 → CycloneDX 组件类型（按点号首段家族映射，未识别回落 application 并如实保留原键）。 */
export function typeKeyToComponentType(typeKey: string): CdxComponentType {
  const head = (typeKey.split(".")[0] ?? "").toLowerCase();
  switch (head) {
    case "software":
      return "application";
    case "test":
      return "library";
    case "simulation":
      // simulation.model → ML 模型；engine/scenario 等按应用交付
      return typeKey.toLowerCase() === "simulation.model" ? "machine-learning-model" : "application";
    case "agent":
      return "application";
    case "document":
      return "file";
    case "data":
      return "data";
    default:
      return "application";
  }
}

export interface SbomAsset {
  id: string;
  name: string;
  typeKey: string;
  typeVersion: string;
  lifecycle: string;
  revisionSeq: number;
  contentDigest: string;
  artifacts: { digest: string; originalName: string; mediaType: string; size: number }[];
  /** 弃用元数据（M70）：deprecated 时写入组件 properties，供应链消费方可告警 */
  deprecatedAt?: string | null;
  deprecationNote?: string | null;
  successor?: { id: string; name: string } | null;
}

export interface SbomEdge {
  fromAssetId: string;
  toAssetId: string;
  predicate: string;
}

export interface SbomInput {
  /** 主体资产（metadata.component） */
  subject: SbomAsset;
  /** 关系闭包内的全部资产（含主体；主体之外进入 components） */
  assets: SbomAsset[];
  /** 闭包所依据的 confirmed 关系边（dependencies 的 dependsOn 就来自这里，方向=依赖方→被依赖方） */
  edges: SbomEdge[];
  generatedAt: string;
  /** urn:uuid:… 由调用方生成（纯函数不引入随机源，同输入同输出便于测试） */
  serialNumber: string;
}

interface CdxHash { alg: string; content: string }
interface CdxProperty { name: string; value: string }
interface CdxComponent {
  "bom-ref": string;
  type: CdxComponentType;
  name: string;
  version: string;
  hashes?: CdxHash[];
  properties?: CdxProperty[];
}
interface CdxDependency { ref: string; dependsOn: string[] }

/** bom-ref 确定性规则：urn:taw:asset:{assetId}@r{seq}——修订号入 ref，不同修订不同身份。 */
function bomRefOf(a: SbomAsset): string {
  return `urn:taw:asset:${a.id}@r${a.revisionSeq}`;
}

function componentOf(a: SbomAsset): CdxComponent {
  const hashes: CdxHash[] = a.artifacts.map((x) => ({ alg: "SHA-256", content: x.digest }));
  const props: CdxProperty[] = [
    { name: "taw:typeKey", value: a.typeKey },
    { name: "taw:typeVersion", value: a.typeVersion },
    { name: "taw:lifecycle", value: a.lifecycle },
    { name: "taw:revisionDigest", value: a.contentDigest },
  ];
  if (a.lifecycle === "deprecated") {
    if (a.deprecatedAt) props.push({ name: "taw:deprecatedAt", value: a.deprecatedAt });
    if (a.deprecationNote) props.push({ name: "taw:deprecationNote", value: a.deprecationNote });
    if (a.successor) props.push({ name: "taw:successor", value: `${a.successor.name} (${a.successor.id})` });
  }
  const c: CdxComponent = {
    "bom-ref": bomRefOf(a),
    type: typeKeyToComponentType(a.typeKey),
    name: a.name,
    version: `r${a.revisionSeq}`,
    properties: props,
  };
  if (hashes.length > 0) c.hashes = hashes;
  return c;
}

export interface CycloneDxDocument {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  serialNumber: string;
  version: number;
  metadata: {
    timestamp: string;
    tools?: { vendor: string; name: string; version: string }[];
    component: CdxComponent;
  };
  components: CdxComponent[];
  dependencies: CdxDependency[];
}

/** 组装 CycloneDX 1.5 文档。dependsOn 只列「闭包资产集内」的出边目标——
 *  集外的边不虚报（闭包截断时如实收窄），集合内每个资产（含主体）都有一条
 *  dependencies 条目（无出边则空数组，SPDX/CycloneDX 均要求显式空依赖可区分「无依赖」
 *  与「未知依赖」）。 */
export function buildSbom(input: SbomInput): CycloneDxDocument {
  const byId = new Map(input.assets.map((a) => [a.id, a]));
  const subject = byId.get(input.subject.id) ?? input.subject;
  const refOf = new Map(input.assets.map((a) => [a.id, bomRefOf(a)]));
  const dependsOn = new Map<string, Set<string>>();
  for (const a of input.assets) dependsOn.set(a.id, new Set());
  for (const e of input.edges) {
    const from = dependsOn.get(e.fromAssetId);
    const toRef = refOf.get(e.toAssetId);
    if (from && toRef) from.add(toRef); // 两端都在闭包内才计入
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: input.serialNumber,
    version: 1,
    metadata: {
      timestamp: input.generatedAt,
      tools: [{ vendor: "taw", name: "team-asset-workspace", version: "1" }],
      component: componentOf(subject),
    },
    components: input.assets
      .filter((a) => a.id !== subject.id)
      .map((a) => componentOf(a)),
    dependencies: input.assets.map((a) => ({
      ref: refOf.get(a.id) ?? bomRefOf(a),
      dependsOn: [...(dependsOn.get(a.id) ?? new Set())].sort(),
    })),
  };
}
