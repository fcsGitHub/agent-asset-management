import { readFileSync } from "node:fs";

export function loadEnvFile(): void {
  try {
    const content = readFileSync(new URL("../../../.env", import.meta.url), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]!] === undefined) {
        process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    /* 无 .env 时依赖真实环境变量 */
  }
}
