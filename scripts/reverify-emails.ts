/**
 * Re-verify people emails with NeverBounce (fix config_missing / null status).
 *
 * Usage (prefer Railway so NEVERBOUNCE_API_KEY is present):
 *   railway run --service amiable-benevolence -- npx tsx scripts/reverify-emails.ts leads-qa-people-discovery-global
 */
import { verifyEmails } from "../lib/email-verifier";
import { resolveTable } from "../lib/research/columns";
import { listPeople, listRows, savePeople } from "../lib/research/tables";
import { getSupabaseServiceClient } from "../lib/supabase-server";

async function main() {
  const tableRef = process.argv[2];
  if (!tableRef) {
    console.error("Usage: npx tsx scripts/reverify-emails.ts <tableIdOrSlug>");
    process.exit(1);
  }

  const key = process.env.NEVERBOUNCE_API_KEY?.trim();
  console.log("NEVERBOUNCE_API_KEY present:", Boolean(key));
  if (!key) {
    console.error(
      "Missing NEVERBOUNCE_API_KEY. Run via: railway run --service amiable-benevolence -- npx tsx scripts/reverify-emails.ts …",
    );
    process.exit(1);
  }

  const client = getSupabaseServiceClient();
  const table = await resolveTable(client, tableRef);
  const rows = await listRows(client, table.id);

  type Item = {
    rowId: string;
    company: string;
    name: string;
    email: string;
    role: string | null;
    linkedin: string | null;
    prevStatus: string | null;
  };

  const items: Item[] = [];
  for (const row of rows) {
    const people = await listPeople(client, row.id);
    for (const p of people) {
      const email = p.email?.trim();
      if (!email) continue;
      const st = (p.emailStatus ?? "").toLowerCase();
      if (
        !st ||
        st === "config_missing" ||
        st === "error" ||
        st === "unknown"
      ) {
        items.push({
          rowId: row.id,
          company: row.companyName,
          name: p.name,
          email,
          role: p.role,
          linkedin: p.linkedin,
          prevStatus: p.emailStatus,
        });
      }
    }
  }

  console.log(
    `${table.name}: ${items.length} emails to re-verify (${rows.length} companies)`,
  );

  let ok = 0;
  let fail = 0;
  const byStatus = new Map<string, number>();

  // Batch of 5 to respect rate limits
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5);
    const verified = await verifyEmails(batch.map((b) => b.email));
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const v = verified[j];
      process.stdout.write(
        `[${i + j + 1}/${items.length}] ${item.name} <${item.email}>… `,
      );
      if (!v || v.status === "config_missing") {
        fail += 1;
        console.log("SKIP", v?.error ?? "config_missing");
        continue;
      }
      byStatus.set(v.status, (byStatus.get(v.status) ?? 0) + 1);
      await savePeople(
        client,
        item.rowId,
        [
          {
            name: item.name,
            role: item.role,
            linkedin: item.linkedin,
            email: item.email,
            emailStatus: v.status,
            emailSource: "provider",
            providerUsed: "neverbounce",
            confidence:
              v.status === "valid"
                ? 0.95
                : v.status === "catchall"
                  ? 0.6
                  : v.status === "invalid"
                    ? 0.1
                    : 0.4,
            notes: `reverify:${v.status}`,
          },
        ],
        { mode: "merge", reason: "reverify_email" },
      );
      ok += 1;
      console.log(`${item.prevStatus ?? "null"} → ${v.status}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log("\n---");
  console.log(`verified=${ok} skipped=${fail}`);
  console.log("by status:", Object.fromEntries(byStatus));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
