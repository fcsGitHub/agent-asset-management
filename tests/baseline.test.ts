// M0 基线：纯单元测试（无 mock 需求——被测对象为纯函数/常量）。
import { describe, expect, it } from "vitest";
import { SEVEN_REQUIRED_TYPES } from "@taw/domain";
import { API_PREFIX } from "@taw/contracts";
import { buildServer } from "@taw/api/server";

describe("M0 基线", () => {
  it("七类必需资产类型常量完整", () => {
    expect(SEVEN_REQUIRED_TYPES).toHaveLength(7);
    expect(SEVEN_REQUIRED_TYPES).toContain("simulation.model");
  });

  it("API 前缀契约", () => {
    expect(API_PREFIX).toBe("/api/v1");
  });

  it("API healthz 返回 ok", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: "api" });
    await app.close();
  });
});
