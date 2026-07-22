/**
 * One-off: MOVE companies from a source research list into
 * "{name} — Brasil" and "{name} — Global" using the same classification
 * as lib/research/split preset (domain, firmo HQ, discovery, text).
 *
 * Usage:
 *   npx tsx scripts/split-list-br-global.ts [--table slug|id|name] [--dry-run]
 */
import { config } from "dotenv";
config({ path: ".env" });

import { createClient } from "@supabase/supabase-js";
import {
  getTable,
  getTableBySlug,
  listTables,
} from "../lib/research/tables";
import {
  presetBrazilVsWorldRules,
  splitTableByRules,
} from "../lib/research/split";
import { resolveTable } from "../lib/research/columns";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tableArgIdx = args.indexOf("--table");
  const tableRef =
    tableArgIdx >= 0 ? args[tableArgIdx + 1] : args.find((a) => !a.startsWith("-"));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing Supabase env");

  const client = createClient(url, key);

  let tableId: string;
  if (tableRef) {
    const t = await resolveTable(client, tableRef);
    tableId = t.id;
    console.log(`Source: ${t.name} (${t.slug ?? t.id})`);
  } else {
    const tables = await listTables(client);
    // Pick the table with most rows
    tables.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
    console.log("Tables (by size):");
    for (const t of tables.slice(0, 15)) {
      console.log(`  ${t.rowCount ?? 0} rows · ${t.name} · ${t.slug ?? t.id}`);
    }
    const biggest = tables[0];
    if (!biggest) throw new Error("No research tables");
    tableId = biggest.id;
    console.log(`\nUsing largest: ${biggest.name}`);
  }

  const source = await getTable(client, tableId);
  if (!source) throw new Error("Table not found");

  const preset = presetBrazilVsWorldRules(source.name);
  const result = await splitTableByRules(client, tableId, {
    rules: preset.rules,
    remainder: "new_list",
    remainderName: preset.remainderName,
    dryRun,
    createdByEmail: "script@local",
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) {
    console.log("\nDry run only. Re-run without --dry-run to execute.");
  } else {
    console.log("\nDone. Open the new lists in /research");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
