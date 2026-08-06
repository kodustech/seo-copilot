import { NextResponse } from "next/server";

import { importPipelineProspectsToAccounts } from "@/lib/crm";
import { getSupabaseUserClient } from "@/lib/supabase-server";

/**
 * One-shot migration: legacy outreach_prospects → Accounts (crm_companies).
 * Idempotent by domain. Does not delete pipeline rows.
 */
export async function POST(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await req.json().catch(() => ({}));
    const limit =
      typeof body.limit === "number" && body.limit > 0
        ? Math.min(body.limit, 1000)
        : 500;
    const result = await importPipelineProspectsToAccounts(client, { limit });
    return NextResponse.json({
      ok: true,
      ...result,
      message:
        `Imported ${result.imported} new accounts, updated ${result.updated}, ` +
        `${result.contactsCreated} contacts from ${result.total} pipeline rows.` +
        // Only shown when it happened: a "0 excluded" on every run trains
        // people to stop reading the line that matters.
        (result.skippedArchived
          ? ` ${result.skippedArchived} skipped (excluded accounts).`
          : ""),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
