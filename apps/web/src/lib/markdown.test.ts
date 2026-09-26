// Markdown 渲染器单元测试：安全性（不注入 HTML）与常用语法块。
// 用 renderToStaticMarkup 在 Node 环境验证输出结构（无 DOM 依赖）。
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown";

const html = (text: string) => renderToStaticMarkup(Markdown({ text }));

describe("markdown 渲染器", () => {
  it("转义原始 HTML，不注入标签", () => {
    const out = html('<script>alert(1)</script> 与 <img src=x onerror=alert(1)>');
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });

  it("行内语法：粗体 / 斜体 / 行内代码 / 删除线", () => {
    const out = html("**粗体** *斜体* `code` ~~删除~~");
    expect(out).toContain("<strong>粗体</strong>");
    expect(out).toContain("<em>斜体</em>");
    expect(out).toContain('<code class="md-code">code</code>');
    expect(out).toContain("<del>删除</del>");
  });

  it("链接仅放行 http/https，javascript: 渲染为纯文本", () => {
    const ok = html("[官网](https://example.com)");
    expect(ok).toContain('href="https://example.com"');
    expect(ok).toContain('rel="noreferrer"');
    const bad = html("[钓鱼](javascript:alert(1))");
    // 不匹配链接规则：整体按纯文本原样展示，不产生 <a> 标签
    expect(bad).not.toContain("<a");
    expect(bad).toContain("[钓鱼](javascript:alert(1))");
  });

  it("代码围栏带语言标签，内部不解析行内语法", () => {
    const out = html("```ts\nconst a = **not bold**;\n```");
    expect(out).toContain("md-pre");
    expect(out).toContain("ts");
    expect(out).toContain("**not bold**");
    expect(out).not.toContain("<strong>");
  });

  it("GFM 表格", () => {
    const out = html("| 名称 | 版本 |\n| --- | --- |\n| 引擎 | r42 |");
    expect(out).toContain("<table>");
    expect(out).toContain("<th>名称</th>");
    expect(out).toContain("<td>引擎</td>");
  });

  it("无序与有序列表", () => {
    expect(html("- 甲\n- 乙")).toContain("<ul>");
    expect(html("1. 甲\n2. 乙")).toContain("<ol>");
  });

  it("标题（封顶 h4）、引用、分隔线、段落软换行", () => {
    expect(html("##### 五级")).toContain("<h4>五级</h4>");
    expect(html("> 引用内容")).toContain("<blockquote>");
    expect(html("上文\n\n---\n\n下文")).toContain("<hr");
    expect(html("第一行\n第二行")).toContain("<br");
  });
});
