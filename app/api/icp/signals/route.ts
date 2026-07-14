import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { listSignals } from "@/lib/icp/scanner";
import type { SignalStrength } from "@/lib/icp/classify";

export async function GET(req: Request) {
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  try {
    const url = new URL(req.url);
    const strength = url.searchParams.get("strength");
    const days = Number(url.searchParams.get("days")) || undefined;

    const signals = await listSignals(client, {
      strength:
        strength === "strong" || strength === "medium"
          ? (strength as SignalStrength)
          : undefined,
      days,
    });
    return NextResponse.json({ signals });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to list signals" },
      { status: 500 },
    );
  }
}
