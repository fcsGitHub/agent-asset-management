import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// 精确匹配（避免前缀别名把 @taw/storage/local-cas 吞进 @taw/storage）
const exact = (key: string, target: string) => ({
  find: new RegExp(`^${key.replace(/\//g, "\\/")}$`),
  replacement: r(target),
});

export default defineConfig({
  resolve: {
    alias: [
      exact("@taw/contracts", "./packages/contracts/src/index.ts"),
      exact("@taw/storage", "./packages/storage/src/index.ts"),
      exact("@taw/storage/local-cas", "./packages/storage/src/local-cas.ts"),
      exact("@taw/domain", "./packages/domain/src/index.ts"),
      exact("@taw/domain/defaults", "./packages/domain/src/defaults.ts"),
      exact("@taw/domain/validate", "./packages/domain/src/validate.ts"),
      exact("@taw/agent-adapter", "./packages/agent-adapter/src/index.ts"),
      exact("@taw/api/server", "./apps/api/src/server.ts"),
      exact("@taw/api", "./apps/api/src/server.ts"),
    ],
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
