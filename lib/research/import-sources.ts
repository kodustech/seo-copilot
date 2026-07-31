import type { SupabaseClient } from "@supabase/supabase-js";

import { listCompanies, normalizeDomain } from "@/lib/crm";
import { addRows } from "@/lib/research/tables";

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
    items.map((item) => ({
      companyName: item.companyName ?? item.domain,
      domain: normalizeDomain(item.domain) ?? item.domain,
      source: item.source ?? "import",
    })),
  );
}
