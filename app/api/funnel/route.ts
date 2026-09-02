import { NextResponse } from "next/server";

import { fetchFunnel } from "@/lib/funnel/metrics";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 120;

function defaultMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

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

  const url = new URL(req.url);
  const raw = url.searchParams.get("month")?.trim();
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : defaultMonth();

  try {
    const funnel = await fetchFunnel(client, month);
    return NextResponse.json({ funnel });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to build funnel" },
      { status: 500 },
    );
  }
}
