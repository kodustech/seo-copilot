import { NextResponse } from "next/server";

import {
  enrollFromProspects,
  enrollFromResearch,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST body:
 * { source: "research", table_ref, row_ids?, all_people? }
 * { source: "outreach", prospect_ids: string[] }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const source = body.source as string;

    if (source === "research") {
      const tableRef = String(body.table_ref ?? body.table_id ?? "");
      if (!tableRef) {
        return NextResponse.json(
          { error: "table_ref required" },
          { status: 400 },
        );
      }
      const result = await enrollFromResearch(client, {
        sequenceId: id,
        tableRef,
        rowIds: Array.isArray(body.row_ids) ? body.row_ids : undefined,
        allPeople: body.all_people !== false,
        enrolledByEmail: userEmail,
      });
      return NextResponse.json(result);
    }

    if (source === "outreach") {
      const ids = Array.isArray(body.prospect_ids) ? body.prospect_ids : [];
      if (ids.length === 0) {
        return NextResponse.json(
          { error: "prospect_ids required" },
          { status: 400 },
        );
      }
      const result = await enrollFromProspects(client, {
        sequenceId: id,
        prospectIds: ids,
        enrolledByEmail: userEmail,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: 'source must be "research" or "outreach"' },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
