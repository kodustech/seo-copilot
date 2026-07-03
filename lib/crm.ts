import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompanyStatus =
  | "lead"
  | "qualified"
  | "trial"
  | "negotiation"
  | "customer"
  | "churned"
  | "lost";

export type CompanyPriority = "high" | "medium" | "low";

export type CompanySource = "manual" | "webhook" | "agent";

export const COMPANY_STATUSES: CompanyStatus[] = [
  "lead",
  "qualified",
  "trial",
  "negotiation",
  "customer",
  "churned",
  "lost",
];

export const COMPANY_PRIORITIES: CompanyPriority[] = ["high", "medium", "low"];

export type ActivityKind =
  | "created"
  | "status_change"
  | "owner_change"
  | "comment"
  | "webhook"
  | "note";

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
  country: string | null;
  website: string | null;
  linkedin: string | null;
  arr: number | null;
  tags: string[];
  enrichment: Record<string, unknown>;
  source: CompanySource;
  notes: string | null;
  lastActivityAt: string | null;
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
  country?: string | null;
  website?: string | null;
  linkedin?: string | null;
  arr?: number | null;
  tags?: string[];
  enrichment?: Record<string, unknown>;
  source?: CompanySource;
  notes?: string | null;
  createdByEmail?: string | null;
};

export type UpdateCompanyInput = Partial<
  Omit<CreateCompanyInput, "createdByEmail" | "source">
>;

export type CompanyFilters = {
  status?: CompanyStatus | CompanyStatus[];
  priority?: CompanyPriority;
  ownerEmail?: string;
  search?: string;
  staleOnly?: boolean;
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
  country: string | null;
  website: string | null;
  linkedin: string | null;
  arr: number | string | null;
  tags: string[] | null;
  enrichment: Record<string, unknown> | null;
  source: CompanySource | null;
  notes: string | null;
  last_activity_at: string | null;
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
    country: row.country,
    website: row.website,
    linkedin: row.linkedin,
    arr: row.arr == null ? null : Number(row.arr),
    tags: row.tags ?? [],
    enrichment: row.enrichment ?? {},
    source: row.source ?? "manual",
    notes: row.notes,
    lastActivityAt: row.last_activity_at,
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

  if (filters.status) {
    if (Array.isArray(filters.status)) query = query.in("status", filters.status);
    else query = query.eq("status", filters.status);
  }
  if (filters.priority) query = query.eq("priority", filters.priority);
  if (filters.ownerEmail) query = query.eq("owner_email", filters.ownerEmail);
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
    country: trimOrNull(input.country),
    website: trimOrNull(input.website),
    linkedin: trimOrNull(input.linkedin),
    arr: typeof input.arr === "number" ? input.arr : null,
    tags: input.tags ?? [],
    enrichment: input.enrichment ?? {},
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
  if ("status" in updates && updates.status !== undefined)
    patch.status = updates.status;
  if ("priority" in updates && updates.priority !== undefined)
    patch.priority = updates.priority;
  if ("ownerEmail" in updates)
    patch.owner_email = trimOrNull(updates.ownerEmail);
  if ("industry" in updates) patch.industry = trimOrNull(updates.industry);
  if ("size" in updates) patch.size = trimOrNull(updates.size);
  if ("country" in updates) patch.country = trimOrNull(updates.country);
  if ("website" in updates) patch.website = trimOrNull(updates.website);
  if ("linkedin" in updates) patch.linkedin = trimOrNull(updates.linkedin);
  if ("arr" in updates)
    patch.arr = typeof updates.arr === "number" ? updates.arr : null;
  if ("tags" in updates && updates.tags !== undefined) patch.tags = updates.tags;
  if ("enrichment" in updates && updates.enrichment !== undefined)
    patch.enrichment = updates.enrichment;
  if ("notes" in updates) patch.notes = trimOrNull(updates.notes);

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
  if ("owner_email" in patch && next.ownerEmail !== prev.ownerEmail) {
    await logActivity(client, id, "owner_change", {
      summary: `Owner: ${prev.ownerEmail ?? "—"} → ${next.ownerEmail ?? "—"}`,
      meta: { from: prev.ownerEmail, to: next.ownerEmail },
      actorEmail,
    });
  }
  return next;
}

export async function deleteCompany(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("crm_companies").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete company: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Webhook upsert — idempotent by org_id, then domain.
// ---------------------------------------------------------------------------

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

  if (existing) {
    // Merge: only fill fields that arrived in the payload; deep-merge enrichment.
    const merged: UpdateCompanyInput & { enrichment?: Record<string, unknown> } =
      {};
    if (input.name) merged.name = input.name;
    if (domain) merged.domain = domain;
    if (orgId) merged.orgId = orgId;
    if (input.industry != null) merged.industry = input.industry;
    if (input.size != null) merged.size = input.size;
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

export async function listContacts(
  client: SupabaseClient,
  companyId: string,
): Promise<CrmContact[]> {
  const { data, error } = await client
    .from("crm_contacts")
    .select("*")
    .eq("company_id", companyId)
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

export async function deleteContact(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("crm_contacts").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete contact: ${error.message}`);
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
