import type { SupabaseClient } from "@supabase/supabase-js";

import { discoverContacts } from "@/lib/contact-discovery";
import { verifyEmails } from "@/lib/email-verifier";
import {
  findWorkEmail,
  lookupPersonEmployment,
  ninjapearEnabled,
  searchEmployees,
  splitPersonName,
  type NinjapearEmployee,
} from "@/lib/ninjapear";
import { getCached, setCache, domainCacheKey } from "@/lib/research/cache";
import { resolveRubric } from "@/lib/research/rubrics";
import {
  getRow,
  getTable,
  listPeople,
  replacePeople,
  savePeople,
} from "@/lib/research/tables";
import type { ResearchPerson } from "@/lib/research/types";

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

function appendNote(notes: string | null, bit: string): string {
  return [notes, bit].filter(Boolean).join(" | ");
}

/**
 * People + email waterfall:
 * 1. team-page scrape + LLM extract (contact-discovery)
 * 2. NinjaPear employee search by buyer personas + work-email + person profile
 *    (employment verification via work_history — no LinkedIn URL from Nubela)
 * 3. Hunter domain search if still empty / missing emails
 * 4. NeverBounce verify
 * 5. LinkedIn via Exa with company evidence (NinjaPear cannot return /in/ URLs)
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

  // Soft skip research for fail rows, but never erase people already saved.
  if (opts.onlyIfPass !== false && row.pass === false) {
    const existingOnly = await listPeople(client, rowId);
    return existingOnly.map((p) => ({
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

  const table = await getTable(client, row.tableId);
  const rubric = table ? resolveRubric(table) : null;
  const personas = rubric?.default_personas ?? [
    "Head of Engineering",
    "CTO",
    "Founder",
  ];
  // Soft cap for NEW discoveries only — existing people are never dropped.
  const maxPeople = opts.maxPeople ?? 3;

  // Preserve anyone already on the row (manual / prior enrich). Merge-only writes.
  const existing = await listPeople(client, rowId);
  const existingAsWaterfall: WaterfallPerson[] = existing.map((p) => ({
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

  // v3: NinjaPear person profile employment + multi-persona search
  const cacheKey = domainCacheKey(row.domain, "people:v3");
  const cached = await getCached<WaterfallPerson[]>(client, cacheKey);
  // Never wipe existing with cache alone — merge cache into what we already have.
  if (cached && cached.length > 0 && existingAsWaterfall.length === 0) {
    await replacePeople(client, rowId, cached, {
      mode: "merge",
      reason: "people_cache_hit",
    });
    return (await listPeople(client, rowId)).map((p) => ({
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

  // Cap only applies to how many *new* contacts we pull — never shrinks the set.
  const cap = Math.max(maxPeople, existingAsWaterfall.length + maxPeople, 50);

  let people: WaterfallPerson[] = [...existingAsWaterfall];
  if (cached && cached.length > 0) {
    people = mergePeople(people, cached, cap, personas);
  }

  // Provider 1: scrape + guess
  const discovered = await discoverContacts({
    domain: row.domain,
    maxPages: 6,
  });
  const discoveredMapped: WaterfallPerson[] = discovered.contacts
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
  people = mergePeople(people, discoveredMapped, cap, personas);

  // Provider 2: NinjaPear — search + profile employment + work email
  if (ninjapearEnabled()) {
    try {
      const slots = Math.max(0, maxPeople - Math.max(0, people.length - existingAsWaterfall.length));
      // Always try a few more if we have capacity for new names
      const want = Math.max(slots, people.length < maxPeople ? maxPeople - people.length : 0);
      if (want > 0) {
        const npPeople = await ninjapearPeople(
          row.domain,
          row.companyName,
          personas,
          want,
        );
        if (npPeople.length > 0) {
          people = mergePeople(people, npPeople, cap, personas);
        }
      }
      // Enrich everyone we keep: missing email + employment verify via profile
      people = await enrichPeopleViaNinjapear(people, {
        domain: row.domain,
        companyName: row.companyName,
      });
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
        people = mergePeople(people, hunterPeople, cap, personas);
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

  // LinkedIn: drop unverified profile URLs, then Exa-search + company match.
  // NinjaPear does not return linkedin.com/in — employment notes help ranking only.
  people = await attachVerifiedLinkedIn(people, {
    companyName: row.companyName,
    domain: row.domain,
  });

  // Merge-only write + snapshot of prior list (never silent wipe)
  await replacePeople(client, rowId, people, {
    mode: "merge",
    reason: "people_enrich",
  });
  // Cache the merged result, not a truncated discovery-only set
  const saved = await listPeople(client, rowId);
  const out: WaterfallPerson[] = saved.map((p) => ({
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
  await setCache(client, cacheKey, out, 60 * 60 * 24 * 14);
  return out;
}

/**
 * Only keep LinkedIn URLs that look like real /in/ profiles and can be tied
 * to the company (page scrape). If missing/unverified, search and require
 * company evidence in title/snippet — never name-only matches.
 */
