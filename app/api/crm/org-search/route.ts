import { NextResponse } from "next/server";

import { searchProductOrgs } from "@/lib/crm-org-search";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * Autocomplete for linking a CRM account to a product org.
 * Tries product_signals_latest first; falls back to BigQuery organizations.
 */
export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) {
    return NextResponse.json({ orgs: [], source: "none" });
  }

  try {
    const result = await searchProductOrgs(client, q);
    return NextResponse.json({
      orgs: result.orgs.map((r) => ({
        orgId: r.orgId,
        name: r.name,
        orgType: r.orgType,
        userCount: r.userCount,
        planType: r.planType,
        tier: r.tier,
        connectedGit: r.connectedGit,
      })),
      source: result.source,
      note: result.note,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 },
    );
  }
}
