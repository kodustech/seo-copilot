import { NextResponse } from "next/server";

import { getSupabaseServiceClient, getSupabaseUserClient } from "@/lib/supabase-server";
import {
  getLatestYoloBatch,
  isYoloBatchStale,
  regenerateYoloBatchForUser,
  socialYoloTableMissingMessage,
} from "@/lib/social-yolo";

export const maxDuration = 300;

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const latest = await getLatestYoloBatch(client, userEmail);
    return NextResponse.json({
      batchDate: latest.batchDate,
      generatedAt: latest.generatedAt,
      stale: latest.batchDate ? isYoloBatchStale(latest.batchDate) : true,
      posts: latest.posts,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missingMessage = socialYoloTableMissingMessage(error);
    if (missingMessage) {
      return NextResponse.json({ error: missingMessage }, { status: 500 });
    }
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await safeReadJson(req);
    const force = body.force !== false;

    const client = getSupabaseServiceClient();
    const generated = await regenerateYoloBatchForUser({
      client,
      userEmail,
      force,
    });

    return NextResponse.json(
      {
        batchDate: generated.batchDate,
        stale: false,
        posts: generated.posts,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    const missingMessage = socialYoloTableMissingMessage(error);
    if (missingMessage) {
      return NextResponse.json({ error: missingMessage }, { status: 500 });
    }
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

async function safeReadJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}
