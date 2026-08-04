import { NextResponse } from "next/server";

import { fetchOutboundMetrics } from "@/lib/outreach/metrics";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const runtime = "nodejs";

const DEFAULT_DAYS = 30;
const MAX_DAYS = 365;

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
  // Number(null) is 0, and 0 is finite — reading the param straight into
  // Number would clamp an absent `days` to a 1-day window instead of the
  // documented default, quietly reporting outbound as near-dead.
  // Blank counts as absent too: Number("") is also 0.
  const rawParam = url.searchParams.get("days");
  const rawDays =
    rawParam === null || rawParam.trim() === "" ? NaN : Number(rawParam);
  const days = Number.isFinite(rawDays)
    ? Math.min(Math.max(Math.trunc(rawDays), 1), MAX_DAYS)
    : DEFAULT_DAYS;
  const sequenceId = url.searchParams.get("sequenceId");

  const until = new Date();
  const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    const metrics = await fetchOutboundMetrics(client, {
      since,
      until,
      sequenceId: sequenceId && sequenceId !== "all" ? sequenceId : null,
    });
    return NextResponse.json({ days, metrics });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    // The RPC ships in a migration; a missing function means it has not been
    // applied yet, which is a setup problem and not a server fault.
    const missing = /function|does not exist|PGRST202|42883/i.test(message);
    return NextResponse.json(
      {
        error: missing
          ? "outbound_metrics RPC not found — apply migration 20260805000000_outbound_metrics.sql"
          : message,
      },
      { status: missing ? 501 : 500 },
    );
  }
}
