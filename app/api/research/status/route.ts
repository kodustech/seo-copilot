import { NextResponse } from "next/server";

import { getResearchStatus } from "@/lib/research/runner";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    const url = new URL(req.url);
    const tableId = url.searchParams.get("tableId") ?? undefined;
    const status = await getResearchStatus(tableId);
    return NextResponse.json(status);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
