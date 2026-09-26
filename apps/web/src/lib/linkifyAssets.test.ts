// linkifyAssets 纯函数单测（M44）：正文中的资产名 → 可点击段。
import { describe, it, expect } from "vitest";
import { linkifyAssets } from "./linkifyAssets";

const A = { id: "4a8076b3-89ae-48cd-9711-976b14e21416", name: "轨道传播模型 A" };
const B = { id: "194ca48a-6e5d-40a0-98db-4dd1e9cb6398", name: "转移轨道分析报告" };

describe("linkifyAssets", () => {
  it("完整名称命中并切分前后文本", () => {
    const segs = linkifyAssets("检索到「转移轨道分析报告」共 1 个资产", [A, B]);
    expect(segs).toEqual([
      { kind: "text", text: "检索到「" },
      { kind: "asset", text: "转移轨道分析报告", id: B.id, name: "转移轨道分析报告" },
      { kind: "text", text: "」共 1 个资产" },
    ]);
  });

  it("同起点最长名优先（A 全名压过前缀名）", () => {
    const short = { id: "11111111-1111-4111-8111-111111111111", name: "轨道传播模型" };
    const segs = linkifyAssets("读取轨道传播模型 A 的最新修订", [short, A]);
    expect(segs[0]).toEqual({ kind: "text", text: "读取" });
    expect(segs[1]).toEqual({ kind: "asset", text: "轨道传播模型 A", id: A.id, name: "轨道传播模型 A" });
  });

  it("同一名多次出现各自成段；相邻两名各自命中", () => {
    const segs = linkifyAssets(`${A.name}依赖${B.name}，又见${A.name}`, [A, B]);
    expect(segs.filter((s) => s.kind === "asset").map((s) => s.text))
      .toEqual([A.name, B.name, A.name]);
  });

  it("短于 4 字符的名字不参与；无命中原样单段", () => {
    const noisy = { id: "22222222-2222-4222-8222-222222222222", name: "报告" };
    expect(linkifyAssets("这份报告不涉及资产名", [noisy])).toEqual([{ kind: "text", text: "这份报告不涉及资产名" }]);
    expect(linkifyAssets("完全没有命中", [A, B])).toEqual([{ kind: "text", text: "完全没有命中" }]);
  });

  it("空文本与空资产表安全返回", () => {
    expect(linkifyAssets("", [A])).toEqual([]);
    expect(linkifyAssets("任意文本", [])).toEqual([{ kind: "text", text: "任意文本" }]);
  });

  it("同名资产取先出现者的 id", () => {
    const dup = { id: "33333333-3333-4333-8333-333333333333", name: A.name };
    const segs = linkifyAssets(A.name, [A, dup]);
    expect(segs[0]).toEqual({ kind: "asset", text: A.name, id: A.id, name: A.name });
  });
});
