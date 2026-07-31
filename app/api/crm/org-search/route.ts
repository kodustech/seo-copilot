import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

// Autocomplete for linking a CRM account to a product org. Searches
// product_signals_latest (kept fresh by the product-signals sweep) by org
// name or id prefix — no BigQuery round-trip, so it is fast enough to hit
// on every keystroke.
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
    return NextResponse.json({ orgs: [] });
  }

  try {
    const escaped = q.replace(/[%_,()]/g, " ").trim();
    const { data, error } = await client
      .from("product_signals_latest")
      .select(
        "org_id,org_name,org_type,user_count,plan_type,tier,connected_git",
      )
      .or(`org_name.ilike.%${escaped}%,org_id.ilike.${escaped}%`)
      .order("user_count", { ascending: false, nullsFirst: false })
      .limit(10);
    if (error) throw new Error(error.message);

    return NextResponse.json({
      orgs: (data ?? []).map((r) => ({
        orgId: r.org_id,
        name: r.org_name,
        orgType: r.org_type,
        userCount: r.user_count,
        planType: r.plan_type,
        tier: r.tier,
        connectedGit: r.connected_git,
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Search failed" },
      { status: 500 },
    );
  }
}
