import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Load .env without adding a dependency. Node's --env-file is not applied to
// vitest workers, so the suite reads it here instead.
try {
  const raw = readFileSync(resolve(__dirname, "..", ".env"), "utf8");
  for (const line of raw.split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    const [, key, value] = m;
    if (process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
} catch {
  // CI may inject env vars directly.
}

if (!process.env.DATABASE_ADMIN_URL && !process.env.DATABASE_URL) {
  throw new Error("Tests need DATABASE_ADMIN_URL (or DATABASE_URL)");
}
