import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@taw/contracts": r("./packages/contracts/src/index.ts"),
      "@taw/storage": r("./packages/storage/src/index.ts"),
      "@taw/domain": r("./packages/domain/src/index.ts"),
      "@taw/agent-adapter": r("./packages/agent-adapter/src/index.ts"),
      "@taw/api/server": r("./apps/api/src/server.ts"),
      "@taw/api": r("./apps/api/src/server.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "apps/**/*.test.ts", "packages/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
