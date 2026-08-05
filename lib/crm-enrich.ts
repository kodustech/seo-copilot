import type { SupabaseClient } from "@supabase/supabase-js";

import { createContact, getCompany, listContacts, updateContact } from "@/lib/crm";
import { ninjapearPeople } from "@/lib/research/waterfall";

// ---------------------------------------------------------------------------
// Find the people behind a CRM account.
//
// Accounts created by the product-signals sweep carry whoever signed up, which
// is an email address and nothing else: across t0, t1 and t2 the CRM has a
// LinkedIn URL for 3 of 85 accounts and a job title for 5. Sequences with a
// LinkedIn step therefore produce queue tasks with no profile to open, and
// nothing tells you whether you are writing to a founder or an intern.
//
// The lookup itself already exists — it is what fills the research tables. This
// is only the path from a CRM account to it, which did not exist because the
// waterfall is built around research rows.
//
// Billed per call (searchEmployees is 2 credits plus 1 per person returned), so
// nothing here runs on a schedule. It runs when someone asks for one account.
// ---------------------------------------------------------------------------

/** Who we want to reach. Mirrors the default personas in the research rubric:
 *  the people who decide whether an engineering team keeps a tool. */
const DEFAULT_PERSONAS = [
  "Head of Engineering",
  "Engineering Manager",
  "CTO",
  "VP Engineering",
  "Founder",
];

export type EnrichCompanyResult = {
  companyId: string;
  domain: string | null;
  found: number;
  created: number;
  updated: number;
  skipped: number;
  people: Array<{
    name: string;
    role: string | null;
    linkedin: string | null;
    email: string | null;
    action: "created" | "updated" | "skipped";
  }>;
  note?: string;
};

function sameContact(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Look up people for one account and merge them into its contacts.
 *
 * Merging never overwrites: an existing contact gains a LinkedIn URL or a role
 * it was missing, and keeps everything it already had. The signup contact is
 * usually the only one with a verified email, and that email is what the
 * sequence sends to — losing it to a lookup result would be a bad trade.
 */
export async function enrichCompanyContacts(
  client: SupabaseClient,
  companyId: string,
  opts: { maxPeople?: number; personas?: string[] } = {},
): Promise<EnrichCompanyResult> {
  const company = await getCompany(client, companyId);
  if (!company) throw new Error("Company not found");

  const base: EnrichCompanyResult = {
    companyId,
    domain: company.domain,
    found: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    people: [],
  };

  if (!company.domain) {
    return { ...base, note: "Account has no domain — nothing to look up" };
  }

  const people = await ninjapearPeople(
    company.domain,
    company.name,
    opts.personas?.length ? opts.personas : DEFAULT_PERSONAS,
    Math.max(1, Math.min(opts.maxPeople ?? 5, 10)),
  );

  // Second pass for the LinkedIn URL. The people provider does not return
  // linkedin.com/in at all — it gives names, titles and work emails — so the
  // research waterfall pairs it with a search-and-verify step, and skipping
  // that is why a first version of this returned titles and no profiles.
  //
  // findVerifiedLinkedIn rejects a URL it cannot tie to the person and the
  // company rather than guessing. An empty LinkedIn is a task you skip; a wrong
  // one is a message to a stranger.
  const { findVerifiedLinkedIn } = await import("@/lib/research/linkedin-finder");
  const found = await Promise.all(
    people.map(async (p) => {
      if (p.linkedin) return p;
      const match = await findVerifiedLinkedIn({
        name: p.name,
        companyName: company.name,
        domain: company.domain,
        role: p.role,
      }).catch(() => null);
      return match?.url ? { ...p, linkedin: match.url } : p;
    }),
  );

  if (found.length === 0) {
    // Still counts as enriched: the lookup ran and established there is nothing
    // to find. That is a result, and the review queue must not keep offering
    // this account as unprocessed work — 4 of every 5 t2 accounts land here.
    await markEnriched(client, companyId);
    // ninjapearPeople returns [] both when the provider found nobody and when
    // NINJAPEAR_API_KEY is unset. Saying so beats reporting "0 people found"
    // for what may be a missing key.
    return {
      ...base,
      note: "No people returned. If this is unexpected, check NINJAPEAR_API_KEY.",
    };
  }

  const existing = await listContacts(client, companyId);
  const result: EnrichCompanyResult = { ...base, found: found.length };

  for (const person of found) {
    const match = existing.find(
      (c) =>
        sameContact(c.email, person.email) || sameContact(c.name, person.name),
    );

    if (match) {
      // Fill only the holes. Anything already recorded stays.
      const patch: { linkedin?: string; role?: string } = {};
      if (!match.linkedin && person.linkedin) patch.linkedin = person.linkedin;
      if (!match.role && person.role) patch.role = person.role;

      if (Object.keys(patch).length === 0) {
        result.skipped += 1;
        result.people.push({ ...personSummary(person), action: "skipped" });
        continue;
      }
      await updateContact(client, match.id, patch);
      result.updated += 1;
      result.people.push({ ...personSummary(person), action: "updated" });
      continue;
    }

    await createContact(client, companyId, {
      name: person.name,
      email: person.email,
      role: person.role,
      linkedin: person.linkedin,
      // Never steal primary from the signup contact: they are the one who
      // chose to be here, and their email is the verified one.
      isPrimary: false,
    });
    result.created += 1;
    result.people.push({ ...personSummary(person), action: "created" });
  }

  await markEnriched(client, companyId);
  return result;
}

/**
 * Move the account out of the "nobody has touched this" bucket.
 *
 * Only ever promotes from 'raw'. An account a human already vetted — 'ready' or
 * 'parked' — must not be dragged backwards by a re-run: the machine's opinion
 * does not overwrite the human's, which is the entire point of separating the
 * two states. Best-effort, because failing to update a label is not a reason to
 * discard contacts that were just written.
 */
async function markEnriched(
  client: SupabaseClient,
  companyId: string,
): Promise<void> {
  try {
    await client
      .from("crm_companies")
      .update({ prep_status: "enriched" })
      .eq("id", companyId)
      .eq("prep_status", "raw");
  } catch (err) {
    console.warn("[crm-enrich] failed to mark account enriched:", err);
  }
}

function personSummary(p: {
  name: string;
  role: string | null;
  linkedin: string | null;
  email: string | null;
}) {
  return { name: p.name, role: p.role, linkedin: p.linkedin, email: p.email };
}
