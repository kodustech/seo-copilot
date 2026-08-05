import { NextResponse } from "next/server";

import {
  enrollFromCrm,
  enrollFromProspects,
  enrollFromResearch,
  unenrollFromSequence,
} from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST body:
 * { source: "research", table_ref, row_ids?, all_people? }
 * { source: "outreach", prospect_ids: string[] }
 * { source: "crm", company_ids: string[], all_contacts?, allow_parallel? }
 *
 * The CRM source was missing here while enrollFromCrm already existed and was
 * reachable from two other places — the auto-enroll rules and the AI tool.
 * The consequence was that a single account could be enrolled by writing a rule
 * or by asking the agent, but not by a person looking at the account, which is
 * the most obvious way to want to do it.
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

    if (source === "crm") {
      const ids = Array.isArray(body.company_ids) ? body.company_ids : [];
      if (ids.length === 0) {
        return NextResponse.json(
          { error: "company_ids required" },
          { status: 400 },
        );
      }
      const result = await enrollFromCrm(client, {
        sequenceId: id,
        companyIds: ids,
        allContacts: body.all_contacts === true,
        allowParallel: body.allow_parallel === true,
        enrolledByEmail: userEmail,
      });
      return NextResponse.json(result);
    }

    return NextResponse.json(
      { error: 'source must be "research", "outreach" or "crm"' },
      { status: 400 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const rawEnrollmentIds: unknown[] = Array.isArray(body.enrollment_ids)
      ? body.enrollment_ids
      : [];
    const enrollmentIds = rawEnrollmentIds.filter(
      (value): value is string => typeof value === "string",
    );
    if (enrollmentIds.length === 0) {
      return NextResponse.json(
        { error: "enrollment_ids required" },
        { status: 400 },
      );
    }
    const result = await unenrollFromSequence(client, {
      sequenceId: id,
      enrollmentIds,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
