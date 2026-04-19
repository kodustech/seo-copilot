import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

const CANDIDATE_COLUMNS =
  "id, target_account_id, x_post_id, post_url, post_text, post_created_at, author_username, author_display_name, author_avatar_url, metrics, engagement_score, status, snoozed_until, user_hint, fetched_at";

const ALLOWED_STATUSES = new Set([
  "new",
  "drafted",
  "dismissed",
  "replied",
  "snoozed",
]);

export async function GET(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);
    const targetId = url.searchParams.get("target");

    let query = client
      .from("x_reply_candidates")
      .select(
        `${CANDIDATE_COLUMNS}, x_reply_drafts (id, position, angle, draft_text, selected)`,
      )
      .eq("user_email", userEmail)
      .order("engagement_score", { ascending: false })
      .range(offset, offset + limit - 1);

    if (statusParam) {
      const statuses = statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => ALLOWED_STATUSES.has(s));
      if (statuses.length) {
        query = query.in("status", statuses);
      }
    } else {
      query = query.in("status", ["new", "drafted"]);
    }

    if (targetId) {
      query = query.eq("target_account_id", targetId);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ candidates: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const body = await request.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : null;
    if (!id) {
      return NextResponse.json({ error: "Missing candidate id." }, { status: 400 });
    }

    const updates: Record<string, unknown> = {};
    if (typeof body?.status === "string" && ALLOWED_STATUSES.has(body.status)) {
      updates.status = body.status;
    }
    if (typeof body?.snoozedUntil === "string") {
      updates.snoozed_until = body.snoozedUntil;
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json(
        { error: "No valid fields to update." },
        { status: 400 },
      );
    }

    const { data, error } = await client
      .from("x_reply_candidates")
      .update(updates)
      .eq("id", id)
      .eq("user_email", userEmail)
      .select(CANDIDATE_COLUMNS)
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ candidate: data });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error.";
  const status =
    message.toLowerCase().includes("token") ||
    message.toLowerCase().includes("unauthorized")
      ? 401
      : 500;
  return NextResponse.json({ error: message }, { status });
}
