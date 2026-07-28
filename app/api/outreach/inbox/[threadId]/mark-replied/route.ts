import { NextResponse } from "next/server";

import { markThreadEnrollmentReplied } from "@/lib/outreach/inbox";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ threadId: string }> };

/**
 * POST — manually mark linked enrollment as replied + cancel pending tasks.
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { threadId } = await ctx.params;
    const result = await markThreadEnrollmentReplied(client, threadId);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = /not found/i.test(message) ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
