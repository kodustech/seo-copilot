// Fires the influencer crons by hand, without waiting for the scheduler.
// Useful to test the pipeline end to end in dev.
//
// Usage:
//   npx tsx scripts/influencer-cron.ts content   # daily draft generation
//   npx tsx scripts/influencer-cron.ts publish   # publish approved activities

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const [, key, value] = m;
      if (process.env[key] === undefined) {
        process.env[key] = value.replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    // env may be injected directly
  }
}

async function main() {
  loadEnv();
  const mode = process.argv[2];

  if (mode === "content") {
    const { runInfluencerContentCron } = await import(
      "../lib/influencer/generation"
    );
    const results = await runInfluencerContentCron();
    if (!results.length) {
      console.log("No active personas — nothing to generate.");
    }
    for (const result of results) {
      console.log(
        `@${result.handle}: ${result.skipped ? "skipped (already generated today, or no X channel)" : `${result.generated} drafts`}` +
          (result.error ? ` — ERROR: ${result.error}` : ""),
      );
    }
    return;
  }

  if (mode === "publish") {
    const { runInfluencerPublishCron } = await import(
      "../lib/influencer/publish"
    );
    const summary = await runInfluencerPublishCron();
    console.log(
      `examined ${summary.examined}, published ${summary.published}, ` +
        `deferred ${summary.deferred}, rejected ${summary.rejected}, ` +
        `failed ${summary.failed}, skipped ${summary.skipped}`,
    );
    return;
  }

  console.error("Usage: npx tsx scripts/influencer-cron.ts content|publish");
  process.exit(1);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
