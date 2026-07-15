import type { SupabaseClient } from "@supabase/supabase-js";

import { discoverContacts } from "@/lib/contact-discovery";
import { verifyEmails } from "@/lib/email-verifier";
import {
  findWorkEmail,
  ninjapearEnabled,
  searchEmployees,
} from "@/lib/ninjapear";
import { getCached, setCache, domainCacheKey } from "@/lib/research/cache";
import { resolveRubric } from "@/lib/research/rubrics";
import {
  getRow,
  getTable,
  listPeople,
  replacePeople,
} from "@/lib/research/tables";

export type WaterfallPerson = {
  name: string;
  role: string | null;
  linkedin: string | null;
  email: string | null;
  emailStatus: string | null;
  emailSource: string | null;
  providerUsed: string | null;
  confidence: number | null;
  notes: string | null;
};

const ROLE_HINTS =
  /head of eng|engineering manager|eng manager|cto|vp eng|vp of eng|qa lead|sdet|founder|co-founder|chief technology|director of eng|quality/i;

function rankPerson(role: string | null, personas: string[]): number {
  if (!role) return 0;
  const lower = role.toLowerCase();
  let score = 0;
  for (const p of personas) {
    if (lower.includes(p.toLowerCase())) score += 10;
  }
  if (ROLE_HINTS.test(role)) score += 5;
  return score;
}

/**
 * People + email waterfall (P0 free path):
 * 1. team-page scrape + LLM extract (contact-discovery)
 * 2. email pattern guess already inside discoverContacts
 * 3. NeverBounce verify top candidates
 *
 * Optional P1: HUNTER_API_KEY / APOLLO_API_KEY can be wired later in providers.
 */
export async function enrichPeopleForRow(
  client: SupabaseClient,
  rowId: string,
  opts: {
    maxPeople?: number;
    verifyEmails?: boolean;
    onlyIfPass?: boolean;
  } = {},
): Promise<WaterfallPerson[]> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error(`Row ${rowId} not found`);
  if (!row.domain) throw new Error("Row has no domain — cannot find people");

  if (opts.onlyIfPass !== false && row.pass === false) {
    return [];
  }

  const table = await getTable(client, row.tableId);
  const rubric = table ? resolveRubric(table) : null;
  const personas = rubric?.default_personas ?? [
    "Head of Engineering",
    "CTO",
    "Founder",
  ];
  const maxPeople = opts.maxPeople ?? 3;

  const cacheKey = domainCacheKey(row.domain, "people:v1");
  const cached = await getCached<WaterfallPerson[]>(client, cacheKey);
  if (cached && cached.length > 0) {
    await replacePeople(client, rowId, cached);
    return cached;
  }

  // Provider 1: scrape + guess
  const discovered = await discoverContacts({
    domain: row.domain,
    maxPages: 6,
  });

  let people: WaterfallPerson[] = discovered.contacts
    .map((c) => ({
      name: c.name,
      role: c.role,
      linkedin: c.profileUrl,
      email: c.email,
      emailStatus: null as string | null,
      emailSource: c.emailSource,
      providerUsed: "contact-discovery",
      confidence:
        c.emailConfidence === "verified"
          ? 0.95
          : c.emailConfidence === "high"
            ? 0.8
            : c.emailConfidence === "medium"
              ? 0.55
              : 0.35,
      notes: c.notes,
    }))
    .sort(
      (a, b) =>
        rankPerson(b.role, personas) - rankPerson(a.role, personas) ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )
    .slice(0, maxPeople);

  // Provider 2: NinjaPear employee search by buyer persona + work-email
  // lookup. Credit-billed — only runs when scrape found nobody relevant.
  if (ninjapearEnabled() && people.length < maxPeople) {
    try {
      const npPeople = await ninjapearPeople(
        row.domain,
        personas,
        maxPeople - people.length,
      );
      if (npPeople.length > 0) {
        people = mergePeople(people, npPeople, maxPeople, personas);
      }
    } catch (err) {
      console.warn("[research/waterfall] NinjaPear failed:", err);
    }
  }

  // Optional Hunter domain search if configured and we still need people/emails.
  if (
    process.env.HUNTER_API_KEY?.trim() &&
    (people.length === 0 || people.every((p) => !p.email))
  ) {
    try {
      const hunterPeople = await hunterDomainSearch(row.domain, maxPeople);
      if (hunterPeople.length > 0) {
        people = mergePeople(people, hunterPeople, maxPeople, personas);
      }
    } catch (err) {
      console.warn("[research/waterfall] Hunter failed:", err);
    }
  }

  // Email verify waterfall step (NeverBounce).
  if (opts.verifyEmails !== false) {
    const emails = people
      .map((p) => p.email)
      .filter((e): e is string => Boolean(e));
    if (emails.length > 0) {
      const unique = [...new Set(emails)].slice(0, 12);
      const verified = await verifyEmails(unique);
      const byEmail = new Map(verified.map((v) => [v.email.toLowerCase(), v]));
      people = people.map((p) => {
        if (!p.email) return p;
        const v = byEmail.get(p.email.toLowerCase());
        if (!v) return p;
        return {
          ...p,
          emailStatus: v.status,
          confidence:
            v.status === "valid"
              ? Math.max(p.confidence ?? 0, 0.95)
              : v.status === "catchall"
                ? Math.max(p.confidence ?? 0, 0.6)
                : v.status === "invalid"
                  ? 0.1
                  : p.confidence,
          providerUsed: `${p.providerUsed}+neverbounce`,
        };
      });
    }
  }

  await replacePeople(client, rowId, people);
  await setCache(client, cacheKey, people, 60 * 60 * 24 * 14);
  return people;
}

