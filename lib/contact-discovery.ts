// Contact discovery — given a domain (and optionally a specific article URL),
// scrape the typical contact-bearing pages, surface visible emails, ask the
// LLM to extract structured people, and generate likely email patterns for
// the people whose emails aren't published. Output is a ranked candidate
// list the team can apply to an Outreach prospect with one click.
//
// No paid Hunter.io / Apollo / Clearbit dependency — uses the existing Exa
// scraper + LLM. Email validation is lightweight: format check + MX record
// lookup. SMTP probing is deliberately skipped (fragile, often flagged as
// abuse, and most ISPs reject anonymous probes).

import { generateText } from "ai";
import { promises as dns } from "node:dns";

import { getModel } from "@/lib/ai/provider";
import { scrapePageContent } from "@/lib/exa";

export type EmailConfidence = "verified" | "high" | "medium" | "low";

export type ContactCandidate = {
  name: string;
  role: string | null;
  email: string | null;
  emailConfidence: EmailConfidence | null;
  emailSource: "scraped" | "guessed";
  profileUrl: string | null;
  source: string; // which URL surfaced this contact
  notes: string | null;
};

// Common pages where companies publish contact info. Tried in order; failed
// fetches are silently skipped.
const COMMON_PATHS = [
  "/about",
  "/about-us",
  "/team",
  "/people",
  "/authors",
  "/contact",
  "/contact-us",
  "/company",
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const NOISE_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "info",
  "support",
  "help",
  "hello",
  "contact",
  "press",
  "media",
  "sales",
  "billing",
  "legal",
  "abuse",
  "postmaster",
  "webmaster",
  "admin",
]);

function normalizeDomain(input: string): string {
  return input
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .trim()
    .toLowerCase();
}

// Generate the email patterns we'd actually try, ranked roughly by
// likelihood at SaaS / dev-tools companies.
function generateEmailPatterns(name: string, domain: string): string[] {
  const parts = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return [];
  const first = parts[0];
  const last = parts[parts.length - 1];
  const fInitial = first[0];
  const lInitial = last[0];

  if (parts.length === 1 || first === last) {
    return [`${first}@${domain}`];
  }

  const patterns = [
    `${first}@${domain}`,
    `${first}.${last}@${domain}`,
    `${fInitial}${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${first}_${last}@${domain}`,
    `${fInitial}.${last}@${domain}`,
    `${first}.${lInitial}@${domain}`,
    `${last}@${domain}`,
  ];

  // Dedup while preserving order
  return Array.from(new Set(patterns));
}

async function domainHasMx(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return records.length > 0;
  } catch {
    return false;
  }
}

type ParsedPerson = {
  name: string;
  role?: string;
  email?: string;
  profileUrl?: string;
  sourceUrl?: string;
  notes?: string;
};

const CONTACT_EXTRACTION_PROMPT = `You extract outreach contacts from one or more web pages of a single company.

Identify people who would be relevant for backlink / partnership / guest-post outreach: founders, editors, content leads, partner managers, DevRel, marketing, growth, community.

Return a JSON array (no prose). Each item:
- name: full name (required)
- role: job title or function, if shown
- email: include ONLY if explicitly visible on the page (do not guess)
- profileUrl: Twitter / LinkedIn / GitHub URL if linked from the page
- sourceUrl: which page header (e.g. "Page 2: ...") this person was found on
- notes: one short line that helps prioritize (e.g. "founder, technical background")

Skip:
- Customer testimonials
- Board members of unrelated companies
- People who clearly left ("formerly", "alumni")
- Generic placeholder names

Return at most 15 people. If none, return []. JSON only.`;

function parseLlmContacts(text: string): ParsedPerson[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is ParsedPerson =>
        p &&
        typeof p.name === "string" &&
        p.name.trim().length > 0,
    );
  } catch {
    return [];
  }
}

