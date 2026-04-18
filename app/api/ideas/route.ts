import { NextResponse } from "next/server";

import {
  getOrGenerateIdeaSession,
  ideaSessionsTableMissingMessage,
} from "@/lib/ideas";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const url = new URL(request.url);
    const topic = url.searchParams.get("topic");

    const session = await getOrGenerateIdeaSession({
      userEmail,
      topic: topic || null,
    });

    return NextResponse.json({ session });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      request.headers.get("authorization"),
    );

    const body = await request.json().catch(() => ({}));
    const topic =
      typeof body?.topic === "string" && body.topic.trim().length > 0
        ? body.topic.trim()
        : null;

    const session = await getOrGenerateIdeaSession({
      userEmail,
      topic,
      forceRefresh: true,
    });

    return NextResponse.json({ session });
  } catch (err) {
    return errorResponse(err);
  }
}

function errorResponse(err: unknown) {
  const missingTables = ideaSessionsTableMissingMessage(err);
  if (missingTables) {
    return NextResponse.json({ error: missingTables }, { status: 500 });
  }
  const message = err instanceof Error ? err.message : "Unexpected error.";
  const status =
    message.toLowerCase().includes("token") ||
    message.toLowerCase().includes("unauthorized")
      ? 401
      : 500;
  return NextResponse.json({ error: message }, { status });
}