/**
 * NinjaPear provider: search employees by the rubric's top buyer persona,
 * then resolve work emails for up to `max` matches. Credit cost per row:
 * one search (2 + 1/result) + up to `max` email lookups (2 hit / 0.5 miss).
 */
async function ninjapearPeople(
  domain: string,
  personas: string[],
  max: number,
): Promise<WaterfallPerson[]> {
  const role = personas[0] ?? "CTO";
  const employees = await searchEmployees({ companyWebsite: domain, role });
  const top = employees.slice(0, Math.max(max, 1));

  const out: WaterfallPerson[] = [];
  for (const e of top) {
    let email: string | null = null;
    try {
      email = await findWorkEmail({
        firstName: e.first_name,
        lastName: e.last_name,
        domain,
      });
    } catch (err) {
      console.warn("[research/waterfall] work-email lookup failed:", err);
    }
    out.push({
      name: [e.first_name, e.last_name].filter(Boolean).join(" "),
      role: e.role,
      linkedin: null,
      email,
      emailStatus: null,
      emailSource: email ? "provider" : null,
      providerUsed: "ninjapear",
      confidence: email ? 0.85 : 0.6,
      notes: null,
    });
  }
  return out;
}

function mergePeople(
  a: WaterfallPerson[],
  b: WaterfallPerson[],
  max: number,
  personas: string[],
): WaterfallPerson[] {
  const byKey = new Map<string, WaterfallPerson>();
  for (const p of [...a, ...b]) {
    const key = (p.email ?? p.name).toLowerCase();
    const prev = byKey.get(key);
    if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) {
      byKey.set(key, p);
    }
  }
  return [...byKey.values()]
    .sort(
      (x, y) =>
        rankPerson(y.role, personas) - rankPerson(x.role, personas) ||
        (y.confidence ?? 0) - (x.confidence ?? 0),
    )
    .slice(0, max);
}

async function hunterDomainSearch(
  domain: string,
  limit: number,
): Promise<WaterfallPerson[]> {
  const key = process.env.HUNTER_API_KEY!.trim();
  const url = new URL("https://api.hunter.io/v2/domain-search");
  url.searchParams.set("domain", domain);
  url.searchParams.set("api_key", key);
  url.searchParams.set("limit", String(Math.min(limit, 10)));

  const res = await fetch(url.toString(), { cache: "no-store" });
  if (!res.ok) throw new Error(`Hunter HTTP ${res.status}`);
  const data = (await res.json()) as {
    data?: {
      emails?: Array<{
        value?: string;
        first_name?: string;
        last_name?: string;
        position?: string;
        linkedin?: string;
        confidence?: number;
      }>;
    };
  };

  return (data.data?.emails ?? []).map((e) => ({
    name: [e.first_name, e.last_name].filter(Boolean).join(" ") || e.value || "Unknown",
    role: e.position ?? null,
    linkedin: e.linkedin ?? null,
    email: e.value ?? null,
    emailStatus: null,
    emailSource: "provider" as const,
    providerUsed: "hunter",
    confidence: e.confidence != null ? e.confidence / 100 : 0.7,
    notes: null,
  }));
}

export async function enrichPeopleForRows(
  client: SupabaseClient,
  rowIds: string[],
  opts: { onlyIfPass?: boolean; maxPeople?: number } = {},
): Promise<{ ok: number; failed: number; totalPeople: number }> {
  let ok = 0;
  let failed = 0;
  let totalPeople = 0;
  for (const id of rowIds) {
    try {
      const people = await enrichPeopleForRow(client, id, opts);
      totalPeople += people.length;
      ok += 1;
    } catch (err) {
      console.error(`[research/waterfall] row ${id}:`, err);
      failed += 1;
    }
  }
  return { ok, failed, totalPeople };
}

export async function getPeople(
  client: SupabaseClient,
  rowId: string,
): Promise<WaterfallPerson[]> {
  const people = await listPeople(client, rowId);
  return people.map((p) => ({
    name: p.name,
    role: p.role,
    linkedin: p.linkedin,
    email: p.email,
    emailStatus: p.emailStatus,
    emailSource: p.emailSource,
    providerUsed: p.providerUsed,
    confidence: p.confidence,
    notes: p.notes,
  }));
}
