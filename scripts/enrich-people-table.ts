/**
 * One-off: enrich people for all rows in a research table.
 * Usage: npx tsx scripts/enrich-people-table.ts <tableId> [--limit N]
 */
import { getSupabaseServiceClient } from "../lib/supabase-server";
import { listRows, listPeople } from "../lib/research/tables";
import { enrichPeopleForRow } from "../lib/research/waterfall";

async function main() {
  const tableId = process.argv[2];
  if (!tableId) {
    console.error("Usage: npx tsx scripts/enrich-people-table.ts <tableId> [--limit N]");
    process.exit(1);
  }
  const limitIdx = process.argv.indexOf("--limit");
  const limit =
    limitIdx >= 0 && process.argv[limitIdx + 1]
      ? Number(process.argv[limitIdx + 1])
      : undefined;

  const client = getSupabaseServiceClient();
  let rows = await listRows(client, tableId);
  if (limit && limit > 0) rows = rows.slice(0, limit);

  console.log(`Enriching people for ${rows.length} rows in ${tableId}…`);

  let ok = 0;
  let failed = 0;
  let totalPeople = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    process.stdout.write(
      `[${i + 1}/${rows.length}] ${row.companyName} (${row.domain})… `,
    );
    try {
      const people = await enrichPeopleForRow(client, row.id, {
        onlyIfPass: false,
        maxPeople: 3,
      });
      totalPeople += people.length;
      ok += 1;
      const names = people
        .map((p) => `${p.name}${p.role ? ` <${p.role}>` : ""}${p.email ? ` ${p.email}` : ""}`)
        .join("; ");
      console.log(`${people.length} people${names ? `: ${names}` : ""}`);
    } catch (err) {
      failed += 1;
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nDone.");
  console.log({ ok, failed, totalPeople });

  // Sample dump of first 5 with people
  const sampleRows = rows.slice(0, 5);
  for (const r of sampleRows) {
    const people = await listPeople(client, r.id);
    if (people.length === 0) continue;
    console.log(`\n${r.companyName}:`);
    for (const p of people) {
      console.log(`  - ${p.name} | ${p.role ?? "?"} | ${p.email ?? "no email"} | ${p.linkedin ?? ""}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