async function attachVerifiedLinkedIn(
  people: WaterfallPerson[],
  company: { companyName: string; domain: string | null },
): Promise<WaterfallPerson[]> {
  const {
    findVerifiedLinkedIn,
    verifyLinkedInBelongsToCompany,
  } = await import("@/lib/research/linkedin-finder");

  const out: WaterfallPerson[] = [];
  for (const p of people) {
    let linkedin = p.linkedin;
    let notes = p.notes;
    let confidence = p.confidence;
    let providerUsed = p.providerUsed;
    const employmentOk = Boolean(
      notes?.includes("employment_ok:ninjapear") ||
        notes?.includes("employment_current:ninjapear"),
    );

    if (linkedin) {
      const v = await verifyLinkedInBelongsToCompany({
        url: linkedin,
        name: p.name,
        companyName: company.companyName,
        domain: company.domain,
      });
      if (!v.ok) {
        // Drop wrong-person URL — better empty than false positive for outreach
        notes = appendNote(notes, `linkedin_rejected:${v.evidence}`);
        linkedin = null;
      } else {
        notes = appendNote(notes, `linkedin_ok:${v.evidence}`);
        confidence = Math.max(confidence ?? 0, v.confidence);
        if (employmentOk) {
          confidence = Math.max(confidence, 0.9);
          notes = appendNote(notes, "linkedin+employment_crosscheck");
        }
      }
    }

    if (!linkedin) {
      try {
        const found = await findVerifiedLinkedIn({
          name: p.name,
          companyName: company.companyName,
          domain: company.domain,
          role: p.role,
        });
        if (found) {
          linkedin = found.url;
          confidence = Math.max(confidence ?? 0, found.confidence);
          if (employmentOk) {
            confidence = Math.max(confidence, 0.9);
          }
          providerUsed = `${providerUsed}+linkedin_finder`;
          notes = appendNote(notes, `linkedin_found:${found.evidence}`);
        }
      } catch (err) {
        console.warn("[research/waterfall] linkedin finder failed:", err);
      }
    }

    out.push({
      ...p,
      linkedin,
      notes,
      confidence,
      providerUsed,
    });
  }
  return out;
}

/**
 * NinjaPear provider: search employees across buyer personas, then resolve
 * person profile (employment) + work emails for kept matches.
 */
