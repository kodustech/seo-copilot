/**
 * Find + verify work email for every contact missing email on a research list.
 *
 * Usage:
 *   npx tsx scripts/fill-missing-emails.ts <tableIdOrSlug>
 *   npx tsx scripts/fill-missing-emails.ts leads-qa-people-discovery-global
 */
import { getSupabaseServiceClient } from "../lib/supabase-server";
import { resolveTable } from "../lib/research/columns";
import { listPeople, listRows } from "../lib/research/tables";
import { fillEmailForPerson } from "../lib/research/waterfall";

async function main() {
  const tableRef = process.argv[2];
  if (!tableRef) {
    console.error("Usage: npx tsx scripts/fill-missing-emails.ts <tableIdOrSlug>");
    process.exit(1);
  }

  const client = getSupabaseServiceClient();
  const table = await resolveTable(client, tableRef);
  const rows = await listRows(client, table.id);

  type Target = {
    rowId: string;
    company: string;
    domain: string | null;
    personId: string;
    name: string;
  };

  const targets: Target[] = [];
  for (const row of rows) {
    const people = await listPeople(client, row.id);
    for (const p of people) {
      if (p.email?.trim()) continue;
      if (!p.name?.trim()) continue;
      targets.push({
        rowId: row.id,
        company: row.companyName,
        domain: row.domain,
        personId: p.id,
        name: p.name,
      });
    }
  }

  console.log(
    `${table.name} — ${rows.length} companies, ${targets.length} people missing email`,
  );
  if (targets.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  let found = 0;
  let miss = 0;
  let failed = 0;
  const samples: string[] = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    process.stdout.write(
      `[${i + 1}/${targets.length}] ${t.name} @ ${t.company}… `,
    );
    try {
      const result = await fillEmailForPerson(client, t.rowId, {
        personId: t.personId,
        personName: t.name,
      });
      if (result.found && result.email) {
        found += 1;
        const line = `${t.name} <${result.email}> (${result.emailStatus ?? "?"}) — ${t.company}`;
        samples.push(line);
        console.log(result.email, result.emailStatus ?? "");
      } else {
        miss += 1;
        console.log("no email");
      }
    } catch (err) {
      failed += 1;
      console.log("ERR", err instanceof Error ? err.message : err);
    }
    // light throttle for NeverBounce / NinjaPear
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log("\n---");
  console.log(`found=${found} miss=${miss} failed=${failed} total=${targets.length}`);
  if (samples.length) {
    console.log("\nFound:");
    for (const s of samples.slice(0, 40)) console.log(" ", s);
    if (samples.length > 40) console.log(`  … +${samples.length - 40} more`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
