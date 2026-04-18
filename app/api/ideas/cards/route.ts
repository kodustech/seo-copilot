import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";

const ALLOWED_STATES = new Set(["saved", "dismissed", "promoted"]);

export async function GET(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );
    const url = new URL(request.url);
    const state = url.searchParams.get("state");

    let query = client
      .from("idea_card_states")
      .select("id, card_key, state, payload, created_at, updated_at")
      .eq("user_email", userEmail)
      .order("updated_at", { ascending: false });

    if (state && ALLOWED_STATES.has(state)) {
      query = query.eq("state", state);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return NextResponse.json({ cards: data ?? [] });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const body = await request.json().catch(() => ({}));
    const cardKey = typeof body?.cardKey === "string" ? body.cardKey : null;
    const state = typeof body?.state === "string" ? body.state : null;
    if (!cardKey || !state || !ALLOWED_STATES.has(state)) {
      return NextResponse.json(
        { error: "Provide cardKey and a valid state (saved|dismissed|promoted)." },
        { status: 400 },
      );
    }

    const { data, error } = await client
      .from("idea_card_states")
      .upsert(
        {
          user_email: userEmail,
          card_key: cardKey,
          state,
          payload: body?.payload ?? null,
        },
        { onConflict: "user_email,card_key" },
      )
      .select("id, card_key, state, payload, created_at, updated_at")
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ card: data });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );
    const url = new URL(request.url);
    const cardKey = url.searchParams.get("cardKey");
    if (!cardKey) {
      return NextResponse.json({ error: "Missing cardKey." }, { status: 400 });
    }

    const { error } = await client
      .from("idea_card_states")
      .delete()
      .eq("user_email", userEmail)
      .eq("card_key", cardKey);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
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
