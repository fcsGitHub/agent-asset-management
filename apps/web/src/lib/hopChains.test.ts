// hopChains 纯函数单测（M52）：最短链、方向标注、环图不回头、孤立节点不产出。
import { describe, it, expect } from "vitest";
import { buildHopChains, chainNodes } from "./hopChains";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";
const D = "44444444-4444-4444-4444-444444444444";
const E = "55555555-5555-5555-5555-555555555555";

describe("buildHopChains", () => {
  it("线性链：每步方向按边真实方向标注", () => {
    // A -dependsOn→ B -partOf→ C（从 A 出发）
    const chains = buildHopChains(A, [
      { source: A, target: B, relKey: "dependsOn" },
      { source: B, target: C, relKey: "partOf" },
    ]);
    expect(chains.size).toBe(2);
    expect(chains.get(B)).toEqual({
      assetId: B, hops: 1,
      steps: [{ assetId: B, relKey: "dependsOn", forward: true }],
    });
    expect(chains.get(C)?.hops).toBe(2);
    expect(chains.get(C)?.steps).toEqual([
      { assetId: B, relKey: "dependsOn", forward: true },
      { assetId: C, relKey: "partOf", forward: true },
    ]);
    expect(chainNodes(A, chains.get(C)!)).toEqual([A, B, C]);
  });

  it("逆向走边：forward=false；最短优先（绕行更长路径不覆盖先到者）", () => {
    // C → A（逆向），且 A → D → C 是两跳正路：C 先经 1 跳逆边到达
    const chains = buildHopChains(A, [
      { source: C, target: A, relKey: "derivedFrom" },
      { source: A, target: D, relKey: "partOf" },
      { source: D, target: C, relKey: "verifies" },
    ]);
    expect(chains.get(C)?.hops).toBe(1);
    expect(chains.get(C)?.steps).toEqual([{ assetId: C, relKey: "derivedFrom", forward: false }]);
    expect(chains.get(D)?.hops).toBe(1);
  });

  it("环图：不回头、不产生重复链条；环边逆向 1 跳可达", () => {
    // A→B→C→A 环：无向 BFS 下 B（正向）与 C（沿 C→A 逆向）都是 1 跳
    const chains = buildHopChains(A, [
      { source: A, target: B, relKey: "partOf" },
      { source: B, target: C, relKey: "partOf" },
      { source: C, target: A, relKey: "partOf" },
    ]);
    expect(chains.size).toBe(2);
    expect(chains.get(B)?.hops).toBe(1);
    expect(chains.get(C)?.hops).toBe(1);
    expect(chains.get(C)?.steps).toEqual([{ assetId: C, relKey: "partOf", forward: false }]);
  });

  it("孤立边之外的资产不产出；空边集只有种子", () => {
    const chains = buildHopChains(A, []);
    expect(chains.size).toBe(0);
    expect(chains.has(E)).toBe(false);
  });
});
