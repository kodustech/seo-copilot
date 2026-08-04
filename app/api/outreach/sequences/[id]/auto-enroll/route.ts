import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  deleteAutoEnrollRule,
  listAutoEnrollRules,
  runAutoEnrollRule,
  upsertAutoEnrollRule,
} from "@/lib/outreach/auto-enroll";

type Ctx = { params: Promise<{ id: string }> };

async function auth(req: Request) {
  return getSupabaseUserClient(req.headers.get("authorization"));
}

// Rules attached to this sequence.
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const { client } = await auth(req);
    return NextResponse.json({ rules: await listAutoEnrollRules(client, id) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}

/**
 * Create or update a rule, or preview one.
 *
 * `preview: true` resolves the filter and reports the audience without
 * enrolling anyone — the UI calls it before a rule can be switched on, because
 * how many accounts a filter matches is not obvious from reading it and the
 * first run is the one that cannot be undone.
 */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const { client, userEmail } = await auth(req);
    const body = await req.json();

    if (body.preview) {
      const result = await runAutoEnrollRule(
        client,
        {
          id: body.id ?? "preview",
          sequenceId: id,
          name: body.name ?? null,
          filters: body.filters ?? {},
          active: false,
          // Clamped exactly as upsert does, so the preview cannot promise a
          // batch size the saved rule is unable to reach.
          maxPerRun: Math.max(1, Math.min(body.maxPerRun ?? 10, 200)),
          allContacts: body.allContacts ?? false,
          lastRunAt: null,
          lastResult: null,
          createdBy: userEmail ?? null,
        },
        { dryRun: true },
      );
      return NextResponse.json({ preview: result });
    }

    const rule = await upsertAutoEnrollRule(client, {
      id: body.id,
      sequenceId: id,
      name: body.name,
      filters: body.filters,
      active: body.active,
      maxPerRun: body.maxPerRun,
      allContacts: body.allContacts,
      createdByEmail: userEmail ?? null,
    });
    return NextResponse.json({ rule });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  await ctx.params;
  try {
    const { client } = await auth(req);
    const ruleId = new URL(req.url).searchParams.get("ruleId");
    if (!ruleId) {
      return NextResponse.json({ error: "ruleId is required" }, { status: 400 });
    }
    await deleteAutoEnrollRule(client, ruleId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 500 },
    );
  }
}
