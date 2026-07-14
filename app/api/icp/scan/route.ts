import { NextResponse } from "next/server";

import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";
import { scanWatchlist } from "@/lib/icp/scanner";

export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    await getSupabaseUserClient(req.headers.get("authorization"));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const results = await scanWatchlist(getSupabaseServiceClient());
    return NextResponse.json({
      companiesScanned: results.length,
      newSignals: results.reduce((n, r) => n + r.newSignals.length, 0),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Scan failed" },
      { status: 500 },
    );
  }
}
