// toolRefs 纯函数单测（M41）：工具参数/结果 → 可跳转资产引用。
import { describe, it, expect } from "vitest";
import { toolAssetRefs } from "./toolRefs";

const A = "4a8076b3-89ae-48cd-9711-976b14e21416";
const B = "194ca48a-6e5d-40a0-98db-4dd1e9cb6398";

describe("toolAssetRefs", () => {
  it("从参数 assetId 提取（asset.getRevision / relation.query 形态）", () => {
    const refs = toolAssetRefs({ name: "asset.getRevision", args: { assetId: A } });
    expect(refs).toEqual([{ id: A, name: undefined }]);
  });

  it("asset.search 结果数组提取 {id,name}，并与参数去重", () => {
    const refs = toolAssetRefs({
      name: "asset.search",
      args: { q: "轨道" },
      result: [
        { id: A, name: "轨道传播模型 A", type_key: "agent.template", head_revision_id: "3470d028-0c02-4ea0-9eee-54b2b715943f" },
        { id: B, name: "转移轨道分析报告", type_key: "document", head_revision_id: "234a1156-9fc4-4502-9c9c-bdb641ffaa61" },
        { id: A, name: "轨道传播模型 A", type_key: "agent.template" },
      ],
    });
    expect(refs).toEqual([{ id: A, name: "轨道传播模型 A" }, { id: B, name: "转移轨道分析报告" }]);
  });

  it("修订对象（id 是修订 id）不误提为资产；结果对象的 assetId 可提取", () => {
    const revision = { id: "3470d028-0c02-4ea0-9eee-54b2b715943f", seq: 1, artifacts: [] };
    expect(toolAssetRefs({ name: "asset.getRevision", args: {}, result: revision })).toEqual([]);
    const withAsset = { asset_id: B, note: "ok" };
    expect(toolAssetRefs({ name: "proposal.create", args: {}, result: withAsset }))
      .toEqual([{ id: B, name: undefined }]);
  });

  it("非法 id / 非对象结果 / 空参数一律如实为空", () => {
    expect(toolAssetRefs({ name: "asset.search", args: { assetId: "not-a-uuid" } })).toEqual([]);
    expect(toolAssetRefs({ name: "external.notify", args: null, result: "ok" })).toEqual([]);
    expect(toolAssetRefs({ name: "issue.create", args: {}, result: 42 })).toEqual([]);
  });
});