export async function discoverContacts({
  domain,
  articleUrl,
  maxPages = 5,
}: {
  domain: string;
  articleUrl?: string;
  maxPages?: number;
}): Promise<{
  domain: string;
  hasMx: boolean;
  pagesScraped: string[];
  contacts: ContactCandidate[];
}> {
  const cleanDomain = normalizeDomain(domain);
  if (!cleanDomain) {
    return { domain, hasMx: false, pagesScraped: [], contacts: [] };
  }

  const baseUrl = `https://${cleanDomain}`;

  const targets: string[] = [];
  if (articleUrl) targets.push(articleUrl);
  for (const path of COMMON_PATHS) {
    if (targets.length >= maxPages + (articleUrl ? 1 : 0)) break;
    targets.push(`${baseUrl}${path}`);
  }

  // Run MX check + scrapes in parallel; partial failures are fine.
  const [mx, ...scrapeResults] = await Promise.all([
    domainHasMx(cleanDomain),
    ...targets.map(async (url) => {
      try {
        const result = await scrapePageContent({
          url,
          maxCharacters: 8000,
          includeSummary: false,
        });
        if (result.text) return { url, text: result.text };
        return null;
      } catch {
        return null;
      }
    }),
  ]);

  const scraped = scrapeResults.filter(
    (r): r is { url: string; text: string } => r !== null,
  );
  if (scraped.length === 0) {
    return {
      domain: cleanDomain,
      hasMx: mx,
      pagesScraped: [],
      contacts: [],
    };
  }

  // Visible emails (regex scan). We capture the source URL so we can show it
  // in the UI — domain-mismatched emails (e.g. founder's gmail on the about
  // page) are still useful and shown.
  const visibleEmails = new Map<string, string>();
  for (const s of scraped) {
    const matches = s.text.match(EMAIL_REGEX) ?? [];
    for (const e of matches) {
      const lower = e.toLowerCase();
      const local = lower.split("@")[0];
      // Skip obvious noise but keep them if nothing else surfaces (handled
      // below by not filtering at the candidate-list stage).
      if (NOISE_LOCAL_PARTS.has(local)) continue;
      if (!visibleEmails.has(lower)) visibleEmails.set(lower, s.url);
    }
  }

  // Hand the LLM a labeled blob of all scraped pages
  const labeled = scraped
    .map(
      (s, idx) =>
        `### Page ${idx + 1}: ${s.url}\n\n${s.text.slice(0, 4000)}`,
    )
    .join("\n\n---\n\n");

  let people: ParsedPerson[] = [];
  try {
    const { text } = await generateText({
      model: getModel(),
      system: CONTACT_EXTRACTION_PROMPT,
      prompt: `Domain: ${cleanDomain}\n\n${labeled}`,
    });
    people = parseLlmContacts(text);
  } catch (err) {
    console.error("[contact-discovery] LLM extraction failed:", err);
  }

  const candidates: ContactCandidate[] = [];

  for (const p of people) {
    if (p.email && p.email.includes("@")) {
      candidates.push({
        name: p.name,
        role: p.role ?? null,
        email: p.email.toLowerCase(),
        emailConfidence: "high",
        emailSource: "scraped",
        profileUrl: p.profileUrl ?? null,
        source: p.sourceUrl ?? scraped[0]?.url ?? "",
        notes: p.notes ?? null,
      });
      continue;
    }

    // No published email — generate top 3 patterns with low confidence so
    // the user knows they're guesses. Confidence is "medium" if MX exists
    // (the domain at least accepts mail) else "low".
    const baseConfidence: EmailConfidence = mx ? "medium" : "low";
    const patterns = generateEmailPatterns(p.name, cleanDomain).slice(0, 3);
    if (patterns.length === 0) {
      candidates.push({
        name: p.name,
        role: p.role ?? null,
        email: null,
        emailConfidence: null,
        emailSource: "guessed",
        profileUrl: p.profileUrl ?? null,
        source: p.sourceUrl ?? scraped[0]?.url ?? "",
        notes: p.notes ?? null,
      });
      continue;
    }
    for (let i = 0; i < patterns.length; i++) {
      candidates.push({
        name: p.name,
        role: p.role ?? null,
        email: patterns[i],
        emailConfidence: i === 0 ? baseConfidence : "low",
        emailSource: "guessed",
        profileUrl: p.profileUrl ?? null,
        source: p.sourceUrl ?? scraped[0]?.url ?? "",
        notes: p.notes ?? null,
      });
    }
  }

  // Surface any visible emails not already attached to an extracted person
  // — generic role-based addresses ("hello@", "press@") and any direct
  // emails the LLM happened to miss.
  for (const [email, source] of visibleEmails) {
    if (candidates.some((c) => c.email?.toLowerCase() === email)) continue;
    candidates.push({
      name: email.split("@")[0],
      role: "(unattributed contact on page)",
      email,
      emailConfidence: "high",
      emailSource: "scraped",
      profileUrl: null,
      source,
      notes: null,
    });
  }

  // Sort: scraped before guessed; within each, by confidence.
  const order: Record<string, number> = {
    verified: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  candidates.sort((a, b) => {
    if (a.emailSource !== b.emailSource) {
      return a.emailSource === "scraped" ? -1 : 1;
    }
    const ac = a.emailConfidence ? order[a.emailConfidence] ?? 4 : 4;
    const bc = b.emailConfidence ? order[b.emailConfidence] ?? 4 : 4;
    return ac - bc;
  });

  return {
    domain: cleanDomain,
    hasMx: mx,
    pagesScraped: scraped.map((s) => s.url),
    contacts: candidates.slice(0, 25),
  };
}