async function ninjapearPeople(
  domain: string,
  companyName: string,
  personas: string[],
  max: number,
): Promise<WaterfallPerson[]> {
  if (max <= 0) return [];

  const rolesToTry = [
    ...new Set(
      personas
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 3),
    ),
  ];
  if (rolesToTry.length === 0) rolesToTry.push("CTO");

  const seen = new Set<string>();
  const employees: NinjapearEmployee[] = [];

  for (const role of rolesToTry) {
    if (employees.length >= max * 2) break;
    try {
      const batch = await searchEmployees({ companyWebsite: domain, role });
      for (const e of batch) {
        const key = `${e.first_name}|${e.last_name ?? ""}`.toLowerCase();
        if (!e.first_name || seen.has(key)) continue;
        seen.add(key);
        employees.push(e);
      }
    } catch (err) {
      console.warn(
        `[research/waterfall] employee search role="${role}" failed:`,
        err,
      );
    }
  }

  const top = employees.slice(0, Math.max(max, 1));
  const out: WaterfallPerson[] = [];

  for (const e of top) {
    const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
    let email: string | null = null;
    let role = e.role || null;
    let notes: string | null = "source:ninjapear_search";
    let confidence = 0.6;
    let providerUsed = "ninjapear";

    try {
      email = await findWorkEmail({
        firstName: e.first_name,
        lastName: e.last_name,
        domain,
      });
      if (email) {
        confidence = 0.85;
        notes = appendNote(notes, "work_email:ninjapear");
      }
    } catch (err) {
      console.warn("[research/waterfall] work-email lookup failed:", err);
    }

    try {
      const hit = await lookupPersonEmployment({
        domain,
        companyName,
        firstName: e.first_name,
        lastName: e.last_name,
        workEmail: email,
        role: e.role,
      });
      if (hit) {
        providerUsed = "ninjapear+profile";
        if (hit.employment.ok) {
          const tag = hit.employment.current
            ? "employment_current:ninjapear"
            : "employment_ok:ninjapear";
          notes = appendNote(notes, `${tag}:${hit.employment.evidence}`);
          confidence = Math.max(
            confidence,
            hit.employment.current ? 0.92 : 0.8,
          );
          if (hit.employment.role) role = hit.employment.role;
          if (hit.profile.full_name) {
            notes = appendNote(
              notes,
              `canonical_name:${hit.profile.full_name}`,
            );
          }
        } else {
          notes = appendNote(
            notes,
            `employment_miss:ninjapear:${hit.employment.evidence}`,
          );
          // Still keep the search hit — search is company-scoped, but flag it
          confidence = Math.min(confidence, 0.55);
        }
        if (hit.profile.x_profile_url) {
          notes = appendNote(notes, `x:${hit.profile.x_profile_url}`);
        }
      }
    } catch (err) {
      console.warn("[research/waterfall] person profile failed:", err);
    }

    out.push({
      name: name || e.first_name,
      role,
      linkedin: null,
      email,
      emailStatus: null,
      emailSource: email ? "provider" : null,
      providerUsed,
      confidence,
      notes,
    });
  }
  return out;
}

/**
 * For people already found (scrape etc.): fill work email + verify employment
 * via Person Profile. Caps profile calls to list size (typically ≤ maxPeople).
 */
async function enrichPeopleViaNinjapear(
  people: WaterfallPerson[],
  company: { domain: string; companyName: string },
): Promise<WaterfallPerson[]> {
  if (!ninjapearEnabled() || people.length === 0) return people;

  const out: WaterfallPerson[] = [];
  for (const p of people) {
    // Already fully verified by ninjapear path
    if (
      p.notes?.includes("employment_current:ninjapear") ||
      p.notes?.includes("employment_ok:ninjapear")
    ) {
      // Still try email if missing
      if (!p.email) {
        const filled = await tryWorkEmail(p, company.domain);
        out.push(filled);
      } else {
        out.push(p);
      }
      continue;
    }

    let next = p;
    if (!next.email) {
      next = await tryWorkEmail(next, company.domain);
    }

    const { firstName, lastName } = splitPersonName(next.name);
    if (!firstName) {
      out.push(next);
      continue;
    }

    const hit = await lookupPersonEmployment({
      domain: company.domain,
      companyName: company.companyName,
      firstName,
      lastName,
      workEmail: next.email,
      role: next.role,
    });

    if (!hit) {
      out.push(next);
      continue;
    }

    let notes = next.notes;
    let confidence = next.confidence;
    let role = next.role;
    let providerUsed = `${next.providerUsed ?? "unknown"}+ninjapear_profile`;

    if (hit.employment.ok) {
      const tag = hit.employment.current
        ? "employment_current:ninjapear"
        : "employment_ok:ninjapear";
      notes = appendNote(notes, `${tag}:${hit.employment.evidence}`);
      confidence = Math.max(
        confidence ?? 0,
        hit.employment.current ? 0.9 : 0.78,
      );
      if (hit.employment.role && !role) role = hit.employment.role;
      else if (
        hit.employment.role &&
        role &&
        hit.employment.role.length > role.length
      ) {
        // Prefer richer title from profile when available
        role = hit.employment.role;
      }
    } else {
      notes = appendNote(
        notes,
        `employment_miss:ninjapear:${hit.employment.evidence}`,
      );
    }
    if (hit.profile.x_profile_url) {
      notes = appendNote(notes, `x:${hit.profile.x_profile_url}`);
    }
    if (hit.profile.full_name && hit.profile.full_name.length > next.name.length) {
      // keep original name for LinkedIn search stability; note canonical
      notes = appendNote(notes, `canonical_name:${hit.profile.full_name}`);
    }

    out.push({
      ...next,
      role,
      notes,
      confidence,
      providerUsed,
    });
  }
  return out;
}

