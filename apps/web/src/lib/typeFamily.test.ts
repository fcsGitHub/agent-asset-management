// typeFamily 纯函数测试（M53）：家族前缀映射与自定义类型回落。
import { describe, expect, it } from "vitest";
import { TYPE_FAMILIES, typeFamilyOf } from "./typeFamily";

describe("typeFamilyOf", () => {
  it("内置类型命中各自家族", () => {
    expect(typeFamilyOf("document")?.key).toBe("document");
    expect(typeFamilyOf("software")?.key).toBe("software");
    expect(typeFamilyOf("test.suite")?.key).toBe("test");
    expect(typeFamilyOf("simulation.model")?.key).toBe("simulation");
    expect(typeFamilyOf("simulation.engine")?.key).toBe("simulation");
    expect(typeFamilyOf("dataset")?.key).toBe("data");
    expect(typeFamilyOf("data.pipeline")?.key).toBe("data");
  });

  it("自定义 type_key 未命中前缀时回落 null（不强行归类）", () => {
    expect(typeFamilyOf("qa.checklist")).toBeNull();
    expect(typeFamilyOf("design.spec")).toBeNull();
    expect(typeFamilyOf("agent.template")).toBeNull();
  });

  it("前缀互不吞并：document 优先于 data 前缀（首条命中即返回）", () => {
    // "document" 以 "data" 前缀不匹配；确保列表顺序不影响 "document" 判定
    expect(typeFamilyOf("document")?.key).not.toBe("data");
    expect(TYPE_FAMILIES.length).toBeGreaterThanOrEqual(5);
  });
});
