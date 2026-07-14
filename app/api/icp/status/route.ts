import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { getIcpJobState } from "@/lib/icp/runner";

export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
  return NextResponse.json(getIcpJobState());
}
