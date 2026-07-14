import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { startIcpJob } from "@/lib/icp/runner";

export async function POST(req: Request) {
  let userEmail: string | null = null;
  try {
    const auth = await getSupabaseUserClient(req.headers.get("authorization"));
    userEmail = auth.userEmail ?? null;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  // Long-running (minutes): runs in the background, UI polls /api/icp/status.
  const started = startIcpJob("discover", { userEmail });
  if (!started) {
    return NextResponse.json(
      { error: "A discovery or scan is already running" },
      { status: 409 },
    );
  }
  return NextResponse.json({ started: true }, { status: 202 });
}
