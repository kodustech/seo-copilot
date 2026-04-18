import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { resolveUsername, XApiError } from "@/lib/x-client";

const TARGETS_TABLE = "x_target_accounts";

type TargetRow = {
  id: string;
  user_email: string;
  x_username: string;
  x_user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  enabled: boolean;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function GET(request: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const { data, error } = await client
      .from(TARGETS_TABLE)
      .select(
        "id, user_email, x_username, x_user_id, display_name, avatar_url, enabled, last_synced_at, created_at, updated_at",
      )
      .eq("user_email", userEmail)
      .order("created_at", { ascending: true });

    if (error) throw new Error(error.message);

    const targets = (data as TargetRow[] | null) ?? [];
    return NextResponse.json({
      targets,
      count: targets.length,
      limit: 20,
    });
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
    const rawUsername =
      typeof body?.username === "string" ? body.username : "";
    const username = rawUsername.trim().replace(/^@/, "");

    if (!username) {
      return NextResponse.json(
        { error: "Provide an X username." },
        { status: 400 },
      );
    }

    let xUser;
    try {
      xUser = await resolveUsername(username);
    } catch (err) {
      if (err instanceof XApiError && err.status === 404) {
        return NextResponse.json(
          { error: `User @${username} not found on X.` },
          { status: 404 },
        );
      }
      throw err;
    }

    const { data, error } = await client
      .from(TARGETS_TABLE)
      .insert({
        user_email: userEmail,
        x_username: xUser.username,
        x_user_id: xUser.id,
        display_name: xUser.displayName,
        avatar_url: xUser.avatarUrl,
      })
      .select(
        "id, user_email, x_username, x_user_id, display_name, avatar_url, enabled, last_synced_at, created_at, updated_at",
      )
      .single();

    if (error) {
      if (/Maximum of 20/i.test(error.message)) {
        return NextResponse.json(
          { error: "You already have 20 target accounts. Remove one first." },
          { status: 409 },
        );
      }
      if (error.code === "23505") {
        return NextResponse.json(
          { error: `@${xUser.username} is already in your targets.` },
          { status: 409 },
        );
      }
      throw new Error(error.message);
    }

    return NextResponse.json({ target: data }, { status: 201 });
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
    const id = url.searchParams.get("id");
    if (!id) {
      return NextResponse.json(
        { error: "Missing target id." },
        { status: 400 },
      );
    }

    const { error } = await client
      .from(TARGETS_TABLE)
      .delete()
      .eq("id", id)
      .eq("user_email", userEmail);

    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
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
      return NextResponse.json(
        { error: "Missing target id." },
        { status: 400 },
      );
    }

    const updates: Record<string, unknown> = {};
    if (typeof body?.enabled === "boolean") {
      updates.enabled = body.enabled;
    }

    if (!Object.keys(updates).length) {
      return NextResponse.json(
        { error: "No valid fields to update." },
        { status: 400 },
      );
    }

    const { data, error } = await client
      .from(TARGETS_TABLE)
      .update(updates)
      .eq("id", id)
      .eq("user_email", userEmail)
      .select(
        "id, user_email, x_username, x_user_id, display_name, avatar_url, enabled, last_synced_at, created_at, updated_at",
      )
      .single();

    if (error) throw new Error(error.message);
    return NextResponse.json({ target: data });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  const message = err instanceof Error ? err.message : "Unexpected error.";
  const status =
    err instanceof XApiError
      ? err.status >= 400 && err.status < 500
        ? err.status
        : 502
      : message.toLowerCase().includes("token") ||
          message.toLowerCase().includes("unauthorized")
        ? 401
        : 500;
  return NextResponse.json({ error: message }, { status });
}
