import { NextResponse } from "next/server";

import { enrichCompanyContacts } from "@/lib/crm-enrich";
import { getSupabaseUserClient } from "@/lib/supabase-server";

// Find the people behind an account and merge them into its contacts.
// POST rather than GET: this bills a third-party lookup and writes contacts.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await req.json().catch(() => ({}));
    const result = await enrichCompanyContacts(client, id, {
      maxPeople: body.maxPeople,
    });
    return NextResponse.json({ result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Enrichment failed" },
      { status: 500 },
    );
  }
}
