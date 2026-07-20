import { NextResponse } from "next/server";

import { completeTask } from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/** POST { outcome: "sent" | "skipped" } */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const outcome = body.outcome === "skipped" ? "skipped" : "sent";
    const result = await completeTask(client, id, {
      outcome,
      sentByEmail: userEmail,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
