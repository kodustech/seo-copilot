import { classifyOrg, resolveDevCount } from "../lib/product-signals/classify";
import { collectOrgFacts } from "../lib/product-signals/collect";
import { evaluateOrg, MIN_DEVS, MIN_EMPLOYEES } from "../lib/product-signals/icp-gate";

// Simula o gate sem gastar crédito: enrichment sempre indisponível.
async function main() {
  const now = new Date();
  const orgs = await collectOrgFacts();
  console.log(`orgs coletadas: ${orgs.length}`);

  const withCodeHost = orgs.filter((o) => o.codeHostMemberCount != null);
  const withPr = orgs.filter((o) => o.prAuthorCount != null);
  console.log(`com code_host_member_count: ${withCodeHost.length}`);
  console.log(`com pr_author_count: ${withPr.length}`);

  const reasons = new Map<string, number>();
  const creates: string[] = [];
  let t2NeedingEnrichment = 0;

  for (const org of orgs) {
    const cls = classifyOrg(org, now);
    const d = await evaluateOrg(org, cls.tier, { enrich: async () => null });
    reasons.set(d.reason, (reasons.get(d.reason) ?? 0) + 1);
    if (d.reason === "enrichment_unavailable") t2NeedingEnrichment += 1;
    if (d.create) {
      creates.push(
        `${cls.tier?.padEnd(3)} | devs=${String(d.devCount).padEnd(4)} (${d.devCountSource.padEnd(10)}) | ${(org.derivedDomain ?? "").padEnd(32)} | ${org.orgName}`,
      );
    }
  }

  console.log(`\nlimiares: MIN_DEVS=${MIN_DEVS} (t0/t1), MIN_EMPLOYEES=${MIN_EMPLOYEES} (t2)`);
  console.log(`\ndecisões do gate:`);
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${r.padEnd(24)} ${n}`);
  }
  console.log(`\nt2 que precisariam de NinjaPear: ${t2NeedingEnrichment} (${t2NeedingEnrichment * 3} créditos)`);
  console.log(`\ncriaria conta (${creates.length}):`);
  for (const c of creates.sort()) console.log("  " + c);

  // Sanidade: dev_count nunca pode bater com seats.
  const suspicious = orgs.filter((o) => {
    const { devCount, source } = resolveDevCount(o);
    return devCount != null && source === "none";
  });
  console.log(`\nsanidade — devCount com source=none: ${suspicious.length} (esperado 0)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