async function tryWorkEmail(
  p: WaterfallPerson,
  domain: string,
): Promise<WaterfallPerson> {
  if (p.email) return p;
  const { firstName, lastName } = splitPersonName(p.name);
  if (!firstName) return p;
  try {
    const email = await findWorkEmail({
      firstName,
      lastName,
      domain,
    });
    if (!email) return p;
    return {
      ...p,
      email,
      emailSource: "provider",
      confidence: Math.max(p.confidence ?? 0, 0.8),
      notes: appendNote(p.notes, "work_email:ninjapear"),
      providerUsed: `${p.providerUsed ?? "unknown"}+ninjapear_email`,
    };
  } catch (err) {
    console.warn("[research/waterfall] work-email enrich failed:", err);
    return p;
  }
}

function mergePeople(
  a: WaterfallPerson[],
  b: WaterfallPerson[],
  max: number,
  personas: string[],
): WaterfallPerson[] {
  const byKey = new Map<string, WaterfallPerson>();
  // Prefer keys that keep all of `a` (existing) even when max is small
  for (const p of [...a, ...b]) {
    const key = (p.email ?? p.name).toLowerCase().trim();
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (p.confidence ?? 0) > (prev.confidence ?? 0)) {
      byKey.set(key, prev ? { ...p, email: p.email ?? prev.email, linkedin: p.linkedin ?? prev.linkedin, role: p.role ?? prev.role, notes: [prev.notes, p.notes].filter(Boolean).join(" | ") || null } : p);
    } else {
      byKey.set(key, {
        ...prev,
        email: prev.email ?? p.email,
        linkedin: prev.linkedin ?? p.linkedin,
        role: prev.role ?? p.role,
        notes: [prev.notes, p.notes].filter(Boolean).join(" | ") || null,
        providerUsed:
          prev.providerUsed && p.providerUsed && prev.providerUsed !== p.providerUsed
            ? `${prev.providerUsed}+${p.providerUsed}`
            : prev.providerUsed ?? p.providerUsed,
      });
    }
  }
  const sorted = [...byKey.values()].sort(
    (x, y) =>
      rankPerson(y.role, personas) - rankPerson(x.role, personas) ||
      (y.confidence ?? 0) - (x.confidence ?? 0),
  );
  // Never drop anyone from set `a` (existing contacts on the row)
  const aKeys = new Set(
    a.map((p) => (p.email ?? p.name).toLowerCase().trim()).filter(Boolean),
  );
  const mustKeep = sorted.filter((p) =>
    aKeys.has((p.email ?? p.name).toLowerCase().trim()),
  );
  const extras = sorted.filter(
    (p) => !aKeys.has((p.email ?? p.name).toLowerCase().trim()),
  );
  const room = Math.max(0, max - mustKeep.length);
  return [...mustKeep, ...extras.slice(0, room)];
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
    name:
      [e.first_name, e.last_name].filter(Boolean).join(" ") ||
      e.value ||
      "Unknown",
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

/** Ranked email patterns for a name@domain (SaaS-ish). */
function emailPatternsForName(name: string, domain: string): string[] {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  const first = parts[0];
  const last = parts[parts.length - 1];
  const fi = first[0];
  const li = last[0];
  if (parts.length === 1 || first === last) return [`${first}@${domain}`];
  return [
    ...new Set([
      `${first}.${last}@${domain}`,
      `${first}@${domain}`,
      `${fi}${last}@${domain}`,
      `${first}${last}@${domain}`,
      `${first}_${last}@${domain}`,
      `${fi}.${last}@${domain}`,
      `${first}.${li}@${domain}`,
      `${last}@${domain}`,
    ]),
  ];
}

export type FillEmailResult = {
  person: ResearchPerson;
  found: boolean;
  email: string | null;
  emailStatus: string | null;
  message: string;
};

/**
 * Find + verify work email for one contact on a company row.
 * Order: NinjaPear work-email → pattern guesses + NeverBounce → re-verify existing.
 */
