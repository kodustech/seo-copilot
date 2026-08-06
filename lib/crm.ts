import type { SupabaseClient } from "@supabase/supabase-js";

import {
  mergeProperties,
  normalizeProperties,
  type CrmProperties,
} from "@/lib/crm-fields";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanyStatus =
  | "lead"
  /** They engaged with us — replied to an email or LinkedIn, or asked to be
   *  contacted — but there is no concrete next step yet. Not qualification:
   *  gtm.md requires a substantive conversation AND a nameable next step, and a
   *  reply on its own is neither. Exists so "never heard from them" and "the
   *  conversation is live" stop sharing one bucket. */
  | "engaged"
  | "qualified"
  /** Assisted evaluation run with us: agreed scope, criteria, often a bake-off
   *  against a competitor. NOT the product's self-serve trial — that is the t0
   *  tier, which starts at signup without anyone talking to us. */
  | "poc"
  | "negotiation"
  | "customer"
  | "churned"
  | "lost";

export type CompanyPriority = "high" | "medium" | "low";

export type CompanySource =
  | "manual"
  | "webhook"
  | "agent"
  | "research"
  | "pipeline"
  | "social"
  /** Created/updated from outbound sequence (reply or manual promote). */
  | "sequence"
  /** Created by the product-signals sweep from a kodus-ai signup. */
  | "product";

export const COMPANY_STATUSES: CompanyStatus[] = [
  "lead",
  "engaged",
  "qualified",
  "poc",
  "negotiation",
  "customer",
  "churned",
  "lost",
];

export const COMPANY_PRIORITIES: CompanyPriority[] = ["high", "medium", "low"];

/** How the account runs Kodus. Cloud is set by the product-signals sweep;
 *  self_hosted is set by a human (telemetry has no identity to automate it). */
export type CompanyDeployment = "cloud" | "self_hosted";
export const COMPANY_DEPLOYMENTS: CompanyDeployment[] = ["cloud", "self_hosted"];

export type ActivityKind =
  | "created"
  | "status_change"
  | "owner_change"
  | "comment"
  | "webhook"
  | "note"
  | "property_change"
  /** Product-signals sweep recorded a tier/trigger transition. */
  | "signal"
  /** A human moved the account through the review gate (not_started → ready etc.). */
  | "prep_change"
  /** An outbound message actually went out — email or LinkedIn. */
  | "outreach_sent";

/**
 * How far an account has come through preparation, which is a different axis
 * from `status`. Status says where the relationship stands; this says whether
 * the account has been vetted enough to work at all.
 *
 * Only `ready` may be enrolled in a sequence. `parked` is a decision, not a
 * failure — it is what keeps the review queue finite.
 */
export type CompanyPrep = "not_started" | "enriched" | "ready" | "parked";

export const COMPANY_PREP_VALUES: CompanyPrep[] = [
  "not_started",
  "enriched",
  "ready",
  "parked",
];

