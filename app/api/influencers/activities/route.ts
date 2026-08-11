import { NextResponse } from "next/server";

import { withUser } from "@/lib/db";
import { getSupabaseUserClient } from "@/lib/supabase-server";

import { listActivities } from "@/lib/influencer/drizzle/activities";
import {
  influencerTableMissingMessage,
  normalizeActivityStatus,
  type ActivityStatus,
} from "@/lib/influencer/types";

export const maxDuration = 60;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const url = new URL(req.url);
    const personaId = url.searchParams.get("persona_id") ?? undefined;
    const statuses = (url.searchParams.get("status") ?? "")
      .split(",")
      .map((item) => normalizeActivityStatus(item.trim()))
      .filter((item): item is ActivityStatus => item !== null);
    const limit = Number(url.searchParams.get("limit") ?? 100);
    const offset = Number(url.searchParams.get("offset") ?? 0);

    const activities = await withUser({ email: userEmail }, (tx) =>
      listActivities(tx, {
        persona_id: personaId,
        statuses: statuses.length ? statuses : undefined,
        limit: Number.isFinite(limit) ? limit : 100,
        offset: Number.isFinite(offset) ? offset : 0,
      }),
    );

    return NextResponse.json({ activities });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missing = influencerTableMissingMessage(error);
    if (missing) {
      return NextResponse.json({ error: missing }, { status: 500 });
    }
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
