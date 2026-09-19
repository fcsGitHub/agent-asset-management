// 七类必需资产的默认类型定义（设计 8 章登记要求）+ 一类可注册扩展示例。
// 单位/坐标系/时间系统为受控词表（设计 8 章：受控词表或有定义的值）。
// 以下 JSON Schema 是本产品拟定格式，不是上游项目的官方格式。

export interface DefaultTypeDefinition {
  typeKey: string;
  version: string;
  title: string;
  jsonSchema: object;
  unitVocabularies: Record<string, string[]>;
}

const SPACE_UNITS = ["m", "km", "AU"];
const VELOCITY_UNITS = ["m/s", "km/s"];
const TIME_SCALES = ["TAI", "UTC", "TT", "TDB", "GPST"];
const FRAMES = ["ECI", "ECEF", "ICRF", "ITRF", "LVLH", "RTN"];
const ANGLE_UNITS = ["deg", "rad"];
const CONFIDENTIALITY = ["public", "internal", "restricted", "secret"];

export const DEFAULT_TYPE_DEFINITIONS: DefaultTypeDefinition[] = [
  {
    typeKey: "document",
    version: "1.0.0",
    title: "文档",
    jsonSchema: {
      type: "object",
      required: ["docRole", "format", "language", "confidentiality", "scope"],
      properties: {
        docRole: { type: "string", enum: ["interface-spec", "design", "report", "manual", "plan"] },
        format: { type: "string" },
        language: { type: "string", minLength: 2 },
        confidentiality: { type: "string", enum: CONFIDENTIALITY },
        scope: { type: "string" },
      },
    },
    unitVocabularies: {},
  },
  {
    typeKey: "software",
    version: "1.0.0",
    title: "软件",
    jsonSchema: {
      type: "object",
      required: ["language", "entry", "interfaceVersion", "runtime", "license"],
      properties: {
        language: { type: "string" },
        entry: { type: "string" },
        interfaceVersion: { type: "string" },
        runtime: { type: "string" },
        license: { type: "string" },
      },
    },
    unitVocabularies: {},
  },
  {
    typeKey: "simulation.model",
    version: "1.0.0",
    title: "仿真模型",
    jsonSchema: {
      type: "object",
      required: [
        "frame",
        "timeScale",
        "positionUnit",
        "velocityUnit",
        "interfaceVersion",
        "validStepSeconds",
      ],
      properties: {
        frame: { type: "string", enum: FRAMES },
        timeScale: { type: "string", enum: TIME_SCALES },
        positionUnit: { type: "string", enum: SPACE_UNITS },
        velocityUnit: { type: "string", enum: VELOCITY_UNITS },
        interfaceVersion: { type: "string" },
        validStepSeconds: {
          type: "object",
          required: ["min", "max"],
          properties: { min: { type: "number", minimum: 0 }, max: { type: "number" } },
        },
        validDomain: { type: "string" },
      },
    },
    unitVocabularies: { position: SPACE_UNITS, velocity: VELOCITY_UNITS, angle: ANGLE_UNITS, frame: FRAMES, timeScale: TIME_SCALES },
  },
  {
    typeKey: "simulation.engine",
    version: "1.0.0",
    title: "仿真引擎",
    jsonSchema: {
      type: "object",
      required: ["execProtocol", "acceptedInterfaces", "timeAdvance", "platform"],
      properties: {
        execProtocol: { type: "string" },
        acceptedInterfaces: { type: "array", items: { type: "string" }, minItems: 1 },
        timeAdvance: { type: "string", enum: ["fixed-step", "variable-step", "event-driven"] },
        randomness: { type: "string" },
        platform: { type: "string" },
      },
    },
    unitVocabularies: {},
  },
  {
    typeKey: "test.suite",
    version: "1.0.0",
    title: "测试库",
    jsonSchema: {
      type: "object",
      required: ["testTarget", "execProtocol", "fixtureVersion", "passThreshold"],
      properties: {
        testTarget: { type: "string" },
        execProtocol: { type: "string" },
        fixtureVersion: { type: "string" },
        assertions: { type: "array", items: { type: "string" } },
        passThreshold: { type: "number", minimum: 0, maximum: 1 },
      },
    },
    unitVocabularies: {},
  },
  {
    typeKey: "agent.template",
    version: "1.0.0",
    title: "Agent 库",
    jsonSchema: {
      type: "object",
      required: ["promptSpec", "modelConstraints", "toolAllowlist", "permissionCeiling"],
      properties: {
        promptSpec: { type: "string" },
        modelConstraints: { type: "string" },
        toolAllowlist: { type: "array", items: { type: "string" }, minItems: 1 },
        skills: { type: "array", items: { type: "string" } },
        permissionCeiling: { type: "string", enum: ["read-only", "draft-write", "sandbox-exec"] },
        evalSet: { type: "string" },
      },
    },
    unitVocabularies: {},
  },
  {
    typeKey: "simulation.scenario",
    version: "1.0.0",
    title: "仿真场景",
    jsonSchema: {
      type: "object",
      required: ["initialConditions", "timeRange", "seed"],
      properties: {
        initialConditions: { type: "object" },
        participants: { type: "array", items: { type: "string" } },
        environment: { type: "string" },
        timeRange: {
          type: "object",
          required: ["start", "end"],
          properties: { start: { type: "string" }, end: { type: "string" } },
        },
        seed: { type: "integer" },
      },
    },
    unitVocabularies: {},
  },
];

/** 设计 7 章：关系定义（首版默认集）。 */
export interface DefaultRelationType {
  typeKey: string;
  version: string;
  title: string;
  sourceKinds: string[];
  targetKinds: string[];
  cyclic: boolean;
  isSymmetric: boolean;
  requiresRevision: boolean;
}

const A = ["asset"];

export const DEFAULT_RELATION_TYPES: DefaultRelationType[] = [
  { typeKey: "partOf", version: "1.0.0", title: "属于", sourceKinds: A, targetKinds: A, cyclic: false, isSymmetric: false, requiresRevision: false },
  { typeKey: "maintainedBy", version: "1.0.0", title: "维护主体", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: false, requiresRevision: false },
  { typeKey: "dependsOn", version: "1.0.0", title: "依赖", sourceKinds: A, targetKinds: A, cyclic: false, isSymmetric: false, requiresRevision: true },
  { typeKey: "runsOn", version: "1.0.0", title: "运行于", sourceKinds: A, targetKinds: A, cyclic: false, isSymmetric: false, requiresRevision: true },
  { typeKey: "documentedBy", version: "1.0.0", title: "文档说明", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: false, requiresRevision: true },
  { typeKey: "implements", version: "1.0.0", title: "实现需求", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: false, requiresRevision: true },
  { typeKey: "verifies", version: "1.0.0", title: "验证", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: false, requiresRevision: true },
  { typeKey: "evidenceFor", version: "1.0.0", title: "证据针对", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: false, requiresRevision: true },
  { typeKey: "derivedFrom", version: "1.0.0", title: "派生自", sourceKinds: A, targetKinds: A, cyclic: false, isSymmetric: false, requiresRevision: true },
  { typeKey: "supersedes", version: "1.0.0", title: "取代", sourceKinds: A, targetKinds: A, cyclic: false, isSymmetric: false, requiresRevision: true },
  { typeKey: "compatibleWith", version: "1.0.0", title: "兼容", sourceKinds: A, targetKinds: A, cyclic: true, isSymmetric: true, requiresRevision: true },
];
