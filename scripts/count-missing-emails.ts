import { resolveTable } from "../lib/research/columns";
import { listPeople, listRows } from "../lib/research/tables";
import { getSupabaseServiceClient } from "../lib/supabase-server";

async function main() {
  const ref = process.argv[2] ?? "leads-qa-people-discovery-global";
  const client = getSupabaseServiceClient();
  const table = await resolveTable(client, ref);
  const rows = await listRows(client, table.id);
  let total = 0;
  let missing = 0;
  let withEmail = 0;
  const samples: string[] = [];
  for (const row of rows) {
    const people = await listPeople(client, row.id);
    for (const p of people) {
      total += 1;
      if (p.email?.trim()) withEmail += 1;
      else {
        missing += 1;
        if (samples.length < 40) {
          samples.push(`${p.name} · ${p.role ?? "—"} · ${row.companyName} (${row.domain})`);
        }
      }
    }
  }
  console.log(JSON.stringify({ table: table.name, companies: rows.length, total, withEmail, missing }, null, 2));
  console.log("\nMissing:");
  for (const s of samples) console.log(" ", s);
  if (missing > samples.length) console.log(`  … +${missing - samples.length} more`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
