import { NextResponse } from "next/server";

import { listRubrics } from "@/lib/research/rubrics";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function GET(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
    return NextResponse.json({ rubrics: listRubrics() });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
