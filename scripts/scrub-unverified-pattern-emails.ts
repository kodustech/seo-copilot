/**
 * Clear pattern-guess emails that were never proven (unknown/unverified).
 * Keeps valid / catchall / bounced / invalid (invalid still useful as "don't use").
 * Provider-sourced unverified emails are kept but status normalized to unverified.
 *
 * Usage:
 *   railway run --service amiable-benevolence -- npx tsx scripts/scrub-unverified-pattern-emails.ts leads-qa-people-discovery-brasil
 *   railway run --service amiable-benevolence -- npx tsx scripts/scrub-unverified-pattern-emails.ts --all
 */
import { resolveTable } from "../lib/research/columns";
import {
  listPeople,
  listRows,
  listTables,
  savePeople,
} from "../lib/research/tables";
import { getSupabaseServiceClient } from "../lib/supabase-server";

function isWeakStatus(s: string | null | undefined) {
  const x = (s ?? "").toLowerCase();
  return !x || x === "unknown" || x === "unverified" || x === "config_missing" || x === "error";
}

async function scrubTable(
  client: ReturnType<typeof getSupabaseServiceClient>,
  ref: string,
) {
  const table = await resolveTable(client, ref);
  const rows = await listRows(client, table.id);
  let cleared = 0;
  let normalized = 0;

  for (const row of rows) {
    const people = await listPeople(client, row.id);
    let dirty = false;
    const next = people.map((p) => {
      if (!p.email?.trim()) return p;
      const source = (p.emailSource ?? "").toLowerCase();
      const isPattern =
        source === "pattern" ||
        (p.providerUsed ?? "").includes("pattern") ||
        (p.notes ?? "").includes("email_pattern:");

      if (isPattern && isWeakStatus(p.emailStatus)) {
        cleared += 1;
        dirty = true;
        return {
          ...p,
          email: null,
          emailStatus: null,
          emailSource: null,
          confidence: p.confidence,
          notes: [p.notes, "scrub:cleared_unproven_pattern"].filter(Boolean).join(" | "),
        };
      }
      if (isWeakStatus(p.emailStatus) && p.emailStatus !== "unverified") {
        normalized += 1;
        dirty = true;
        return { ...p, emailStatus: "unverified" };
      }
      return p;
    });

    if (dirty) {
      await savePeople(
        client,
        row.id,
        next.map((p) => ({
          name: p.name,
          role: p.role,
          linkedin: p.linkedin,
          email: p.email,
          emailStatus: p.emailStatus,
          emailSource: p.emailSource,
          providerUsed: p.providerUsed,
          confidence: p.confidence,
          notes: p.notes,
        })),
        { mode: "replace", reason: "scrub_unproven_pattern" },
      );
    }
  }

  console.log(
    `${table.name}: cleared ${cleared} unproven patterns, normalized ${normalized} statuses`,
  );
  return { cleared, normalized };
}

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error(
      "Usage: npx tsx scripts/scrub-unverified-pattern-emails.ts <table|slug|--all>",
    );
    process.exit(1);
  }
  const client = getSupabaseServiceClient();
  if (arg === "--all") {
    let c = 0;
    let n = 0;
    for (const t of await listTables(client)) {
      const r = await scrubTable(client, t.id);
      c += r.cleared;
      n += r.normalized;
    }
    console.log(`Total cleared=${c} normalized=${n}`);
    return;
  }
  await scrubTable(client, arg);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
