// @taw/domain — 资产、本体、发布、项目规则。随 M1 起逐步充实。
export const SEVEN_REQUIRED_TYPES = [
  "document",
  "software",
  "simulation.model",
  "simulation.engine",
  "test.suite",
  "agent.template",
  "simulation.scenario",
] as const;

export type RequiredAssetType = (typeof SEVEN_REQUIRED_TYPES)[number];
