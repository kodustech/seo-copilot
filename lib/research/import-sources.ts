import type { SupabaseClient } from "@supabase/supabase-js";

import { listCompanies } from "@/lib/crm";
import { listSignals, listWatchlist } from "@/lib/icp/scanner";
import { addRows } from "@/lib/research/tables";
import { normalizeDomain } from "@/lib/crm";

/** Import domains from ICP watchlist into a research table. */
export async function importFromWatchlist(
  client: SupabaseClient,
  tableId: string,
): Promise<{ added: number; skipped: number }> {
  const entries = await listWatchlist(client, { activeOnly: true });
  return addRows(
    client,
    tableId,
    entries.map((e) => ({
      companyName: e.companyName,
      domain: e.domain,
      source: "discovery",
    })),
  );
}

/** Import companies that already have strong ICP signals. */
export async function importFromStrongSignals(
  client: SupabaseClient,
  tableId: string,
): Promise<{ added: number; skipped: number }> {
  const signals = await listSignals(client, { strength: "strong", days: 90 });
  const byCompany = new Map<
    string,
    { companyName: string; domain: string | null }
  >();
  for (const s of signals) {
    const key = (s.domain ?? s.companyName).toLowerCase();
    if (!byCompany.has(key)) {
      byCompany.set(key, {
        companyName: s.companyName,
        domain: s.domain,
      });
    }
  }
  return addRows(
    client,
    tableId,
    [...byCompany.values()].map((c) => ({
      ...c,
      source: "icp_signal",
    })),
  );
}

/** Import CRM companies (optional status filter). */
export async function importFromCrm(
  client: SupabaseClient,
  tableId: string,
  opts: { status?: string | string[] } = {},
): Promise<{ added: number; skipped: number }> {
  const companies = await listCompanies(client, {
    status: opts.status as never,
    limit: 500,
  });
  return addRows(
    client,
    tableId,
    companies.map((c) => ({
      companyName: c.name,
      domain: c.domain,
      source: "crm",
    })),
  );
}

/** Import domains extracted from social mentions batch. */
export async function importDomains(
  client: SupabaseClient,
  tableId: string,
  items: Array<{ companyName?: string; domain: string; source?: string }>,
): Promise<{ added: number; skipped: number }> {
  return addRows(
    client,
    tableId,
    items.map((i) => ({
      companyName: i.companyName?.trim() || i.domain,
      domain: normalizeDomain(i.domain),
      source: i.source ?? "social",
    })),
  );
}