export type CrmCompany = {
  id: string;
  name: string;
  domain: string | null;
  orgId: string | null;
  status: CompanyStatus;
  priority: CompanyPriority;
  ownerEmail: string | null;
  industry: string | null;
  size: string | null;
  devCount: number | null;
  country: string | null;
  website: string | null;
  linkedin: string | null;
  arr: number | null;
  tags: string[];
  enrichment: Record<string, unknown>;
  /** Custom field values (key → primitive). Defs in crm_field_defs. */
  properties: CrmProperties;
  /** Outbound tier (t0..t3 | customer). Machine-owned: written by the
   *  product-signals sweep, never edited by hand. */
  tier: string | null;
  /** Why the account sits in that tier — machine-owned, like tier. */
  trigger: string | null;
  deployment: CompanyDeployment | null;
  source: CompanySource;
  /** Human-owned: the review gate in front of every sequence. */
  prepStatus: CompanyPrep;
  /** Last time an outbound message actually went out to this account.
   *  Distinct from lastActivityAt, which the signal sweep moves constantly. */
  lastOutreachAt: string | null;
  outreachSentCount: number;
  notes: string | null;
  lastActivityAt: string | null;
  /** Set when a human excluded the account. The row stays — it is what stops
   *  the product-signals sweep from creating the account again. */
  archivedAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CrmContact = {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  role: string | null;
  phone: string | null;
  linkedin: string | null;
  isPrimary: boolean;
  /** Set when a human excluded the person. Kept so the people lookup can see
   *  them and skip them instead of discovering them again. */
  archivedAt: string | null;
  createdAt: string;
};

export type CrmComment = {
  id: string;
  companyId: string;
  authorEmail: string | null;
  bodyMd: string;
  createdAt: string;
  updatedAt: string;
};

export type CrmActivity = {
  id: string;
  companyId: string;
  kind: ActivityKind;
  summary: string | null;
  meta: Record<string, unknown>;
  actorEmail: string | null;
  createdAt: string;
};

export type CrmStatusSla = {
  status: string;
  idleDays: number;
  label: string | null;
};

export type CreateCompanyInput = {
  name: string;
  domain?: string | null;
  orgId?: string | null;
  status?: CompanyStatus;
  priority?: CompanyPriority;
  ownerEmail?: string | null;
  industry?: string | null;
  size?: string | null;
  devCount?: number | null;
  country?: string | null;
  website?: string | null;
  linkedin?: string | null;
  arr?: number | null;
  tags?: string[];
  enrichment?: Record<string, unknown>;
  /** Shallow merge into properties; null values remove keys. */
  properties?: Record<string, unknown>;
  deployment?: CompanyDeployment | null;
  source?: CompanySource;
  notes?: string | null;
  createdByEmail?: string | null;
};

export type UpdateCompanyInput = Partial<
  Omit<CreateCompanyInput, "createdByEmail" | "source">
> & {
  /** Not part of CreateCompanyInput on purpose: every account starts at 'not_started'.
   *  The enrichment run sets 'enriched'; only a human sets 'ready' or 'parked'. */
  prepStatus?: CompanyPrep;
  /** false restores an excluded account. Prefer archiveCompany() to exclude
   *  one — this exists so the same PATCH that edits an account can undo it. */
  archived?: boolean;
};

export type CompanyFilters = {
  status?: CompanyStatus | CompanyStatus[];
  priority?: CompanyPriority;
  ownerEmail?: string;
  /** Outbound tier from product signals: t0 | t1 | t2 | t3 | customer.
   *  Answers "when do we touch this account". */
  tier?: string | string[];
  /** Why the account is in that tier: cloud_trial | trial_broken |
   *  free_limit | healthy_usage | went_quiet | never_connected | ...
   *  Answers "what do we say to it", which is a different question. */
  trigger?: string | string[];
  deployment?: CompanyDeployment;
  source?: CompanySource;
  /** The review queue is a filter on this: prepStatus: ["not_started", "enriched"]. */
  prepStatus?: CompanyPrep | CompanyPrep[];
  search?: string;
  staleOnly?: boolean;
  /** Archived accounts are excluded everywhere by default — they are the ones
   *  a human removed, and every list in the product is a working list. Only a
   *  screen whose subject *is* the exclusions should pass this. */
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
};

// A company plus the idle assessment derived from its status SLA.
export type CompanyWithIdle = CrmCompany & {
  idleDays: number | null;
  slaDays: number | null;
  isStale: boolean;
};

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type CompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  org_id: string | null;
  status: CompanyStatus;
  priority: CompanyPriority;
  owner_email: string | null;
  industry: string | null;
  size: string | null;
  dev_count: number | string | null;
  country: string | null;
  website: string | null;
  linkedin: string | null;
  arr: number | string | null;
  tags: string[] | null;
  enrichment: Record<string, unknown> | null;
  properties?: Record<string, unknown> | null;
  tier?: string | null;
  trigger?: string | null;
  deployment?: CompanyDeployment | null;
  source: CompanySource | null;
  prep_status?: string | null;
  last_outreach_at?: string | null;
  outreach_sent_count?: number | null;
  notes: string | null;
  last_activity_at: string | null;
  archived_at?: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

function rowToCompany(row: CompanyRow): CrmCompany {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    orgId: row.org_id,
    status: row.status,
    priority: row.priority,
    ownerEmail: row.owner_email,
    industry: row.industry,
    size: row.size,
    devCount: row.dev_count == null ? null : Number(row.dev_count),
    country: row.country,
    website: row.website,
    linkedin: row.linkedin,
    arr: row.arr == null ? null : Number(row.arr),
    tags: row.tags ?? [],
    enrichment: row.enrichment ?? {},
    properties: normalizeProperties(row.properties),
    tier: row.tier ?? null,
    trigger: row.trigger ?? null,
    deployment: row.deployment ?? null,
    source: row.source ?? "manual",
    // Null means the row predates the column — 'not_started' is the honest
    // reading, since nobody looked at those either.
    //
    // A non-null value passes through even if this build does not recognise it.
    // Collapsing unknowns to 'not_started' was worse than it looked: a prep
    // state added to the database ahead of the UI would arrive labelled
    // "nobody has looked at this" and could then be dragged straight to
    // 'ready', skipping the gate this column exists to enforce. The board
    // renders unrecognised values in their own column instead, and the CHECK
    // constraint is what actually bounds the set.
    prepStatus: (row.prep_status ?? "not_started") as CompanyPrep,
    lastOutreachAt: row.last_outreach_at ?? null,
    outreachSentCount: Number(row.outreach_sent_count ?? 0),
    notes: row.notes,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at ?? null,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ContactRow = {
  id: string;
  company_id: string;
  name: string;
  email: string | null;
  role: string | null;
  phone: string | null;
  linkedin: string | null;
  is_primary: boolean | null;
  archived_at?: string | null;
  created_at: string;
};

function rowToContact(row: ContactRow): CrmContact {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    email: row.email,
    role: row.role,
    phone: row.phone,
    linkedin: row.linkedin,
    isPrimary: row.is_primary ?? false,
    archivedAt: row.archived_at ?? null,
    createdAt: row.created_at,
  };
}

type CommentRow = {
  id: string;
  company_id: string;
  author_email: string | null;
  body_md: string;
  created_at: string;
  updated_at: string;
};

function rowToComment(row: CommentRow): CrmComment {
  return {
    id: row.id,
    companyId: row.company_id,
    authorEmail: row.author_email,
    bodyMd: row.body_md,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type ActivityRow = {
  id: string;
  company_id: string;
  kind: ActivityKind;
  summary: string | null;
  meta: Record<string, unknown> | null;
  actor_email: string | null;
  created_at: string;
};

function rowToActivity(row: ActivityRow): CrmActivity {
  return {
    id: row.id,
    companyId: row.company_id,
    kind: row.kind,
    summary: row.summary,
    meta: row.meta ?? {},
    actorEmail: row.actor_email,
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// Normalize a domain from a URL or bare hostname. Returns null for empty input.
export function normalizeDomain(value: string | null | undefined): string | null {
  const raw = trimOrNull(value);
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** Domain part of an email address, or null. */
export function domainFromEmail(
  email: string | null | undefined,
): string | null {
  const e = trimOrNull(email)?.toLowerCase();
  if (!e || !e.includes("@")) return null;
  const host = e.split("@").pop()?.trim() || "";
  if (!host || host.includes(" ")) return null;
  return normalizeDomain(host);
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Activity log (also refreshes last_activity_at)
// ---------------------------------------------------------------------------

export async function logActivity(
  client: SupabaseClient,
  companyId: string,
  kind: ActivityKind,
  opts: {
    summary?: string | null;
    meta?: Record<string, unknown>;
    actorEmail?: string | null;
    touch?: boolean; // update company.last_activity_at (default true)
  } = {},
): Promise<void> {
  const { error } = await client.from("crm_activities").insert({
    company_id: companyId,
    kind,
    summary: trimOrNull(opts.summary),
    meta: opts.meta ?? {},
    actor_email: trimOrNull(opts.actorEmail),
  });
  if (error) throw new Error(`Failed to log activity: ${error.message}`);

  if (opts.touch !== false) {
    await client
      .from("crm_companies")
      .update({ last_activity_at: new Date().toISOString() })
      .eq("id", companyId);
  }
}

// ---------------------------------------------------------------------------
// SLA
// ---------------------------------------------------------------------------

export async function listStatusSla(
  client: SupabaseClient,
): Promise<CrmStatusSla[]> {
  const { data, error } = await client.from("crm_status_sla").select("*");
  if (error) throw new Error(`Failed to list SLA: ${error.message}`);
  return (data ?? []).map((r) => ({
    status: r.status as string,
    idleDays: r.idle_days as number,
    label: (r.label as string | null) ?? null,
  }));
}

function withIdle(
  company: CrmCompany,
  slaByStatus: Map<string, number>,
): CompanyWithIdle {
  const idleDays = daysSince(company.lastActivityAt);
  const slaDays = slaByStatus.get(company.status) ?? null;
  const isStale =
    idleDays != null && slaDays != null && slaDays < 900 && idleDays >= slaDays;
  return { ...company, idleDays, slaDays, isStale };
}

// ---------------------------------------------------------------------------
// Companies CRUD
// ---------------------------------------------------------------------------

export async function listCompanies(
  client: SupabaseClient,
  filters: CompanyFilters = {},
): Promise<CompanyWithIdle[]> {
  let query = client
    .from("crm_companies")
    .select("*")
    .order("last_activity_at", { ascending: false, nullsFirst: false });

  if (!filters.includeArchived) query = query.is("archived_at", null);
  if (filters.status) {
    if (Array.isArray(filters.status)) query = query.in("status", filters.status);
    else query = query.eq("status", filters.status);
  }
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.ownerEmail) query = query.eq("owner_email", filters.ownerEmail);
  if (filters.tier) {
    if (Array.isArray(filters.tier)) query = query.in("tier", filters.tier);
    else query = query.eq("tier", filters.tier);
  }
  if (filters.trigger) {
    if (Array.isArray(filters.trigger)) query = query.in("trigger", filters.trigger);
    else query = query.eq("trigger", filters.trigger);
  }
  if (filters.deployment) query = query.eq("deployment", filters.deployment);
  if (filters.source) query = query.eq("source", filters.source);
  if (filters.prepStatus) {
    if (Array.isArray(filters.prepStatus))
      query = query.in("prep_status", filters.prepStatus);
    else query = query.eq("prep_status", filters.prepStatus);
  }
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    query = query.or(
      `name.ilike.${term},domain.ilike.${term},org_id.ilike.${term},industry.ilike.${term},notes.ilike.${term}`,
    );
  }
  if (filters.limit) query = query.limit(filters.limit);
  if (filters.offset) {
    query = query.range(
      filters.offset,
      filters.offset + (filters.limit ?? 200) - 1,
    );
  }

  const [{ data, error }, sla] = await Promise.all([
    query,
    listStatusSla(client),
  ]);
  if (error) throw new Error(`Failed to list companies: ${error.message}`);
  const slaByStatus = new Map(sla.map((s) => [s.status, s.idleDays]));

  let companies = (data ?? []).map((row) =>
    withIdle(rowToCompany(row as CompanyRow), slaByStatus),
  );
  if (filters.staleOnly) companies = companies.filter((c) => c.isStale);
  return companies;
}

export async function getCompany(
  client: SupabaseClient,
  id: string,
): Promise<CrmCompany | null> {
  const { data, error } = await client
    .from("crm_companies")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Failed to get company: ${error.message}`);
  return data ? rowToCompany(data as CompanyRow) : null;
}

function companyInsertRow(input: CreateCompanyInput): Record<string, unknown> {
  const name = trimOrNull(input.name);
  if (!name) throw new Error("name is required");
  return {
    name,
    domain: normalizeDomain(input.domain),
    org_id: trimOrNull(input.orgId),
    status: input.status ?? "lead",
    priority: input.priority ?? "medium",
    owner_email: trimOrNull(input.ownerEmail),
    industry: trimOrNull(input.industry),
    size: trimOrNull(input.size),
    dev_count: typeof input.devCount === "number" ? input.devCount : null,
    country: trimOrNull(input.country),
    website: trimOrNull(input.website),
    linkedin: trimOrNull(input.linkedin),
    arr: typeof input.arr === "number" ? input.arr : null,
    tags: input.tags ?? [],
    enrichment: input.enrichment ?? {},
    properties: input.properties
      ? mergeProperties({}, input.properties)
      : {},
    deployment: input.deployment ?? null,
    source: input.source ?? "manual",
    notes: trimOrNull(input.notes),
    created_by_email: trimOrNull(input.createdByEmail),
  };
}

export async function createCompany(
  client: SupabaseClient,
  input: CreateCompanyInput,
): Promise<CrmCompany> {
  const row = companyInsertRow(input);
  const { data, error } = await client
    .from("crm_companies")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create company: ${error.message}`);
  const company = rowToCompany(data as CompanyRow);
  await logActivity(client, company.id, "created", {
    summary: `Company created (${company.source})`,
    actorEmail: company.createdByEmail,
    touch: false,
  });
  return company;
}

export async function updateCompany(
  client: SupabaseClient,
  id: string,
  updates: UpdateCompanyInput,
  actorEmail?: string | null,
): Promise<CrmCompany> {
  const prev = await getCompany(client, id);
  if (!prev) throw new Error("Company not found");

  const patch: Record<string, unknown> = {};
  if ("name" in updates && updates.name !== undefined) {
    const name = trimOrNull(updates.name);
    if (!name) throw new Error("name cannot be empty");
    patch.name = name;
  }
  if ("domain" in updates) patch.domain = normalizeDomain(updates.domain);
  if ("orgId" in updates) patch.org_id = trimOrNull(updates.orgId);
  if ("deployment" in updates) patch.deployment = updates.deployment ?? null;
  if ("status" in updates && updates.status !== undefined)
    patch.status = updates.status;
  if ("priority" in updates && updates.priority !== undefined)
    patch.priority = updates.priority;
  if ("ownerEmail" in updates)
    patch.owner_email = trimOrNull(updates.ownerEmail);
  if ("industry" in updates) patch.industry = trimOrNull(updates.industry);
  if ("size" in updates) patch.size = trimOrNull(updates.size);
  if ("devCount" in updates)
    patch.dev_count =
      typeof updates.devCount === "number" ? updates.devCount : null;
  if ("country" in updates) patch.country = trimOrNull(updates.country);
  if ("website" in updates) patch.website = trimOrNull(updates.website);
  if ("linkedin" in updates) patch.linkedin = trimOrNull(updates.linkedin);
  if ("arr" in updates)
    patch.arr = typeof updates.arr === "number" ? updates.arr : null;
  if ("tags" in updates && updates.tags !== undefined) patch.tags = updates.tags;
  if ("enrichment" in updates && updates.enrichment !== undefined)
    patch.enrichment = updates.enrichment;
  if ("notes" in updates) patch.notes = trimOrNull(updates.notes);
  if ("prepStatus" in updates && updates.prepStatus !== undefined) {
    if (!COMPANY_PREP_VALUES.includes(updates.prepStatus)) {
      throw new Error(`Invalid prepStatus: ${updates.prepStatus}`);
    }
    patch.prep_status = updates.prepStatus;
  }
  if ("archived" in updates && updates.archived !== undefined) {
    patch.archived_at = updates.archived ? new Date().toISOString() : null;
  }

  let propertyDiff: {
    key: string;
    from: unknown;
    to: unknown;
  }[] = [];
  if ("properties" in updates && updates.properties !== undefined) {
    let defsByKey: Map<string, import("@/lib/crm-fields").CrmFieldDef> | undefined;
    try {
      const { listFieldDefs } = await import("@/lib/crm-fields");
      const defs = await listFieldDefs(client);
      defsByKey = new Map(defs.map((d) => [d.key, d]));
    } catch {
      defsByKey = undefined;
    }
    const merged = mergeProperties(
      prev.properties,
      updates.properties,
      defsByKey,
    );
    patch.properties = merged;
    const keys = new Set([
      ...Object.keys(prev.properties),
      ...Object.keys(updates.properties),
    ]);
    for (const key of keys) {
      const from = prev.properties[key] ?? null;
      const to = merged[key] ?? null;
      if (from !== to) propertyDiff.push({ key, from, to });
    }
  }

  const { data, error } = await client
    .from("crm_companies")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update company: ${error.message}`);
  const next = rowToCompany(data as CompanyRow);

  // Timeline entries for the meaningful transitions.
  if (patch.status && next.status !== prev.status) {
    await logActivity(client, id, "status_change", {
      summary: `Status: ${prev.status} → ${next.status}`,
      meta: { from: prev.status, to: next.status },
      actorEmail,
    });
  }
  // Vetting decisions belong on the timeline: "ready" is the claim that someone
  // checked this account, and a claim with no author and no date is not worth
  // much when the sequence turns out to have gone to the wrong company.
  if (patch.prep_status && next.prepStatus !== prev.prepStatus) {
    await logActivity(client, id, "prep_change", {
      summary: `Prep: ${prev.prepStatus} → ${next.prepStatus}`,
      meta: { from: prev.prepStatus, to: next.prepStatus },
      actorEmail,
    });
  }
  // Exclusion and restore both belong on the timeline. The account keeps being
  // a row in the database either way, so the log is the only place that says
  // who removed it and when — the first question anyone asks when it turns out
  // the sweep was right and we were wrong.
  if ("archived_at" in patch && !next.archivedAt !== !prev.archivedAt) {
    await logActivity(client, id, "note", {
      summary: next.archivedAt
        ? "Account excluded — hidden from lists and never recreated by the sweep"
        : "Account restored",
      meta: { archived: Boolean(next.archivedAt) },
      actorEmail,
      touch: false,
    });
  }
  if ("owner_email" in patch && next.ownerEmail !== prev.ownerEmail) {
    await logActivity(client, id, "owner_change", {
      summary: `Owner: ${prev.ownerEmail ?? "—"} → ${next.ownerEmail ?? "—"}`,
      meta: { from: prev.ownerEmail, to: next.ownerEmail },
      actorEmail,
    });
  }
  if (propertyDiff.length > 0) {
    const summary =
      propertyDiff.length === 1
        ? `Property ${propertyDiff[0].key}: ${String(propertyDiff[0].from ?? "—")} → ${String(propertyDiff[0].to ?? "—")}`
        : `Updated ${propertyDiff.length} properties`;
    await logActivity(client, id, "property_change", {
      summary,
      meta: { changes: propertyDiff },
      actorEmail,
    });
  }
  return next;
}

/**
 * Exclude an account. Archives instead of deleting, and the difference is the
 * whole point: a deleted account was recreated by the next product-signals
 * sweep, because the sweep decides "does this org have an account?" by looking
 * the domain up and finding nothing. An archived one is still found, so the
 * answer is yes and it is left alone.
 *
 * Contacts, comments and the timeline ride along on the same row rather than
 * being cascaded away, which is what makes the exclusion reviewable and makes
 * restoreCompany a real undo rather than a re-import.
 */
export async function archiveCompany(
  client: SupabaseClient,
  id: string,
  actorEmail?: string | null,
): Promise<CrmCompany> {
  return updateCompany(client, id, { archived: true }, actorEmail);
}

/** Undo an exclusion: the account returns to every list, and the sweep resumes
 *  maintaining its tier. */
export async function restoreCompany(
  client: SupabaseClient,
  id: string,
  actorEmail?: string | null,
): Promise<CrmCompany> {
  return updateCompany(client, id, { archived: false }, actorEmail);
}

// ---------------------------------------------------------------------------
// Webhook upsert — idempotent by org_id, then domain.
// ---------------------------------------------------------------------------

/**
 * Upsert an account by domain (system of record for Convert).
 * Used by research, social monitor, and legacy pipeline import.
 */
export async function upsertAccountByDomain(
  client: SupabaseClient,
  input: CreateCompanyInput & {
    contact?: {
      name: string;
      email?: string | null;
      role?: string | null;
      linkedin?: string | null;
    } | null;
    /** Bring an excluded account back. Off by default: an importer finding the
     *  domain again is not new information — it is the same source that put it
     *  there before the human said no. Only a reply sets this. */
    revive?: boolean;
  },
): Promise<{
  company: CrmCompany;
  created: boolean;
  contactCreated: boolean;
  /** True when the account exists but is excluded and was left that way. The
   *  caller wrote nothing. */
  skippedArchived?: boolean;
}> {
  const domain = normalizeDomain(input.domain);
  let existing: CrmCompany | null = null;
  if (domain) {
    const { data } = await client
      .from("crm_companies")
      .select("*")
      .eq("domain", domain)
      .maybeSingle();
    existing = data ? rowToCompany(data as CompanyRow) : null;
  }

  // An excluded account is a decision, not a gap. Every caller of this
  // function is a machine re-discovering a domain it already fed us once
  // (research, the social monitor, the legacy pipeline import), and letting any
  // of them write is how the exclusion silently expires.
  if (existing?.archivedAt && !input.revive) {
    return {
      company: existing,
      created: false,
      contactCreated: false,
      skippedArchived: true,
    };
  }

  let company: CrmCompany;
  let created = false;
  if (existing) {
    const patch: UpdateCompanyInput = {};
    if (existing.archivedAt) patch.archived = false;
    if (input.name) patch.name = input.name;
    if (input.website != null) patch.website = input.website;
    if (input.notes != null && !existing.notes) patch.notes = input.notes;
    if (input.priority != null) patch.priority = input.priority;
    if (input.status != null && existing.status === "lead") {
      // Don't downgrade a later-stage account
      patch.status = input.status;
    }
    if (input.tags?.length) {
      patch.tags = [...new Set([...(existing.tags ?? []), ...input.tags])];
    }
    if (input.enrichment) {
      patch.enrichment = { ...(existing.enrichment ?? {}), ...input.enrichment };
    }
    if (input.ownerEmail != null && !existing.ownerEmail) {
      patch.ownerEmail = input.ownerEmail;
    }
    company =
      Object.keys(patch).length > 0
        ? await updateCompany(client, existing.id, patch)
        : existing;
  } else {
    company = await createCompany(client, {
      ...input,
      domain,
      source: input.source ?? "manual",
    });
    created = true;
  }

  let contactCreated = false;
  const contact = input.contact;
  if (contact?.name?.trim()) {
    // Archived people count as duplicates: they were removed by hand, and
    // re-adding them is exactly the loop this change exists to close.
    const existingContacts = await listContacts(client, company.id, {
      includeArchived: true,
    });
    const emailKey = contact.email?.toLowerCase().trim() ?? "";
    const nameKey = contact.name.toLowerCase().trim();
    const dup = existingContacts.find(
      (c) =>
        (emailKey && c.email?.toLowerCase() === emailKey) ||
        c.name.toLowerCase() === nameKey,
    );

    // Reviving an account has to revive the person it came back for. The only
    // revive is a reply, and the replier matching an archived contact is the
    // normal case — they were excluded with the account. Left archived, the
    // account returns without the one person anybody wants to answer: every
    // reader (account page, enroller, composer) filters archived out.
    //
    // Gated on the *account* having been excluded, not just the contact. On a
    // live account, an archived person is a standalone decision — the wrong
    // contact, or one who asked to be left alone — and a reply from them is
    // not consent to undo it. There is nothing to revive them alongside.
    if (existing?.archivedAt && dup?.archivedAt && input.revive) {
      await restoreContact(client, dup.id);
      contactCreated = true;
    } else if (!dup) {
      await createContact(client, company.id, {
        name: contact.name,
        email: contact.email,
        role: contact.role,
        linkedin: contact.linkedin,
        // Primary among the people who are actually on the account: an
        // archived contact must not leave a new one without the lead flag.
        isPrimary: existingContacts.every((c) => c.archivedAt),
      });
      contactCreated = true;
    }
  }

  return { company, created, contactCreated };
}

export type PromoteEnrollmentInput = {
  id: string;
  sequenceId: string;
  companyName: string;
  domain: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactLinkedin: string | null;
  contactRole: string | null;
};

/**
 * Convert handoff: sequence person → CRM Account (+ contact).
 * - reply → status engaged + priority high. They answered, so the conversation
 *   is live and that is worth seeing in the pipeline — but it is not
 *   qualification: gtm.md wants a substantive conversation plus a nameable next
 *   step, and a reply may be "who are you?" or "take me off this list". A human
 *   moves it to qualified, or to lost, after reading it.
 * - manual promote → status lead (won't downgrade later stages)
 *
 * A reply revives an *excluded account*, and restores the replier along with
 * it. It does not revive a person excluded on their own: on a live account
 * that exclusion is a decision about that person — often the reason they were
 * written to and asked to be left alone — and answering is not consent to
 * undo it. Callers get `contactCreated: false` there, and the person stays off
 * the account.
 * Domain from enrollment.domain or contact email. Idempotent by domain.
 */
export async function promoteEnrollmentToCrm(
  client: SupabaseClient,
  enrollment: PromoteEnrollmentInput,
  opts?: {
    reason?: "reply" | "manual_promote";
    actorEmail?: string | null;
  },
): Promise<{
  company: CrmCompany | null;
  created: boolean;
  contactCreated: boolean;
  skipped?: string;
}> {
  const reason = opts?.reason ?? "manual_promote";
  const email = trimOrNull(enrollment.contactEmail)?.toLowerCase() ?? null;
  const domain =
    normalizeDomain(enrollment.domain) || domainFromEmail(email);
  const companyName =
    trimOrNull(enrollment.companyName) || domain || null;

  if (!companyName) {
    return {
      company: null,
      created: false,
      contactCreated: false,
      skipped: "Missing company name and domain/email",
    };
  }
  if (!domain) {
    return {
      company: null,
      created: false,
      contactCreated: false,
      skipped:
        "Missing domain (set domain on enrollment or use a contact email)",
    };
  }

  let sequenceName: string | null = null;
  try {
    const { data } = await client
      .from("outreach_sequences")
      .select("name")
      .eq("id", enrollment.sequenceId)
      .maybeSingle();
    sequenceName = (data?.name as string | null) ?? null;
  } catch {
    /* ignore */
  }

  const contactName =
    trimOrNull(enrollment.contactName) ||
    (email ? email.split("@")[0] : null) ||
    "Contact";

  const result = await upsertAccountByDomain(client, {
    name: companyName,
    domain,
    website: `https://${domain}`,
    // A reply is the one thing that overturns an exclusion: somebody at the
    // account answered, which is better evidence than whatever made us drop it.
    // A manual promote does not — the person promoting can restore it, and
    // should have to see that the account was excluded on purpose.
    revive: reason === "reply",
    // A reply is engagement; a manual promote is not (nobody has answered yet).
    status: reason === "reply" ? "engaged" : "lead",
    priority: reason === "reply" ? "high" : "medium",
    tags: reason === "reply" ? ["outbound-reply", "sequence"] : ["sequence-promote"],
    source: "sequence",
    enrichment: {
      sequence: {
        enrollment_id: enrollment.id,
        sequence_id: enrollment.sequenceId,
        sequence_name: sequenceName,
        promoted_via: reason,
        contact_email: email,
      },
    },
    contact:
      email || trimOrNull(enrollment.contactName)
        ? {
            name: contactName,
            email,
            role: enrollment.contactRole,
            linkedin: enrollment.contactLinkedin,
          }
        : null,
  });

  // Nothing was written, so nothing is logged. logActivity touches
  // last_activity_at by default, and an excluded account climbing the "recent
  // activity" ordering because a machine tried to promote it and was refused
  // is the machine-write this whole change exists to stop.
  if (result.skippedArchived) {
    return {
      company: result.company,
      created: false,
      contactCreated: false,
      skipped: "Account was excluded — restore it to promote",
    };
  }

  try {
    await logActivity(client, result.company.id, "note", {
      summary:
        reason === "reply"
          ? `Replied to sequence${sequenceName ? ` “${sequenceName}”` : ""}`
          : `Promoted from sequence${sequenceName ? ` “${sequenceName}”` : ""}`,
      meta: {
        enrollment_id: enrollment.id,
        sequence_id: enrollment.sequenceId,
        sequence_name: sequenceName,
        reason,
        company_created: result.created,
        contact_created: result.contactCreated,
      },
      actorEmail: opts?.actorEmail ?? null,
    });
  } catch (err) {
    console.warn("[crm] logActivity on promote failed:", err);
  }

  return {
    company: result.company,
    created: result.created,
    contactCreated: result.contactCreated,
  };
}

/** Map legacy outreach_prospect status → CRM company status. */
export function mapProspectStatusToCompany(
  status: string | null | undefined,
): CompanyStatus {
  switch (status) {
    case "won":
      return "customer";
    case "lost":
      return "lost";
    case "replied":
    case "contacted":
    case "drafted":
    case "researching":
    case "prospect":
    case "snoozed":
    default:
      return "lead";
  }
}

/**
 * One-shot: pull outreach_prospects into Accounts (crm_companies + contacts).
 * Idempotent by domain. Does not delete legacy prospects.
 */
export async function importPipelineProspectsToAccounts(
  client: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<{
  imported: number;
  updated: number;
  /** Prospects whose account a human excluded. Counted apart from `updated`,
   *  which would otherwise report work that never happened. */
  skippedArchived: number;
  contactsCreated: number;
  total: number;
}> {
  const { listProspects } = await import("@/lib/outreach");
  const prospects = await listProspects(client, {
    limit: opts.limit ?? 500,
  });

  let imported = 0;
  let updated = 0;
  let skippedArchived = 0;
  let contactsCreated = 0;

  for (const p of prospects) {
    if (!p.domain) continue;
    const name = p.niche?.trim() || p.domain;
    const result = await upsertAccountByDomain(client, {
      name,
      domain: p.domain,
      website: p.url ?? `https://${p.domain}`,
      status: mapProspectStatusToCompany(p.status),
      priority: p.priority,
      notes: [
        p.notes,
        p.source ? `Legacy pipeline source: ${p.source}` : null,
        p.targetType ? `Target type: ${p.targetType}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      tags: ["pipeline-import", p.targetType].filter(Boolean) as string[],
      source: "pipeline",
      ownerEmail: p.responsibleEmail,
      createdByEmail: p.createdByEmail,
      enrichment: {
        pipeline: {
          prospect_id: p.id,
          status: p.status,
          target_type: p.targetType,
          last_touch_at: p.lastTouchAt,
          next_followup_at: p.nextFollowupAt,
          imported_at: new Date().toISOString(),
        },
      },
      contact:
        p.contactName || p.contactEmail || p.contactUrl
          ? {
              name: p.contactName?.trim() || p.domain,
              email: p.contactEmail,
              linkedin: p.contactUrl,
            }
          : null,
    });
    if (result.skippedArchived) skippedArchived += 1;
    else if (result.created) imported += 1;
    else updated += 1;
    if (result.contactCreated) contactsCreated += 1;
  }

  return {
    imported,
    updated,
    skippedArchived,
    contactsCreated,
    total: prospects.length,
  };
}

export async function upsertCompanyFromWebhook(
  client: SupabaseClient,
  input: CreateCompanyInput,
): Promise<{ company: CrmCompany; created: boolean }> {
  const orgId = trimOrNull(input.orgId);
  const domain = normalizeDomain(input.domain);

  // Find existing by org_id first, then domain.
  let existing: CompanyRow | null = null;
  if (orgId) {
    const { data } = await client
      .from("crm_companies")
      .select("*")
      .eq("org_id", orgId)
      .maybeSingle();
    existing = (data as CompanyRow | null) ?? null;
  }
  if (!existing && domain) {
    const { data } = await client
      .from("crm_companies")
      .select("*")
      .eq("domain", domain)
      .maybeSingle();
    existing = (data as CompanyRow | null) ?? null;
  }

  if (existing?.archived_at) {
    // Same rule as upsertAccountByDomain: an enrichment webhook re-announcing
    // a domain is the sender repeating itself, not a reason to undo a human's
    // exclusion. The payload is dropped and the account stays out.
    await logActivity(client, existing.id, "webhook", {
      summary: "Enrichment webhook ignored — account is excluded",
      meta: (input.enrichment ?? {}) as Record<string, unknown>,
      touch: false,
    });
    return { company: rowToCompany(existing), created: false };
  }

  if (existing) {
    // Merge: only fill fields that arrived in the payload; deep-merge enrichment.
    const merged: UpdateCompanyInput & { enrichment?: Record<string, unknown> } =
      {};
    if (input.name) merged.name = input.name;
    if (domain) merged.domain = domain;
    if (orgId) merged.orgId = orgId;
    if (input.industry != null) merged.industry = input.industry;
    if (input.size != null) merged.size = input.size;
    if (input.devCount != null) merged.devCount = input.devCount;
    if (input.country != null) merged.country = input.country;
    if (input.website != null) merged.website = input.website;
    if (input.linkedin != null) merged.linkedin = input.linkedin;
    if (input.tags != null) merged.tags = input.tags;
    merged.enrichment = {
      ...(existing.enrichment ?? {}),
      ...(input.enrichment ?? {}),
    };
    const company = await updateCompany(client, existing.id, merged);
    await logActivity(client, existing.id, "webhook", {
      summary: "Enrichment webhook received",
      meta: (input.enrichment ?? {}) as Record<string, unknown>,
    });
    return { company, created: false };
  }

  const company = await createCompany(client, {
    ...input,
    source: "webhook",
  });
  await logActivity(client, company.id, "webhook", {
    summary: "Created via enrichment webhook",
    meta: (input.enrichment ?? {}) as Record<string, unknown>,
    touch: false,
  });
  return { company, created: true };
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

/**
 * People on an account. Excluded people are left out by default — the callers
 * are the account page, the sequence enroller and the email composer, and none
 * of them should be looking at someone a human removed.
 *
 * `includeArchived` is for the one caller that has to see them: the people
 * lookup, which merges discovered people into the contact list and would
 * otherwise rediscover and recreate every person you deleted.
 */
export async function listContacts(
  client: SupabaseClient,
  companyId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<CrmContact[]> {
  let query = client
    .from("crm_contacts")
    .select("*")
    .eq("company_id", companyId);
  if (!opts.includeArchived) query = query.is("archived_at", null);
  const { data, error } = await query
    .order("is_primary", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Failed to list contacts: ${error.message}`);
  return (data ?? []).map((r) => rowToContact(r as ContactRow));
}

export async function createContact(
  client: SupabaseClient,
  companyId: string,
  input: {
    name: string;
    email?: string | null;
    role?: string | null;
    phone?: string | null;
    linkedin?: string | null;
    isPrimary?: boolean;
  },
): Promise<CrmContact> {
  const name = trimOrNull(input.name);
  if (!name) throw new Error("contact name is required");
  const { data, error } = await client
    .from("crm_contacts")
    .insert({
      company_id: companyId,
      name,
      email: trimOrNull(input.email),
      role: trimOrNull(input.role),
      phone: trimOrNull(input.phone),
      linkedin: trimOrNull(input.linkedin),
      is_primary: input.isPrimary ?? false,
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create contact: ${error.message}`);
  return rowToContact(data as ContactRow);
}

/** Thrown when a contact id matches no row, so callers can answer 404. */
export class ContactNotFoundError extends Error {
  constructor(id: string) {
    super(`Contact ${id} not found`);
    this.name = "ContactNotFoundError";
  }
}

export async function updateContact(
  client: SupabaseClient,
  id: string,
  input: {
    name?: string;
    email?: string | null;
    role?: string | null;
    phone?: string | null;
    linkedin?: string | null;
    isPrimary?: boolean;
  },
): Promise<CrmContact> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    const name = trimOrNull(input.name);
    if (!name) throw new Error("contact name is required");
    patch.name = name;
  }
  if (input.email !== undefined) patch.email = trimOrNull(input.email);
  if (input.role !== undefined) patch.role = trimOrNull(input.role);
  if (input.phone !== undefined) patch.phone = trimOrNull(input.phone);
  if (input.linkedin !== undefined) patch.linkedin = trimOrNull(input.linkedin);
  if (input.isPrimary !== undefined) patch.is_primary = input.isPrimary;
  if (Object.keys(patch).length === 0) throw new Error("nothing to update");

  const { data, error } = await client
    .from("crm_contacts")
    .update(patch)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Failed to update contact: ${error.message}`);
  if (!data) throw new ContactNotFoundError(id);
  return rowToContact(data as ContactRow);
}

/**
 * Exclude a person. Archived, not deleted: the people lookup matches against
 * the contacts it can see, so a deleted person was invisible to it and got
 * created again by the next run. Archived, they are matched and skipped.
 *
 * Also drops `is_primary` — an excluded person must not stay the account's
 * lead contact, which is the field the email composer reads first.
 */
export async function archiveContact(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { data, error } = await client
    .from("crm_contacts")
    .update({ archived_at: new Date().toISOString(), is_primary: false })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Failed to archive contact: ${error.message}`);
  if (!data) throw new ContactNotFoundError(id);
}

/** Undo an exclusion. Does not restore `is_primary` — archiving cleared it,
 *  and whoever the account has been treating as its lead contact since then
 *  should stay the lead contact. */
export async function restoreContact(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { data, error } = await client
    .from("crm_contacts")
    .update({ archived_at: null })
    .eq("id", id)
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Failed to restore contact: ${error.message}`);
  if (!data) throw new ContactNotFoundError(id);
}

// ---------------------------------------------------------------------------
// Comments (markdown)
// ---------------------------------------------------------------------------

export async function listComments(
  client: SupabaseClient,
  companyId: string,
): Promise<CrmComment[]> {
  const { data, error } = await client
    .from("crm_comments")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to list comments: ${error.message}`);
  return (data ?? []).map((r) => rowToComment(r as CommentRow));
}

export async function createComment(
  client: SupabaseClient,
  companyId: string,
  bodyMd: string,
  authorEmail?: string | null,
): Promise<CrmComment> {
  const body = trimOrNull(bodyMd);
  if (!body) throw new Error("comment body is required");
  const { data, error } = await client
    .from("crm_comments")
    .insert({
      company_id: companyId,
      body_md: body,
      author_email: trimOrNull(authorEmail),
    })
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create comment: ${error.message}`);
  await logActivity(client, companyId, "comment", {
    summary: body.slice(0, 120),
    actorEmail: authorEmail,
  });
  return rowToComment(data as CommentRow);
}

export async function deleteComment(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("crm_comments").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete comment: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Activities
// ---------------------------------------------------------------------------

export async function listActivities(
  client: SupabaseClient,
  companyId: string,
  limit = 50,
): Promise<CrmActivity[]> {
  const { data, error } = await client
    .from("crm_activities")
    .select("*")
    .eq("company_id", companyId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to list activities: ${error.message}`);
  return (data ?? []).map((r) => rowToActivity(r as ActivityRow));
}

// ---------------------------------------------------------------------------
// Stats + stale detection (used by dashboard badge and idle cron)
// ---------------------------------------------------------------------------

export async function getCompanyStats(
  client: SupabaseClient,
): Promise<{ total: number; byStatus: Record<string, number>; stale: number }> {
  const companies = await listCompanies(client, { limit: 1000 });
  const byStatus: Record<string, number> = {};
  let stale = 0;
  for (const c of companies) {
    byStatus[c.status] = (byStatus[c.status] || 0) + 1;
    if (c.isStale) stale++;
  }
  return { total: companies.length, byStatus, stale };
}

export async function getStaleCompanies(
  client: SupabaseClient,
): Promise<CompanyWithIdle[]> {
  return listCompanies(client, { staleOnly: true, limit: 1000 });
}
