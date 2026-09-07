/**
 * The tests import app modules through the "@/..." alias that tsconfig defines
 * for Next. Vitest doesn't read tsconfig paths, so without this every suite
 * fails to resolve before a single test runs — which is how the existing ones
 * had been failing unnoticed.
 */
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // The encryption tests only need SOME master key (it is hashed into the
    // AES key), never a real one. Without it they fail on a missing env var.
    env: { INFLUENCER_SECRETS_KEY: "vitest-only-not-a-real-key" },
  },
});
