import type { SupabaseClient } from "@supabase/supabase-js";

import { discoverContacts } from "@/lib/contact-discovery";
import {
  isPatternAcceptable,
  probeDomainEmailability,
  toStoredEmailStatus,
  verifyEmailMulti,
  verifyEmails,
} from "@/lib/email-verifier";
import { hunterEmailFinder, hunterEnabled } from "@/lib/hunter";
import {
  findWorkEmail,
  lookupPersonEmployment,
  ninjapearEnabled,
  searchEmployees,
  splitPersonName,
  type NinjapearEmployee,
} from "@/lib/ninjapear";
import { getCached, setCache, domainCacheKey } from "@/lib/research/cache";
import {
  expandSearchRoles,
  personasCacheTag,
  rankPerson,
  roleMatchesPersonas,
} from "@/lib/research/personas";
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

/**
 * Keep a discovered person only when their title is a persona hit or unknown.
 * A known title that matches no persona ("Software Engineer" when we asked
 * for founders) is dropped — this is what used to let unrelated people in.
 */
function keepByPersona(
  p: { role: string | null },
  personas: string[],
): boolean {
  if (!p.role || !p.role.trim()) return true;
  return roleMatchesPersonas(p.role, personas);
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
    /** Override the table's rubric personas for this run (e.g. founder,
     *  sócio comercial, head of delivery for a partner list). */
    personas?: string[];
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
  const overridePersonas = (opts.personas ?? [])
    .map((p) => p.trim())
    .filter(Boolean);
  const personas =
    overridePersonas.length > 0
      ? overridePersonas
      : (rubric?.default_personas ?? ["Head of Engineering", "CTO", "Founder"]);
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

  // v4: persona-filtered providers; key carries the persona set so a persona
  // change on the table (or an override) never serves another table's people.
  const cacheKey = domainCacheKey(
    row.domain,
    `people:v4:${personasCacheTag(personas)}`,
  );
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
    .filter((p) => keepByPersona(p, personas))
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
      const hunterPeople = (
        await hunterDomainSearch(row.domain, maxPeople)
      ).filter((p) => keepByPersona(p, personas));
      if (hunterPeople.length > 0) {
        people = mergePeople(people, hunterPeople, cap, personas);
      }
    } catch (err) {
      console.warn("[research/waterfall] Hunter failed:", err);
    }
  }

  // Email verify waterfall (NB → ZeroBounce → Hunter) — honest statuses only.
  if (opts.verifyEmails !== false) {
    const emails = people
      .map((p) => p.email)
      .filter((e): e is string => Boolean(e));
    if (emails.length > 0) {
      const unique = [...new Set(emails)].slice(0, 12);
      const verified = await Promise.all(
        unique.map((e) => verifyEmailMulti(e)),
      );
      const byEmail = new Map(
        verified.map((v) => [v.email.toLowerCase(), v]),
      );
      people = people.map((p) => {
        if (!p.email) return p;
        const v = byEmail.get(p.email.toLowerCase());
        if (!v || v.status === "config_missing" || v.status === "error") {
          return {
            ...p,
            emailStatus: p.emailStatus
              ? toStoredEmailStatus(p.emailStatus)
              : "unverified",
          };
        }
        const stored = toStoredEmailStatus(v.status);
        const providers =
          v.providers?.length > 0
            ? v.providers.join("+")
            : "neverbounce";
        return {
          ...p,
          emailStatus: stored,
          confidence:
            stored === "valid"
              ? Math.max(p.confidence ?? 0, 0.95)
              : stored === "catchall"
                ? Math.max(p.confidence ?? 0, 0.6)
                : stored === "invalid"
                  ? 0.1
                  : stored === "unverified"
                    ? Math.min(p.confidence ?? 0.4, 0.4)
                    : p.confidence,
          providerUsed: `${p.providerUsed ?? "unknown"}+${providers}`,
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
/** Exported for the CRM enrichment path, which needs the same people lookup
 *  without a research row behind it.
 *
 *  Gated internally rather than at the caller. Every path in here bills:
 *  searchEmployees is 2 credits plus 1 per employee returned, findWorkEmail 2
 *  more. The original caller checks ninjapearEnabled() before reaching this
 *  function, which was fine while it had exactly one; an exported function
 *  cannot rely on every future caller remembering. */
export async function ninjapearPeople(
  domain: string,
  companyName: string,
  personas: string[],
  max: number,
): Promise<WaterfallPerson[]> {
  const { people } = await ninjapearPeopleDetailed(
    domain,
    companyName,
    personas,
    max,
  );
  return people;
}

/**
 * Same lookup, but says whether it actually ran.
 *
 * An empty people list has three causes that look identical to the caller: the
 * key is missing, the provider genuinely knows nobody at this domain, or every
 * search threw (rate limit, timeout, provider down) and was swallowed by the
 * warn-and-continue below. Callers recording a durable decision from the result
 * need to tell the third apart from the second — marking an account "we looked
 * and there is nobody" because the provider was briefly down removes it from
 * the review queue for good.
 */
export async function ninjapearPeopleDetailed(
  domain: string,
  companyName: string,
  personas: string[],
  max: number,
): Promise<{
  people: WaterfallPerson[];
  /** True when at least one employee search returned without throwing. Only
   *  then does an empty result mean "nobody", rather than "we never asked". */
  searched: boolean;
  disabled: boolean;
}> {
  if (max <= 0) return { people: [], searched: false, disabled: false };
  if (!ninjapearEnabled())
    return { people: [], searched: false, disabled: true };

  // Persona + its other-language synonym, capped (each search costs credits).
  const rolesToTry = expandSearchRoles(personas, 6);
  if (rolesToTry.length === 0) rolesToTry.push("CTO");

  const seen = new Set<string>();
  const employees: NinjapearEmployee[] = [];
  let searched = false;
  let dropped = 0;

  for (const role of rolesToTry) {
    if (employees.length >= max * 2) break;
    try {
      const batch = await searchEmployees({ companyWebsite: domain, role });
      searched = true;
      for (const e of batch) {
        const key = `${e.first_name}|${e.last_name ?? ""}`.toLowerCase();
        if (!e.first_name || seen.has(key)) continue;
        seen.add(key);
        // Provider role search is fuzzy; keep only titles that are actually
        // a persona hit. Titles that matched nothing used to be kept as-is.
        // Same rule as the other providers: an empty title is unknown, not
        // rejected — employment verification below still has to pass.
        if (!keepByPersona({ role: e.role || null }, personas)) {
          dropped += 1;
          continue;
        }
        employees.push(e);
      }
    } catch (err) {
      console.warn(
        `[research/waterfall] employee search role="${role}" failed:`,
        err,
      );
    }
  }

  if (dropped > 0) {
    console.info(
      `[research/waterfall] ${domain}: dropped ${dropped} provider hit(s) outside personas [${personas.join(", ")}]`,
    );
  }
  // Walk the whole candidate list and stop at `max` kept, so a dropped
  // candidate (employment miss, unverified title-less hit) does not starve a
  // valid one further down. Paid lookups are bounded by `maxProbes`: with no
  // drops this is exactly `max` probes, as before.
  const want = Math.max(max, 1);
  const maxProbes = want * 3;
  let probes = 0;
  const out: WaterfallPerson[] = [];

  for (const e of employees) {
    if (out.length >= want) break;
    if (probes >= maxProbes) {
      console.info(
        `[research/waterfall] ${domain}: stopped after ${probes} provider probes with ${out.length}/${want} kept`,
      );
      break;
    }
    probes += 1;
    const name = [e.first_name, e.last_name].filter(Boolean).join(" ");
    let email: string | null = null;
    let role = e.role || null;
    let notes: string | null = "source:ninjapear_search";
    let confidence = 0.6;
    let providerUsed = "ninjapear";
    // A title-less hit passed the persona filter as "unknown"; it only stays
    // if the profile confirms employment. A known persona title may stay on
    // a null lookup (provider down), the unknown one may not.
    const roleKnown = Boolean(e.role && e.role.trim());
    let employmentVerified = false;

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
          employmentVerified = true;
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
        } else if (hit.employment.unknown) {
          // Profile has no work history: nothing to check, so this is the
          // same as a null lookup — a known persona title stays, flagged.
          notes = appendNote(notes, "employment_unknown:ninjapear");
        } else {
          // Profile says this person does not work here. Drop instead of
          // keeping a flagged contact — a wrong lead costs more than a gap.
          console.info(
            `[research/waterfall] ${domain}: dropped ${name} (${e.role}) — employment miss: ${hit.employment.evidence}`,
          );
          continue;
        }
        if (hit.profile.x_profile_url) {
          notes = appendNote(notes, `x:${hit.profile.x_profile_url}`);
        }
      }
    } catch (err) {
      console.warn("[research/waterfall] person profile failed:", err);
    }

    if (!roleKnown && !employmentVerified) {
      console.info(
        `[research/waterfall] ${domain}: dropped ${name} — no title and employment not verified`,
      );
      continue;
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
  return { people: out, searched, disabled: false };
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

function waterfallIdentityKeys(p: WaterfallPerson): string[] {
  const keys: string[] = [];
  if (p.email?.trim()) keys.push(`e:${p.email.trim().toLowerCase()}`);
  const li = p.linkedin?.trim().toLowerCase().replace(/\/$/, "");
  if (li) {
    const m = li.match(/linkedin\.com\/in\/([^/?#]+)/i);
    keys.push(`li:${(m?.[1] ?? li).toLowerCase()}`);
  }
  const n = p.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (n) keys.push(`n:${n}`);
  return keys;
}

function mergeWaterfallPerson(
  prev: WaterfallPerson,
  p: WaterfallPerson,
): WaterfallPerson {
  return {
    name: prev.name.length >= p.name.length ? prev.name : p.name,
    role: prev.role ?? p.role,
    linkedin: prev.linkedin ?? p.linkedin,
    email: prev.email ?? p.email,
    emailStatus: prev.emailStatus ?? p.emailStatus,
    emailSource: prev.emailSource ?? p.emailSource,
    providerUsed:
      prev.providerUsed &&
      p.providerUsed &&
      prev.providerUsed !== p.providerUsed
        ? `${prev.providerUsed}+${p.providerUsed}`
        : (prev.providerUsed ?? p.providerUsed),
    confidence: Math.max(prev.confidence ?? 0, p.confidence ?? 0) || null,
    notes: [prev.notes, p.notes].filter(Boolean).join(" | ") || null,
  };
}

function mergePeople(
  a: WaterfallPerson[],
  b: WaterfallPerson[],
  max: number,
  personas: string[],
): WaterfallPerson[] {
  // Multi-key identity (name/LI/email) so email fill does not fork contacts
  const clusters: WaterfallPerson[] = [];
  const keyToIdx = new Map<string, number>();

  for (const p of [...a, ...b]) {
    const keys = waterfallIdentityKeys(p);
    if (keys.length === 0) continue;
    let idx: number | undefined;
    for (const k of keys) {
      if (keyToIdx.has(k)) {
        idx = keyToIdx.get(k);
        break;
      }
    }
    if (idx === undefined) {
      idx = clusters.length;
      clusters.push(p);
    } else {
      clusters[idx] = mergeWaterfallPerson(clusters[idx], p);
    }
    for (const k of waterfallIdentityKeys(clusters[idx])) {
      keyToIdx.set(k, idx);
    }
  }

  const sorted = [...clusters].sort(
    (x, y) =>
      rankPerson(y.role, personas) - rankPerson(x.role, personas) ||
      (y.confidence ?? 0) - (x.confidence ?? 0),
  );

  // Never drop anyone from set `a` (existing contacts on the row)
  const aNameKeys = new Set(
    a.flatMap((p) => waterfallIdentityKeys(p)).filter(Boolean),
  );
  const mustKeep = sorted.filter((p) =>
    waterfallIdentityKeys(p).some((k) => aNameKeys.has(k)),
  );
  const extras = sorted.filter(
    (p) => !waterfallIdentityKeys(p).some((k) => aNameKeys.has(k)),
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
  opts: { onlyIfPass?: boolean; maxPeople?: number; personas?: string[] } = {},
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
 *
 * Honesty rules:
 * - Domain probe first (random@domain). unprobeable/catchall → no pattern spam.
 * - Patterns only saved when NeverBounce returns **valid**.
 * - Provider emails may be saved as unverified / catchall / valid after verify.
 * - Never persist config_missing or unknown-as-success.
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
  let emailStatus = toStoredEmailStatus(target.emailStatus);
  let emailSource = target.emailSource;
  let notes = target.notes;
  let providerUsed = target.providerUsed;
  let confidence = target.confidence;
  let foundNew = false;
  let fromPattern = false;

  const probe = await probeDomainEmailability(domain);
  notes = appendNote(notes, `domain_probe:${probe.kind}`);

  // 1) Provider work-email (NinjaPear) if missing
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

  // 1b) Hunter email finder — best source for BR when SMTP probe fails
  if (!email && hunterEnabled()) {
    const { firstName, lastName } = splitPersonName(target.name);
    if (firstName) {
      const hit = await hunterEmailFinder({
        domain,
        firstName,
        lastName,
        fullName: target.name,
      });
      if (hit?.email) {
        email = hit.email;
        emailSource = "provider";
        providerUsed = "hunter_finder";
        confidence = Math.min(0.9, Math.max(0.45, hit.score / 100));
        notes = appendNote(
          notes,
          `hunter_finder:score=${hit.score}:sources=${hit.sources}` +
            (hit.verificationStatus
              ? `:hv=${hit.verificationStatus}`
              : ""),
        );
        if (hit.verificationStatus === "valid") {
          emailStatus = "valid";
          confidence = Math.max(confidence ?? 0, 0.9);
        } else if (hit.verificationStatus === "accept_all") {
          emailStatus = "catchall";
        } else {
          emailStatus = null; // will multi-verify below
        }
        foundNew = true;
      } else {
        notes = appendNote(notes, "hunter_finder:miss");
      }
    }
  }

  // 2) Patterns
  // - probeable: only save NeverBounce **valid**
  // - unprobeable / catchall (.br often): save best guess as **unverified**
  //   so the list is usable for outreach, without pretending it's proven
  if (!email) {
    const patterns = emailPatternsForName(target.name, domain).slice(0, 8);
    if (patterns.length === 0) {
      notes = appendNote(notes, "email_lookup:no_patterns_from_name");
    } else if (probe.kind === "probeable") {
      const verified = await verifyEmails(patterns);
      const nbConfigured = verified.some((v) => v.status !== "config_missing");
      if (!nbConfigured) {
        notes = appendNote(notes, "email_lookup:neverbounce_missing");
      } else {
        const pick = verified.find((v) => isPatternAcceptable(v.status));
        if (pick) {
          email = pick.email;
          emailStatus = "valid";
          emailSource = "pattern";
          notes = appendNote(notes, "email_pattern:valid");
          providerUsed = `${providerUsed ?? "pattern"}+neverbounce`;
          confidence = 0.95;
          foundNew = true;
          fromPattern = true;
        } else {
          notes = appendNote(notes, "email_lookup:no_valid_pattern");
        }
      }
    } else if (probe.kind === "unprobeable" || probe.kind === "catchall") {
      // Prefer first.last@ then first@ — standard SaaS/BR corporate guess
      email = patterns[0];
      emailStatus = "unverified";
      emailSource = "pattern_guess";
      notes = appendNote(
        notes,
        `email_pattern_guess:probe=${probe.kind}`,
      );
      providerUsed = `${providerUsed ?? "pattern_guess"}`;
      confidence = probe.kind === "catchall" ? 0.25 : 0.3;
      foundNew = true;
      fromPattern = true; // skip re-verify loop that would only re-unknown
    } else if (probe.kind === "config_missing") {
      // No verifier — still surface a guess, clearly unverified
      email = patterns[0];
      emailStatus = "unverified";
      emailSource = "pattern_guess";
      notes = appendNote(notes, "email_pattern_guess:nb_missing");
      providerUsed = "pattern_guess";
      confidence = 0.2;
      foundNew = true;
      fromPattern = true;
    }
  }

  if (!email) {
    // Do not wipe existing fields — only annotate miss
    await savePeople(
      client,
      rowId,
      [
        {
          name: target.name,
          role: target.role,
          linkedin: target.linkedin,
          email: target.email,
          emailStatus: target.emailStatus,
          emailSource: target.emailSource,
          providerUsed: target.providerUsed,
          confidence: target.confidence,
          notes: appendNote(
            target.notes,
            `email_lookup:miss:probe=${probe.kind}`,
          ),
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
      message: "No email found (provider + patterns)",
    };
  }

  // 3) Multi-verify provider / existing emails (NB → ZeroBounce → Hunter)
  // Pattern guesses on unprobeable domains stay unverified without re-burning credits
  // on hopeless SMTP; probeable patterns already valid.
  const needsVerify =
    email &&
    !fromPattern &&
    (foundNew ||
      !emailStatus ||
      emailStatus === "unverified" ||
      emailStatus === "unknown" ||
      emailStatus === "config_missing" ||
      emailStatus === "error");
  if (needsVerify) {
    const v = await verifyEmailMulti(email!);
    if (v.status !== "config_missing" && v.status !== "error") {
      emailStatus = toStoredEmailStatus(v.status);
      const p = v.providers?.length ? v.providers.join("+") : "verify";
      providerUsed = `${providerUsed ?? "unknown"}+${p}`;
      if (emailStatus === "valid") confidence = Math.max(confidence ?? 0, 0.95);
      else if (emailStatus === "catchall")
        confidence = Math.max(confidence ?? 0, 0.55);
      else if (emailStatus === "invalid") confidence = 0.1;
      else if (emailStatus === "unverified")
        confidence = Math.min(confidence ?? 0.35, 0.35);
      notes = appendNote(
        notes,
        `verify:${v.status}:${v.providers?.join(",") ?? "?"}`,
      );
      if (emailStatus === "invalid" && foundNew) {
        email = null;
        emailStatus = null;
        emailSource = null;
        notes = appendNote(notes, "provider_email_invalid_dropped");
      }
    } else {
      emailStatus = "unverified";
      notes = appendNote(
        notes,
        v.status === "config_missing"
          ? "verify:no_verifiers_configured"
          : `verify:error:${v.error ?? "?"}`,
      );
    }
  }

  // Pattern path already valid; provider-unknown stays unverified not "success"
  if (email && !emailStatus) emailStatus = "unverified";
  if (emailStatus === "unknown") emailStatus = "unverified";

  if (!email) {
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
          providerUsed,
          confidence,
          notes,
        },
      ],
      { mode: "merge", reason: "fill_email_invalid" },
    );
    const after = await listPeople(client, rowId);
    const person =
      after.find(
        (p) =>
          p.name.trim().toLowerCase() === target.name.trim().toLowerCase(),
      ) ?? target;
    return {
      person,
      found: false,
      email: null,
      emailStatus: null,
      message: "Provider email failed verification",
    };
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
    ) ??
    after[0] ??
    target;

  const label =
    emailStatus === "valid"
      ? "valid (proven)"
      : emailStatus === "catchall"
        ? "catchall (domain accepts all)"
        : emailStatus === "unverified"
          ? fromPattern
            ? "unverified guess (domain not SMTP-probeable)"
            : "unverified (could not prove inbox)"
          : emailStatus ?? "saved";

  return {
    person,
    found: Boolean(email),
    email: person.email,
    emailStatus: person.emailStatus,
    message: `Email ${email} · ${label}`,
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
