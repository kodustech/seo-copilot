// Smoke test: build the funnel for a month with the service client and print
// every node's value, so query errors surface before the page does.
import { fetchFunnel } from "@/lib/funnel/metrics";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

async function main() {
  const month = process.argv[2] ?? "2026-08";
  const t0 = Date.now();
  const f = await fetchFunnel(getSupabaseServiceClient(), month);
  console.log(`month ${f.month} (${f.periodStart}..${f.periodEnd}) in ${Date.now() - t0}ms`);
  for (const n of Object.values(f.nodes)) {
    console.log(`${n.id.padEnd(16)} ${String(n.value).padStart(8)}  ${n.display}  [${n.rows.length} rows]`);
  }
  for (const id of (process.argv[3] ?? "").split(",").filter(Boolean)) {
    console.log(`--- ${id}`);
    for (const r of f.nodes[id]?.rows ?? []) console.log(JSON.stringify(r));
  }
  console.log("rates:"); for (const r of f.rates) console.log(`  ${r.id.padEnd(16)} ${r.status.padEnd(5)} ${r.label}  ${r.note}`);
  console.log("bottlenecks:", JSON.stringify(f.bottlenecks, null, 1));
  console.log("facts:", f.facts);
  if (f.errors.length) console.log("errors:", f.errors);
}
main().catch((e) => { console.error(e); process.exit(1); });
