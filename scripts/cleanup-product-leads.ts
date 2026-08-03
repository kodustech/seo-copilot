/**
 * Re-applies the current ICP gate to CRM accounts the product-signals sweep
 * created before the gate existed, and reports what no longer qualifies.
 *
 * Dry-run by default: prints the verdict per account and writes nothing.
 *   npx tsx --env-file=.env scripts/cleanup-product-leads.ts
 *   npx tsx --env-file=.env scripts/cleanup-product-leads.ts --enrich
 *   npx tsx --env-file=.env scripts/cleanup-product-leads.ts --enrich --apply
 *
 * --enrich  allows NinjaPear lookups for t2 accounts (2 credits on a cache
 *           miss, free on a hit). Without it, t2 accounts with no cached
 *           firmographics are reported as "undecided", not proposed for deletion.
 * --apply   actually deletes the accounts in the "remove" bucket.
 *
 * Never proposes removing an account a human has invested in: anything past
 * `lead`, with an owner, with logged activity, or enrolled in a sequence is
 * always kept, whatever the gate says.
 */
import { deleteCompany } from "../lib/crm";
import { classifyOrg } from "../lib/product-signals/classify";
import { collectOrgFacts } from "../lib/product-signals/collect";
import { evaluateOrg, getEnrichment } from "../lib/product-signals/icp-gate";
import { getSupabaseServiceClient } from "../lib/supabase-server";

const APPLY = process.argv.includes("--apply");
const ENRICH = process.argv.includes("--enrich");

type Row = {
  id: string;
  name: string;
  domain: string | null;
  org_id: string | null;
  tier: string | null;
  status: string;
  owner_email: string | null;
  dev_count: number | null;
};

async function main() {
  const client = getSupabaseServiceClient();
  const now = new Date();

  const { data, error } = await client
    .from("crm_companies")
    .select("id,name,domain,org_id,tier,status,owner_email,dev_count")
    .eq("source", "product")
    .limit(2000);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Row[];

  // Human investment markers — any of these pins the account.
  const ids = rows.map((r) => r.id);
  const { data: acts } = await client
    .from("crm_activities")
    .select("company_id,type")
    .in("company_id", ids);
  const touched = new Set(
    (acts ?? [])
      .filter((a) => a.type !== "signal") // sweep-written signals are not human touches
      .map((a) => a.company_id as string),
  );
  const { data: enrollments } = await client
    .from("outreach_enrollments")
    .select("crm_company_id")
    .in("crm_company_id", ids);
  const enrolled = new Set(
    (enrollments ?? []).map((e) => e.crm_company_id as string).filter(Boolean),
  );

  const orgs = await collectOrgFacts();
  const byOrg = new Map(orgs.map((o) => [o.orgId, o]));

  let lookups = 0;
  const enrich = async (domain: string) => {
    if (!ENRICH) {
      const { data: cached } = await client
        .from("company_enrichment")
        .select("domain,employee_count,industry,country,error,fetched_at")
        .eq("domain", domain)
        .maybeSingle();
      return (cached as Awaited<ReturnType<typeof getEnrichment>>) ?? null;
    }
    lookups += 1;
    return getEnrichment(client, domain, now);
  };

  const keep: string[] = [];
  const pinned: string[] = [];
  const remove: Array<{ row: Row; reason: string }> = [];
  const undecided: string[] = [];

  for (const row of rows) {
    const label = `${(row.tier ?? "-").padEnd(3)} | ${(row.domain ?? "—").padEnd(32).slice(0, 32)} | ${row.name}`;

    if (
      row.status !== "lead" ||
      row.owner_email ||
      touched.has(row.id) ||
      enrolled.has(row.id) ||
      row.tier === "customer"
    ) {
      pinned.push(`${label}  [${row.status}${row.owner_email ? ", owner" : ""}${touched.has(row.id) ? ", atividade" : ""}${enrolled.has(row.id) ? ", sequência" : ""}]`);
      continue;
    }

    const org = row.org_id ? byOrg.get(row.org_id) : undefined;
    if (!org) {
      undecided.push(`${label}  [org não encontrada no produto]`);
      continue;
    }

    const cls = classifyOrg(org, now);
    const decision = await evaluateOrg(org, cls.tier, { enrich });

    if (decision.create) {
      keep.push(`${label}  [${decision.reason}, devs=${decision.devCount ?? "?"}]`);
    } else if (decision.reason === "enrichment_unavailable") {
      undecided.push(`${label}  [sem firmografia em cache — rode com --enrich]`);
    } else {
      remove.push({ row, reason: decision.reason });
    }
  }

  const show = (title: string, list: string[]) => {
    console.log(`\n=== ${title} (${list.length}) ===`);
    for (const l of list.sort()) console.log("  " + l);
  };

  show("MANTÉM — passa no gate", keep);
  show("MANTÉM — humano já investiu (nunca remove)", pinned);
  show("INDECISO — falta dado", undecided);

  console.log(`\n=== REMOVER (${remove.length}) ===`);
  const byReason = new Map<string, string[]>();
  for (const { row, reason } of remove) {
    const l = `${(row.tier ?? "-").padEnd(3)} | ${(row.domain ?? "—").padEnd(32).slice(0, 32)} | ${row.name}`;
    if (!byReason.has(reason)) byReason.set(reason, []);
    byReason.get(reason)!.push(l);
  }
  for (const [reason, list] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  -- ${reason} (${list.length})`);
    for (const l of list.sort()) console.log("    " + l);
  }

  console.log(
    `\nresumo: ${rows.length} contas | mantém ${keep.length} | pinned ${pinned.length} | indeciso ${undecided.length} | remover ${remove.length}`,
  );
  if (ENRICH)
    console.log(
      `consultas de firmografia: ${lookups} (só as que não estavam em cache são cobradas, 2 créditos cada)`,
    );

  if (!APPLY) {
    console.log("\nDRY RUN — nada foi alterado. Rode com --apply para remover.");
    return;
  }
  for (const { row } of remove) {
    await deleteCompany(client, row.id);
  }
  console.log(`\n${remove.length} contas removidas.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
