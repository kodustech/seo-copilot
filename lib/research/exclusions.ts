import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizeDomain } from "@/lib/crm";

/**
 * Per-list exclusion memory. Deleting a company records it here; the import
 * path (addRows) consults it, so a cleaned list stays cleaned across later
 * researchFindIcp runs instead of re-importing the same companies with new ids.
 */
export type ResearchExclusion = {
  id: string;
  tableId: string;
  domain: string | null;
  companyKey: string;
  companyName: string;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
};

export type ExclusionInput = {
  companyName: string;
  domain?: string | null;
  reason?: string | null;
  createdBy?: string | null;
};

/**
 * Match key for a company name: lowercase, accents stripped, punctuation and
 * whitespace removed, so "Lemon.io", "lemon io" and "LEMON.IO" collide.
 * Legal suffixes are kept — "Acme Ltda" and "Acme" stay distinct, since
 * dropping them would exclude unrelated companies that share a prefix.
 */
export function normalizeCompanyKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function mapExclusion(r: Record<string, unknown>): ResearchExclusion {
  return {
    id: r.id as string,
    tableId: r.table_id as string,
    domain: (r.domain as string | null) ?? null,
    companyKey: r.company_key as string,
    companyName: r.company_name as string,
    reason: (r.reason as string | null) ?? null,
    createdBy: (r.created_by as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

export async function listExclusions(
  client: SupabaseClient,
  tableId: string,
): Promise<ResearchExclusion[]> {
  const { data, error } = await client
    .from("research_excluded_companies")
    .select("*")
    .eq("table_id", tableId)
    .order("created_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to list excluded companies: ${error.message}`);
  }
  return (data ?? []).map((r) => mapExclusion(r as Record<string, unknown>));
}

/** Record companies as excluded from a list. Idempotent per (table, key). */
export async function addExclusions(
  client: SupabaseClient,
  tableId: string,
  items: ExclusionInput[],
): Promise<number> {
  const seen = new Set<string>();
  const rows = items
    .map((item) => {
      const companyName = item.companyName?.trim() || "";
      const domain = normalizeDomain(item.domain ?? null);
      const companyKey = normalizeCompanyKey(companyName || domain || "");
      if (!companyKey) return null;
      return {
        table_id: tableId,
        domain,
        company_key: companyKey,
        company_name: companyName || domain || companyKey,
        reason: item.reason ?? null,
        created_by: item.createdBy ?? null,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null)
    // Both unique indexes are per (table, key), so an in-batch repeat would
    // make the whole insert fail on itself.
    .filter((r) => {
      const dedupeKey = `${r.company_key}|${r.domain ?? ""}`;
      if (seen.has(dedupeKey)) return false;
      seen.add(dedupeKey);
      return true;
    });
  if (rows.length === 0) return 0;

  // Drop what is already excluded, so the common case is one SELECT + one
  // INSERT rather than a round trip per company. `insert` has no
  // ignoreDuplicates option (that is upsert-only, and upsert can name just one
  // conflict target while this table has two unique indexes), so a race still
  // has to be caught per row below.
  const existing = await loadExclusionIndex(client, tableId);
  const fresh = rows.filter(
    (r) =>
      !existing.isExcluded({ companyName: r.company_name, domain: r.domain }),
  );
  if (fresh.length === 0) return 0;

  const { data, error } = await client
    .from("research_excluded_companies")
    .insert(fresh)
    .select("id");
  if (!error) return data?.length ?? 0;
  if (error.code !== "23505") {
    throw new Error(`Failed to exclude company: ${error.message}`);
  }

  // Someone excluded one of these between the read and the write: the batch
  // rolled back whole, so retry row by row and let the duplicates fall out.
  let written = 0;
  for (const row of fresh) {
    const { error: rowError } = await client
      .from("research_excluded_companies")
      .insert(row);
    if (rowError) {
      if (rowError.code === "23505") continue; // already excluded
      throw new Error(`Failed to exclude company: ${rowError.message}`);
    }
    written += 1;
  }
  return written;
}

/**
 * Drop exclusion entries matching any of these companies. Called when a
 * company is deliberately re-added, and when a list is deleted or restored.
 */
export async function removeExclusions(
  client: SupabaseClient,
  tableId: string,
  items: Array<{ companyName?: string | null; domain?: string | null }>,
): Promise<number> {
  const keys = new Set<string>();
  const domains = new Set<string>();
  for (const item of items) {
    const domain = normalizeDomain(item.domain ?? null);
    if (domain) domains.add(domain);
    const key = normalizeCompanyKey(item.companyName?.trim() || domain || "");
    if (key) keys.add(key);
  }
  if (keys.size === 0 && domains.size === 0) return 0;

  let removed = 0;
  if (keys.size > 0) {
    const { data, error } = await client
      .from("research_excluded_companies")
      .delete()
      .eq("table_id", tableId)
      .in("company_key", [...keys])
      .select("id");
    if (error) {
      throw new Error(`Failed to clear exclusions: ${error.message}`);
    }
    removed += data?.length ?? 0;
  }
  if (domains.size > 0) {
    const { data, error } = await client
      .from("research_excluded_companies")
      .delete()
      .eq("table_id", tableId)
      .in("domain", [...domains])
      .select("id");
    if (error) {
      throw new Error(`Failed to clear exclusions: ${error.message}`);
    }
    removed += data?.length ?? 0;
  }
  return removed;
}

/** Remove every exclusion for a list (used when the list itself is deleted). */
export async function clearExclusionsForTable(
  client: SupabaseClient,
  tableId: string,
): Promise<void> {
  const { error } = await client
    .from("research_excluded_companies")
    .delete()
    .eq("table_id", tableId);
  if (error) {
    throw new Error(`Failed to clear exclusions: ${error.message}`);
  }
}

export type ExclusionIndex = {
  domains: Set<string>;
  keys: Set<string>;
  size: number;
  isExcluded(company: { companyName: string; domain: string | null }): boolean;
};

/** Load a list's exclusions once, then test candidates in memory. */
export async function loadExclusionIndex(
  client: SupabaseClient,
  tableId: string,
): Promise<ExclusionIndex> {
  const rows = await listExclusions(client, tableId);
  const domains = new Set(
    rows.map((r) => r.domain).filter((d): d is string => Boolean(d)),
  );
  const keys = new Set(rows.map((r) => r.companyKey));
  return {
    domains,
    keys,
    size: rows.length,
    isExcluded({ companyName, domain }) {
      if (domain && domains.has(domain)) return true;
      const key = normalizeCompanyKey(companyName || domain || "");
      return key ? keys.has(key) : false;
    },
  };
}
