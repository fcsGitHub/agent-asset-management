// 引用导出（M66④）：标准格式供 LaTeX/文献管理器。
// 锚点：Zenodo「Cite」框（BibTeX/DataCite 多格式一键导出）+ GitHub
// 「Cite this repository」生成的 @misc BibTeX。

export type CiteFormat = "bibtex" | "markdown";

export interface CiteInput {
  assetId: string;
  name: string;
  typeKey: string;
  typeVersion: string;
  /** 负责人惯例字段值（与完整度检查同一口径；缺失用占位并在 howpublished 如实标注） */
  owner?: string;
  /** 登记年份（默认当前年） */
  year?: number;
  aliases?: string[];
}

export interface CiteResult {
  format: CiteFormat;
  contentType: string;
  text: string;
}

/** BibTeX 特殊字符转义（花括号/反斜杠）。 */
function bibtexEscape(s: string): string {
  return s.replace(/\\/g, "\\textbackslash{}").replace(/[{}]/g, (c) => (c === "{" ? "\\{" : "\\}"));
}

export function buildCitation(input: CiteInput, format: CiteFormat): CiteResult {
  if (format === "markdown") {
    const alias = input.aliases && input.aliases.length > 0 ? `（别名 ${input.aliases.join("/")}）` : "";
    return {
      format,
      contentType: "text/markdown; charset=utf-8",
      text: `**${input.name}**（${input.typeKey} v${input.typeVersion}）— Team Asset Workspace 资产 id：${input.assetId}${alias}`,
    };
  }
  const key = `taw_${input.assetId.replace(/-/g, "").slice(0, 8)}`; // 前 8 位十六进制保证唯一
  const noteParts: string[] = [];
  if (input.owner === undefined) noteParts.push("owner 未在属性中声明");
  if (input.aliases && input.aliases.length > 0) noteParts.push(`aliases: ${input.aliases.map(bibtexEscape).join(", ")}`);
  const lines = [
    `@misc{${key},`,
    `  title = {${bibtexEscape(input.name)} (${bibtexEscape(input.typeKey)})},`,
    `  author = {${bibtexEscape(input.owner ?? "TAW 团队资产")}},`,
    `  year = {${input.year ?? new Date().getFullYear()}},`,
    `  howpublished = {Team Asset Workspace (TAW), asset ${input.assetId}, type ${input.typeKey} v${input.typeVersion}}`,
    ...(noteParts.length > 0 ? [`  note = {${noteParts.join("; ")}}`] : []),
    `}`,
  ];
  return { format, contentType: "application/x-bibtex; charset=utf-8", text: lines.join("\n") };
}
