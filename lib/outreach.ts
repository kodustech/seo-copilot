import type { SupabaseClient } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProspectStatus =
  | "prospect"
  | "researching"
  | "drafted"
  | "contacted"
  | "replied"
  | "won"
  | "lost"
  | "snoozed";

export type ProspectTargetType =
  | "listicle"
  | "guest_post"
  | "podcast"
  | "awesome_list"
  | "article"
  | "newsletter"
  | "other";

export type ProspectPriority = "high" | "medium" | "low";

export const PROSPECT_STATUSES: ProspectStatus[] = [
  "prospect",
  "researching",
  "drafted",
  "contacted",
  "replied",
  "won",
  "lost",
  "snoozed",
];

export const PROSPECT_TARGET_TYPES: ProspectTargetType[] = [
  "listicle",
  "guest_post",
  "podcast",
  "awesome_list",
  "article",
  "newsletter",
  "other",
];

export const PROSPECT_PRIORITIES: ProspectPriority[] = [
  "high",
  "medium",
  "low",
];

export type OutreachProspect = {
  id: string;
  domain: string;
  url: string | null;
  targetType: ProspectTargetType;
  contactName: string | null;
  contactEmail: string | null;
  contactUrl: string | null;
  dr: number | null;
  niche: string | null;
  status: ProspectStatus;
  priority: ProspectPriority;
  lastTouchAt: string | null;
  nextFollowupAt: string | null;
  notes: string | null;
  responsibleEmail: string | null;
  source: string | null;
  sourceMentionId: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateProspectInput = {
  domain: string;
  url?: string | null;
  targetType: ProspectTargetType;
  contactName?: string | null;
  contactEmail?: string | null;
  contactUrl?: string | null;
  dr?: number | null;
  niche?: string | null;
  status?: ProspectStatus;
  priority?: ProspectPriority;
  lastTouchAt?: string | null;
  nextFollowupAt?: string | null;
  notes?: string | null;
  responsibleEmail?: string | null;
  source?: string | null;
  sourceMentionId?: string | null;
  createdByEmail?: string | null;
};

export type UpdateProspectInput = Partial<
  Omit<CreateProspectInput, "createdByEmail">
>;

export type ProspectFilters = {
  status?: ProspectStatus | ProspectStatus[];
  targetType?: ProspectTargetType;
  responsibleEmail?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = {
  id: string;
  domain: string;
  url: string | null;
  target_type: ProspectTargetType;
  contact_name: string | null;
  contact_email: string | null;
  contact_url: string | null;
  dr: number | null;
  niche: string | null;
  status: ProspectStatus;
  priority: ProspectPriority;
  last_touch_at: string | null;
  next_followup_at: string | null;
  notes: string | null;
  responsible_email: string | null;
  source: string | null;
  source_mention_id: string | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
};

function rowToProspect(row: Row): OutreachProspect {
  return {
    id: row.id,
    domain: row.domain,
    url: row.url,
    targetType: row.target_type,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactUrl: row.contact_url,
    dr: row.dr,
    niche: row.niche,
    status: row.status,
    priority: row.priority,
    lastTouchAt: row.last_touch_at,
    nextFollowupAt: row.next_followup_at,
    notes: row.notes,
    responsibleEmail: row.responsible_email,
    source: row.source,
    sourceMentionId: row.source_mention_id,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function trimOrNull(v: string | null | undefined): string | null {
  if (typeof v !== "string") return v ?? null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

// Best-effort hostname extraction so callers can pass a full URL and get a
// clean domain back. Falls back to the input when URL parsing fails.
export function extractDomain(value: string): string {
  try {
    const u = new URL(value.includes("://") ? value : `https://${value}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return value.trim();
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listProspects(
  client: SupabaseClient,
  filters: ProspectFilters = {},
): Promise<OutreachProspect[]> {
  let query = client
    .from("outreach_prospects")
    .select("*")
    .order("updated_at", { ascending: false });

  if (filters.status) {
    if (Array.isArray(filters.status)) {
      query = query.in("status", filters.status);
    } else {
      query = query.eq("status", filters.status);
    }
  }
  if (filters.targetType) {
    query = query.eq("target_type", filters.targetType);
  }
  if (filters.responsibleEmail) {
    query = query.eq("responsible_email", filters.responsibleEmail);
  }
  if (filters.search && filters.search.trim()) {
    const term = `%${filters.search.trim()}%`;
    query = query.or(
      `domain.ilike.${term},url.ilike.${term},contact_name.ilike.${term},contact_email.ilike.${term},notes.ilike.${term}`,
    );
  }
  if (filters.limit) query = query.limit(filters.limit);
  if (filters.offset) {
    query = query.range(
      filters.offset,
      filters.offset + (filters.limit ?? 100) - 1,
    );
  }

  const { data, error } = await query;
  if (error) throw new Error(`Failed to list prospects: ${error.message}`);
  return (data ?? []).map((row) => rowToProspect(row as Row));
}

export async function createProspect(
  client: SupabaseClient,
  input: CreateProspectInput,
): Promise<OutreachProspect> {
  const domain = extractDomain(input.domain);
  if (!domain) throw new Error("domain is required");

  const row = {
    domain,
    url: trimOrNull(input.url),
    target_type: input.targetType,
    contact_name: trimOrNull(input.contactName),
    contact_email: trimOrNull(input.contactEmail),
    contact_url: trimOrNull(input.contactUrl),
    dr: typeof input.dr === "number" ? input.dr : null,
    niche: trimOrNull(input.niche),
    status: input.status ?? "prospect",
    priority: input.priority ?? "medium",
    last_touch_at: input.lastTouchAt ?? null,
    next_followup_at: input.nextFollowupAt ?? null,
    notes: trimOrNull(input.notes),
    responsible_email: trimOrNull(input.responsibleEmail),
    source: trimOrNull(input.source),
    source_mention_id: input.sourceMentionId ?? null,
    created_by_email: trimOrNull(input.createdByEmail),
  };

  const { data, error } = await client
    .from("outreach_prospects")
    .insert(row)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to create prospect: ${error.message}`);
  return rowToProspect(data as Row);
}

export async function updateProspect(
  client: SupabaseClient,
  id: string,
  updates: UpdateProspectInput,
): Promise<OutreachProspect> {
  const patch: Record<string, unknown> = {};
  if ("domain" in updates && updates.domain !== undefined)
    patch.domain = extractDomain(updates.domain);
  if ("url" in updates) patch.url = trimOrNull(updates.url ?? null);
  if ("targetType" in updates && updates.targetType !== undefined)
    patch.target_type = updates.targetType;
  if ("contactName" in updates)
    patch.contact_name = trimOrNull(updates.contactName ?? null);
  if ("contactEmail" in updates)
    patch.contact_email = trimOrNull(updates.contactEmail ?? null);
  if ("contactUrl" in updates)
    patch.contact_url = trimOrNull(updates.contactUrl ?? null);
  if ("dr" in updates)
    patch.dr = typeof updates.dr === "number" ? updates.dr : null;
  if ("niche" in updates) patch.niche = trimOrNull(updates.niche ?? null);
  if ("status" in updates && updates.status !== undefined)
    patch.status = updates.status;
  if ("priority" in updates && updates.priority !== undefined)
    patch.priority = updates.priority;
  if ("lastTouchAt" in updates)
    patch.last_touch_at = updates.lastTouchAt ?? null;
  if ("nextFollowupAt" in updates)
    patch.next_followup_at = updates.nextFollowupAt ?? null;
  if ("notes" in updates) patch.notes = trimOrNull(updates.notes ?? null);
  if ("responsibleEmail" in updates)
    patch.responsible_email = trimOrNull(updates.responsibleEmail ?? null);
  if ("source" in updates) patch.source = trimOrNull(updates.source ?? null);
  if ("sourceMentionId" in updates)
    patch.source_mention_id = updates.sourceMentionId ?? null;

  const { data, error } = await client
    .from("outreach_prospects")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(`Failed to update prospect: ${error.message}`);
  return rowToProspect(data as Row);
}

export async function deleteProspect(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("outreach_prospects")
    .delete()
    .eq("id", id);
  if (error) throw new Error(`Failed to delete prospect: ${error.message}`);
}

export async function getProspectStats(
  client: SupabaseClient,
): Promise<{ total: number; byStatus: Record<string, number> }> {
  const { data, error } = await client
    .from("outreach_prospects")
    .select("status");
  if (error) throw new Error(`Failed to get prospect stats: ${error.message}`);
  const byStatus: Record<string, number> = {};
  for (const row of (data ?? []) as { status: string }[]) {
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
  }
  return { total: (data ?? []).length, byStatus };
}
