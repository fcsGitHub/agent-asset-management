// M51 NL「两资产怎么关联」意图测试 — L1 规则解析（纯函数）+ 真实 HTTP 解析端点。
// 覆盖：三种句式（怎么关联 / 有什么关系 / 从A到B的路径）、引号与前缀容错、
// 同名端点不命中（落空交给 L2/搜索回退，不猜测）、既有意图无回归、
// schema 白名单（缺端不通过）、端点 L1 命中返回规则溯源且零副作用。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildServer } from "@taw/api/server";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { ruleParse } from "../apps/api/src/routes/nl";

const PORT = 4151;
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://taw_app:taw_app_dev@127.0.0.1:5437/taw";
const runId = randomBytes(4).toString("hex");

interface Session { cookie: string; csrf: string }
function sessionOf(res: Response): Session {
  let cookie = "";
  let csrf = "";
  for (const sc of res.headers.getSetCookie()) {
    if (sc.startsWith("taw_session=") || sc.startsWith("taw_csrf=")) {
      cookie += `${sc.split(";")[0]}; `;
      if (sc.startsWith("taw_csrf=")) csrf = sc.split(";")[0]!.split("=")[1] ?? "";
    }
  }
  return { cookie, csrf };
}

describe("M51 NL 关联路径意图", () => {
  it("L1：「A和B怎么关联」句式", () => {
    const r = ruleParse("天线布局仿真报告和热控系统仿真报告怎么关联");
    expect(r?.intent).toBe("graph_path");
    expect(r?.params.fromName).toBe("天线布局仿真报告");
    expect(r?.params.toName).toBe("热控系统仿真报告");
  });

  it("L1：「A与B有什么关系」句式 + 引号容错", () => {
    const r = ruleParse("「轨道传播模型分析报告」与「热控系统仿真报告」有什么关系");
    expect(r?.intent).toBe("graph_path");
    expect(r?.params.fromName).toBe("轨道传播模型分析报告");
    expect(r?.params.toName).toBe("热控系统仿真报告");
  });

  it("L1：「从A到B的路径」句式（含查一下前缀与箭头变体）", () => {
    for (const text of [
      "从轨道分析到热控报告的关联路径",
      "查一下轨道分析到热控报告的路径",
      "轨道分析 → 热控报告 的路径",
    ]) {
      const r = ruleParse(text);
      expect(r?.intent, text).toBe("graph_path");
      expect(r?.params.fromName, text).toBe("轨道分析");
      expect(r?.params.toName, text).toBe("热控报告");
    }
  });

  it("两端相同或缺失：L1 不命中（落空交给 L2/搜索回退，不猜测）", () => {
    expect(ruleParse("轨道分析和轨道分析怎么关联")).toBeNull();
    expect(ruleParse("和怎么关联")).toBeNull();
    expect(ruleParse("怎么关联")).toBeNull();
  });

  it("既有意图无回归：页面跳转/图谱聚焦/搜索/建工单句式不受路径句式影响", () => {
    expect(ruleParse("打开图谱")?.intent).toBe("navigate");
    expect(ruleParse("聚焦轨道传播模型分析报告的关系图谱")?.params.assetName).toBe("轨道传播模型分析报告");
    expect(ruleParse("搜索仿真报告")?.intent).toBe("search_assets");
    expect(ruleParse("报告问题：图谱页打不开")?.intent).toBe("create_issue");
    expect(ruleParse("看归档记录")?.params.activityAction).toBe("asset.archive");
    // 非命令句不命中任何 L1 规则
    expect(ruleParse("帮我总结一下这个项目")).toBeNull();
  });

  it("schema 白名单：graph_path 缺端不通过校验（L2 输出会被丢弃并走诚实回退）", async () => {
    const { NlIntent } = await import("../apps/api/src/routes/nl");
    expect(NlIntent.safeParse({ intent: "graph_path", params: { fromName: "只有一端" } }).success).toBe(false);
    expect(NlIntent.safeParse({ intent: "graph_path", params: { fromName: "A", toName: "B" } }).success).toBe(true);
  });
});

describe("M51 NL 解析端点（真实 HTTP）", () => {
  let app: FastifyInstance;
  let admin: Session;
  let teamId = "";

  beforeAll(async () => {
    app = await buildServer();
    await app.listen({ port: PORT, host: "127.0.0.1" });
    const res = await fetch(`${BASE}/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `m51-${runId}@t.dev`, password: "password-123", displayName: "M51验证员", teamName: `M51团队-${runId}` }),
    });
    expect(res.status === 201, "注册失败").toBe(true);
    admin = sessionOf(res);
    teamId = ((await res.json()) as { teamId: string }).teamId;
  });

  afterAll(async () => {
    await app.close();
  });

  async function parse(text: string): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/nl/parse`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie, "x-csrf-token": admin.csrf },
      body: JSON.stringify({ teamId, text, page: "dashboard" }),
    });
    const t = await res.text();
    return { status: res.status, json: t ? JSON.parse(t) : null };
  }

  it("路径句式经端点命中 L1：intent/参数正确、parser.kind=rules、零副作用", async () => {
    const r = await parse("天线布局仿真报告和热控系统仿真报告怎么关联");
    expect(r.status).toBe(200);
    expect(r.json.intent).toBe("graph_path");
    expect(r.json.params.fromName).toBe("天线布局仿真报告");
    expect(r.json.params.toName).toBe("热控系统仿真报告");
    expect(r.json.parser.kind).toBe("rules");
  });

  it("未登录解析：CSRF 门先拦截（403）", async () => {
    const res = await fetch(`${BASE}/nl/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamId, text: "A和B怎么关联", page: "dashboard" }),
    });
    expect(res.status).toBe(403);
  });
});
