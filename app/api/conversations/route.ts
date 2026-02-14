import { NextResponse } from "next/server";
import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  createConversation,
  listConversationsByEmail,
  generateTitleFromMessage,
} from "@/lib/conversations";

export async function GET(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const conversations = await listConversationsByEmail(client, userEmail);
    return NextResponse.json({ conversations });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const body = await req.json();
    const { title, messages } = body as {
      title?: string;
      messages?: unknown[];
    };

    const finalTitle =
      title || (messages?.length ? generateTitleFromMessage(String((messages[0] as Record<string, unknown>)?.content ?? "")) : undefined);

    const conversation = await createConversation(client, {
      user_email: userEmail,
      title: finalTitle,
      messages: messages as never,
    });

    return NextResponse.json({ conversation }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Unauthorized") || message.includes("token")
        ? 401
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
