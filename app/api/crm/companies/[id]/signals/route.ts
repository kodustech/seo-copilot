import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { getCompany } from "@/lib/crm";
import { getProductSignals } from "@/lib/crm-signals";

// Product usage signals for a company, pulled from BigQuery via its org_id.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const company = await getCompany(client, id);
    if (!company) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!company.orgId) {
      return NextResponse.json({ signals: null, reason: "no_org_id" });
    }
    const signals = await getProductSignals(company.orgId);
    return NextResponse.json({ signals });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load signals" },
      { status: 500 },
    );
  }
}
