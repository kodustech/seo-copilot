import { NextResponse } from "next/server";

import { setEnrollmentPaused } from "@/lib/outreach/sequences";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = {
  params: Promise<{ id: string; enrollmentId: string }>;
};

/**
 * PATCH — pause or resume one person in a sequence.
 * Body: { status: "paused" | "active", reason?: string }
 */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { enrollmentId } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as {
      status?: string;
      reason?: string;
    };

    if (body.status !== "paused" && body.status !== "active") {
      return NextResponse.json(
        { error: 'status must be "paused" or "active"' },
        { status: 400 },
      );
    }

    const enrollment = await setEnrollmentPaused(
      client,
      enrollmentId,
      body.status === "paused",
      { reason: body.reason ?? null },
    );

    return NextResponse.json({ enrollment });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = /not found/i.test(message)
      ? 404
      : /cannot pause/i.test(message)
        ? 400
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
