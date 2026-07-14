import { NextResponse } from "next/server";

import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";
import { discoverAndWatch } from "@/lib/icp/discovery";
import { scanWatchlist } from "@/lib/icp/scanner";

export const maxDuration = 300;

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

  try {
    // Writes go through the service client (same posture as the agent tools):
    // discovery + scan touch watchlist, signals and crm_companies.
    const client = getSupabaseServiceClient();
    const { discovered, added } = await discoverAndWatch(client, {
      addedByEmail: userEmail,
    });

    let scan: { companiesScanned: number; newSignals: number } | null = null;
    if (added.length > 0) {
      const results = await scanWatchlist(client);
      scan = {
        companiesScanned: results.length,
        newSignals: results.reduce((n, r) => n + r.newSignals.length, 0),
      };
    }

    return NextResponse.json({
      discovered: discovered.length,
      added: added.length,
      scan,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Discovery failed" },
      { status: 500 },
    );
  }
}
