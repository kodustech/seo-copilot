/**
 * Dedupe research_people per company row (name / LinkedIn / email multi-key).
 *
 * Usage:
 *   npx tsx scripts/dedupe-research-people.ts <tableIdOrSlug>
 *   npx tsx scripts/dedupe-research-people.ts --all
 */
import { getSupabaseServiceClient } from "../lib/supabase-server";
import {
  dedupePeopleOnRow,
  listRows,
  listTables,
} from "../lib/research/tables";
import { resolveTable } from "../lib/research/columns";

async function dedupeTable(
  client: ReturnType<typeof getSupabaseServiceClient>,
  tableRef: string,
) {
  const table = await resolveTable(client, tableRef);
  const rows = await listRows(client, table.id);
  console.log(`\n${table.name} [${table.slug ?? table.id}] — ${rows.length} companies`);

  let rowsTouched = 0;
  let removed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const result = await dedupePeopleOnRow(client, row.id, {
      createdBy: "script:dedupe-research-people",
    });
    if (result.after < result.before) {
      rowsTouched += 1;
      removed += result.before - result.after;
      console.log(
        `  ${row.companyName}: ${result.before} → ${result.after} people`,
      );
    }
  }

  console.log(
    `Done: ${rowsTouched} companies cleaned, ${removed} duplicate contacts removed`,
  );
  return { rowsTouched, removed };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: npx tsx scripts/dedupe-research-people.ts <tableIdOrSlug> | --all",
    );
    process.exit(1);
  }

  const client = getSupabaseServiceClient();

  if (arg === "--all") {
    const tables = await listTables(client);
    let totalRemoved = 0;
    for (const t of tables) {
      const r = await dedupeTable(client, t.id);
      totalRemoved += r.removed;
    }
    console.log(`\nAll tables: ${totalRemoved} duplicates removed`);
    return;
  }

  await dedupeTable(client, arg);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
