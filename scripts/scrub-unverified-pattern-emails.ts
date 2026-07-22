/**
 * Optional hygiene: clear *or* normalize weak pattern emails.
 *
 * Default mode = normalize (keep guess, force status unverified).
 * Pass --clear to delete unproven patterns (empty the cell).
 *
 * Usage:
 *   railway run --service amiable-benevolence -- npx tsx scripts/scrub-unverified-pattern-emails.ts <table>
 *   railway run --service amiable-benevolence -- npx tsx scripts/scrub-unverified-pattern-emails.ts <table> --clear
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
  clear: boolean,
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
        source === "pattern_guess" ||
        (p.providerUsed ?? "").includes("pattern") ||
        (p.notes ?? "").includes("email_pattern");

      if (isPattern && isWeakStatus(p.emailStatus)) {
        if (clear) {
          cleared += 1;
          dirty = true;
          return {
            ...p,
            email: null,
            emailStatus: null,
            emailSource: null,
            confidence: p.confidence,
            notes: [p.notes, "scrub:cleared_unproven_pattern"]
              .filter(Boolean)
              .join(" | "),
          };
        }
        if (p.emailStatus !== "unverified" || source !== "pattern_guess") {
          normalized += 1;
          dirty = true;
          return {
            ...p,
            emailStatus: "unverified",
            emailSource: source || "pattern_guess",
            confidence: Math.min(p.confidence ?? 0.3, 0.3),
          };
        }
        return p;
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
        { mode: "replace", reason: clear ? "scrub_clear" : "scrub_normalize" },
      );
    }
  }

  console.log(
    `${table.name}: cleared ${cleared} patterns, normalized ${normalized} (clear=${clear})`,
  );
  return { cleared, normalized };
}

async function main() {
  const args = process.argv.slice(2);
  const clear = args.includes("--clear");
  const arg = args.find((a) => a !== "--clear");
  if (!arg) {
    console.error(
      "Usage: npx tsx scripts/scrub-unverified-pattern-emails.ts <table|slug|--all> [--clear]",
    );
    process.exit(1);
  }
  const client = getSupabaseServiceClient();
  if (arg === "--all") {
    let c = 0;
    let n = 0;
    for (const t of await listTables(client)) {
      const r = await scrubTable(client, t.id, clear);
      c += r.cleared;
      n += r.normalized;
    }
    console.log(`Total cleared=${c} normalized=${n}`);
    return;
  }
  await scrubTable(client, arg, clear);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
