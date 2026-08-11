import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // These talk to the real Railway database; the default 5s is not enough
    // over the TCP proxy.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Fixtures roll back, but concurrent suites still share one database.
    fileParallelism: false,
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    alias: { "@": resolve(__dirname, ".") },
  },
});
