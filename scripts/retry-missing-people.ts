/**
 * Re-run people enrichment only for research rows that currently have 0 people.
 * Usage: npx tsx scripts/retry-missing-people.ts <tableId>
 */
import { getSupabaseServiceClient } from "../lib/supabase-server";
import { listRows, listPeople } from "../lib/research/tables";
import { enrichPeopleForRow } from "../lib/research/waterfall";
import { domainCacheKey } from "../lib/research/cache";

async function clearPeopleCache(client: ReturnType<typeof getSupabaseServiceClient>, domain: string) {
  // Soft-clear cache entry so empty results from last run don't stick around
  // (empty arrays already bypass cache in waterfall, but clear if partial junk exists)
  const key = domainCacheKey(domain, "people:v1");
  try {
    await client.from("enrichment_cache").delete().eq("cache_key", key);
  } catch {
    // table name may differ — ignore
  }
}

async function main() {
  const tableId = process.argv[2];
  if (!tableId) {
    console.error("Usage: npx tsx scripts/retry-missing-people.ts <tableId>");
    process.exit(1);
  }

  const client = getSupabaseServiceClient();
  const rows = await listRows(client, tableId);

  const missing: typeof rows = [];
  for (const r of rows) {
    const people = await listPeople(client, r.id);
    if (people.length === 0) missing.push(r);
  }

  console.log(`Table has ${rows.length} rows; ${missing.length} still missing people.`);
  if (missing.length === 0) {
    console.log("Nothing to retry.");
    return;
  }

  let ok = 0;
  let stillEmpty = 0;
  let failed = 0;
  let totalPeople = 0;
  const found: Array<{ company: string; domain: string | null; people: string }> = [];

  for (let i = 0; i < missing.length; i++) {
    const row = missing[i];
    process.stdout.write(
      `[${i + 1}/${missing.length}] ${row.companyName} (${row.domain})… `,
    );
    try {
      if (row.domain) await clearPeopleCache(client, row.domain);
      const people = await enrichPeopleForRow(client, row.id, {
        onlyIfPass: false,
        maxPeople: 3,
        verifyEmails: false, // faster retry path
      });
      if (people.length === 0) {
        stillEmpty += 1;
        console.log("0 people");
      } else {
        ok += 1;
        totalPeople += people.length;
        const summary = people
          .map(
            (p) =>
              `${p.name}${p.role ? ` <${p.role}>` : ""}${p.email ? ` ${p.email}` : ""}`,
          )
          .join("; ");
        console.log(`${people.length} people: ${summary}`);
        found.push({
          company: row.companyName,
          domain: row.domain,
          people: summary,
        });
      }
    } catch (err) {
      failed += 1;
      console.log(`FAILED: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("\nDone retry.");
  console.log({
    attempted: missing.length,
    newly_found: ok,
    still_empty: stillEmpty,
    failed,
    total_people_added: totalPeople,
  });
  if (found.length) {
    console.log("\n=== NEW FINDS ===");
    for (const f of found) {
      console.log(`- ${f.company} (${f.domain}): ${f.people}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
