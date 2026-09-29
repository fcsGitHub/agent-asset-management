// 使用片段模板（M57，HF/Terraform 思想）：按资产类型家族生成引用/调用片段，
// 服务「随取随用」——复制即可粘进下游配置、文档或 Agent 对话。
// 纯函数（packages/domain）：API 端点 /assets/:id/snippets 与单测共用同一实现。
// 片段是引用模板而非可执行保证：字段全部来自真实登记数据，不编造。

export interface SnippetInput {
  id: string;
  name: string;
  typeKey: string;
  typeVersion: string;
  aliases: string[];
  /** head 修订属性（家族专属片段的数据源；缺省为空对象） */
  properties?: Record<string, unknown> | null;
  /** head 修订内容摘要（hex） */
  contentDigest?: string | null;
}

export interface Snippet {
  kind: string;
  label: string;
  language: string;
  text: string;
}

/** 标量属性过滤 + 稳定键序（对象值如 validStepSeconds 展开为子键，深度 1）。 */
function flattenProps(props: Record<string, unknown> | null | undefined): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 !== null && typeof v2 !== "object") out.push([`${k}.${k2}`, String(v2)]);
      }
    } else {
      out.push([k, String(v)]);
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

function familyOf(typeKey: string): string {
  if (typeKey.startsWith("simulation.")) return "simulation";
  if (typeKey === "software") return "software";
  if (typeKey === "document") return "document";
  if (typeKey.startsWith("test.")) return "test";
  return "data";
}

export function buildSnippets(input: SnippetInput): Snippet[] {
  const alias = input.aliases[0];
  const ref = `资产「${input.name}」(id: ${input.id}, 类型 ${input.typeKey} v${input.typeVersion})`;
  const snippets: Snippet[] = [
    // 与 Agent @ 引用 / 复制引用同一格式（M54 约定）：下游粘进对话即可引用
    { kind: "agent-ref", label: "Agent 引用", language: "text", text: ref },
    {
      kind: "json",
      label: "JSON 引用",
      language: "json",
      text: JSON.stringify(
        {
          name: input.name,
          assetId: input.id,
          type: input.typeKey,
          version: `v${input.typeVersion}`,
          ...(alias ? { alias } : {}),
          ...(input.contentDigest ? { digest: input.contentDigest.slice(0, 16) } : {}),
        },
        null,
        2
      ),
    },
  ];
  if (alias) {
    snippets.push({
      kind: "short-ref",
      label: "别名短引用",
      language: "text",
      text: `assets:${alias}（解析为「${input.name}」v${input.typeVersion}；资产升级换版不断链）`,
    });
  }
  const family = familyOf(input.typeKey);
  if (family === "simulation") {
    const props = flattenProps(input.properties);
    snippets.push({
      kind: "config",
      label: "调用配置（YAML）",
      language: "yaml",
      text:
        `# 调用配置片段 —— ${input.name}（${input.typeKey} v${input.typeVersion}）\n` +
        `asset: ${alias ? `assets:${alias}` : input.id}\n` +
        (props.length ? props.map(([k, v]) => `${k}: ${v}`).join("\n") : "# （该资产 head 修订无标量属性）"),
    });
  } else if (family === "software") {
    snippets.push({
      kind: "dependency",
      label: "依赖声明（示意）",
      language: "json",
      text:
        `// 依赖声明片段（示意）—— ${input.name}\n` +
        `"${input.name}": {\n  "asset": "${alias ? `assets:${alias}` : input.id}",\n  "version": "v${input.typeVersion}"\n}`,
    });
  } else if (family === "document") {
    snippets.push({
      kind: "markdown-link",
      label: "文档引用（Markdown）",
      language: "markdown",
      text: `[${input.name}](asset:${input.id}) — ${input.typeKey} v${input.typeVersion}${alias ? `（别名 assets:${alias}）` : ""}`,
    });
  }
  return snippets;
}