export async function fillEmailForPerson(
  client: SupabaseClient,
  rowId: string,
  opts: { personId?: string; personName?: string },
): Promise<FillEmailResult> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");
  if (!row.domain?.trim()) {
    throw new Error("Company has no domain — cannot guess email");
  }
  const domain = row.domain.replace(/^www\./, "").toLowerCase();

  const people = await listPeople(client, rowId);
  const target =
    (opts.personId
      ? people.find((p) => p.id === opts.personId)
      : undefined) ??
    (opts.personName
      ? people.find(
          (p) =>
            p.name.trim().toLowerCase() ===
            opts.personName!.trim().toLowerCase(),
        )
      : undefined);

  if (!target) throw new Error("Person not found on this company");

  let email = target.email?.trim() || null;
  let emailStatus = target.emailStatus;
  let emailSource = target.emailSource;
  let notes = target.notes;
  let providerUsed = target.providerUsed;
  let confidence = target.confidence;
  let foundNew = false;

  // 1) Provider work-email if missing
  if (!email && ninjapearEnabled()) {
    const filled = await tryWorkEmail(
      {
        name: target.name,
        role: target.role,
        linkedin: target.linkedin,
        email: null,
        emailStatus: null,
        emailSource: null,
        providerUsed: target.providerUsed,
        confidence: target.confidence,
        notes: target.notes,
      },
      domain,
    );
    if (filled.email) {
      email = filled.email;
      emailSource = filled.emailSource;
      notes = filled.notes;
      providerUsed = filled.providerUsed;
      confidence = filled.confidence;
      foundNew = true;
    }
  }

  // 2) Pattern + verify until valid / catchall
  if (!email) {
    const patterns = emailPatternsForName(target.name, domain).slice(0, 8);
    if (patterns.length === 0) {
      throw new Error("Could not build email patterns from name");
    }
    const verified = await verifyEmails(patterns);
    const pick =
      verified.find((v) => v.status === "valid") ??
      verified.find((v) => v.status === "catchall") ??
      verified.find((v) => v.status === "unknown" && !v.error) ??
      null;
    if (pick && (pick.status === "valid" || pick.status === "catchall" || pick.status === "unknown")) {
      email = pick.email;
      emailStatus = pick.status;
      emailSource = "pattern";
      notes = appendNote(notes, `email_pattern:${pick.status}`);
      providerUsed = `${providerUsed ?? "pattern"}+neverbounce`;
      confidence =
        pick.status === "valid" ? 0.95 : pick.status === "catchall" ? 0.6 : 0.4;
      foundNew = true;
    } else {
      await savePeople(
        client,
        rowId,
        [
          {
            name: target.name,
            role: target.role,
            linkedin: target.linkedin,
            email: null,
            emailStatus: null,
            emailSource: null,
            providerUsed: target.providerUsed,
            confidence: target.confidence,
            notes: appendNote(target.notes, "email_lookup:no_valid_pattern"),
          },
        ],
        { mode: "merge", reason: "fill_email_miss" },
      );
      const after = await listPeople(client, rowId);
      const person =
        after.find((p) => p.name === target.name) ??
        after.find(
          (p) =>
            p.name.trim().toLowerCase() === target.name.trim().toLowerCase(),
        ) ??
        target;
      return {
        person,
        found: false,
        email: null,
        emailStatus: null,
        message: "No valid email found (provider + patterns)",
      };
    }
  }

  // 3) Verify (or re-verify) with NeverBounce
  if (email && (!emailStatus || foundNew || emailStatus === "unknown")) {
    const [v] = await verifyEmails([email]);
    if (v) {
      emailStatus = v.status;
      providerUsed = `${providerUsed ?? "unknown"}+neverbounce`;
      if (v.status === "valid") confidence = Math.max(confidence ?? 0, 0.95);
      else if (v.status === "catchall")
        confidence = Math.max(confidence ?? 0, 0.6);
      else if (v.status === "invalid") confidence = 0.1;
      notes = appendNote(notes, `verify:${v.status}`);
      if (v.status === "invalid" && foundNew) {
        // Pattern said something but NB invalid — keep email with status so user sees it
        notes = appendNote(notes, "nb_invalid");
      }
    }
  }

  await savePeople(
    client,
    rowId,
    [
      {
        name: target.name,
        role: target.role,
        linkedin: target.linkedin,
        email,
        emailStatus,
        emailSource,
        providerUsed,
        confidence,
        notes,
      },
    ],
    { mode: "merge", reason: "fill_email" },
  );

  const after = await listPeople(client, rowId);
  const person =
    after.find(
      (p) =>
        (email && p.email?.toLowerCase() === email.toLowerCase()) ||
        p.name.trim().toLowerCase() === target.name.trim().toLowerCase(),
    ) ?? after[0] ??
    target;

  return {
    person,
    found: Boolean(email),
    email: person.email,
    emailStatus: person.emailStatus,
    message: email
      ? `Email ${email}${emailStatus ? ` (${emailStatus})` : ""}`
      : "No email found",
  };
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
