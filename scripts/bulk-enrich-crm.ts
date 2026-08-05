// ---------------------------------------------------------------------------
// Bulk "Find people" over CRM accounts.
//
// The per-account path (the button, the MCP tool) exists; this is the same call
// in a loop with a budget around it. Worth its own script because the cost is
// real: the provider bills per search, per work-email lookup and per person
// profile, and it has no balance endpoint to check against, so a bulk run that
// nobody metered is a bill nobody predicted.
//
// Dry run by default. --apply is the only thing that spends.
//
//   npx tsx scripts/bulk-enrich-crm.ts --tier t1
//   npx tsx scripts/bulk-enrich-crm.ts --tier t2 --limit 5 --apply
//
// Flags:
//   --tier t0,t1,t2   which tiers to consider (default t0,t1,t2)
//   --limit N         stop after N accounts (default: all)
//   --max-people N    people per account (default 5) — the main cost dial
//   --apply           actually call the provider and write contacts
// ---------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

import { enrichCompanyContacts } from "@/lib/crm-enrich";
import { ninjapearCallCounts, resetNinjapearCallCounts } from "@/lib/ninjapear";

config({ path: ".env" });

/** Published rates, for turning a call count into a credit estimate.
 *  Ranges where the endpoint bills conditionally. */
const RATES: Record<string, { min: number; max: number; label: string }> = {
  "/api/v1/employee/search": { min: 2, max: 7, label: "employee search (2 + 1/person)" },
  "/api/v1/employee/work-email": { min: 0.5, max: 2, label: "work email (0.5 miss / 2 hit)" },
  "/api/v2/employee/profile": { min: 3, max: 3, label: "person profile (3, even when empty)" },
  "/api/v1/company/details": { min: 3, max: 3, label: "company details" },
  "/api/v1/company/employee-count": { min: 2, max: 2, label: "employee count" },
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

function creditRange(counts: Record<string, number>): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const [path, n] of Object.entries(counts)) {
    const r = RATES[path];
    // Unknown endpoint: count it as at least 1 credit rather than as free.
    min += n * (r?.min ?? 1);
    max += n * (r?.max ?? 3);
  }
  return { min, max };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const tiers = (arg("tier") ?? "t0,t1,t2").split(",").map((t) => t.trim());
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const maxPeople = Number(arg("max-people") ?? 5);

  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );

  const { data: companies, error } = await client
    .from("crm_companies")
    .select("id,name,domain,tier,trigger")
    .in("tier", tiers)
    .order("tier");
  if (error) throw new Error(`crm_companies: ${error.message}`);

  // Skip accounts that already have a LinkedIn URL on some contact: those went
  // through this once already, and re-running spends the same credits to
  // rediscover the same people.
  const ids = (companies ?? []).map((c) => c.id);
  const enriched = new Set<string>();
  for (let i = 0; i < ids.length; i += 50) {
    const { data } = await client
      .from("crm_contacts")
      .select("company_id,linkedin")
      .in("company_id", ids.slice(i, i + 50));
    for (const c of data ?? []) if (c.linkedin) enriched.add(c.company_id);
  }

  const targets = (companies ?? [])
    .filter((c) => c.domain && !enriched.has(c.id))
    .slice(0, limit === Infinity ? undefined : limit);

  const skippedNoDomain = (companies ?? []).filter((c) => !c.domain).length;

  console.log(
    `${companies?.length ?? 0} accounts in ${tiers.join("/")} — ` +
      `${enriched.size} already enriched, ${skippedNoDomain} without a domain, ` +
      `${targets.length} to process${limit !== Infinity ? ` (capped at ${limit})` : ""}`,
  );

  if (!apply) {
    const byTier = new Map<string, number>();
    for (const t of targets) byTier.set(t.tier!, (byTier.get(t.tier!) ?? 0) + 1);
    console.log("\nWould enrich:");
    for (const [t, n] of [...byTier.entries()].sort()) console.log(`  ${t}  ${n}`);
    console.log(
      `\nDry run — nothing spent. Run one small batch with --apply --limit 5 ` +
        `to measure real cost before committing to all ${targets.length}.`,
    );
    return;
  }

  resetNinjapearCallCounts();
  let created = 0;
  let withLinkedin = 0;
  const failures: string[] = [];

  for (const [i, co] of targets.entries()) {
    try {
      const r = await enrichCompanyContacts(client, co.id, { maxPeople });
      created += r.created;
      withLinkedin += r.people.filter((p) => p.linkedin).length;
      console.log(
        `[${i + 1}/${targets.length}] ${co.tier} ${co.domain} — ` +
          `found ${r.found}, created ${r.created}, updated ${r.updated}` +
          (r.note ? ` (${r.note})` : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${co.domain}: ${msg}`);
      console.log(`[${i + 1}/${targets.length}] ${co.domain} — FAILED: ${msg}`);
    }
  }

  const counts = ninjapearCallCounts();
  const { min, max } = creditRange(counts);
  console.log(`\n=== spend ===`);
  for (const [path, n] of Object.entries(counts)) {
    console.log(`  ${String(n).padStart(4)}  ${RATES[path]?.label ?? path}`);
  }
  console.log(`  estimated credits: ${min}–${max}`);
  if (targets.length > 0) {
    console.log(
      `  per account: ${(min / targets.length).toFixed(1)}–${(max / targets.length).toFixed(1)}`,
    );
  }
  console.log(
    `\ncontacts created: ${created}, of which with a LinkedIn URL: ${withLinkedin}`,
  );
  if (failures.length) {
    console.log(`\n${failures.length} failed:`);
    for (const f of failures) console.log(`  ${f}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
