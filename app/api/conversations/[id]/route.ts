import { NextResponse } from "next/server";
import { getSupabaseUserClient } from "@/lib/supabase-server";
import {
  getConversationById,
  updateConversationMessages,
  deleteConversation,
} from "@/lib/conversations";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const conversation = await getConversationById(client, id, userEmail);
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ conversation });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    const { messages, title } = (await req.json()) as {
      messages?: unknown[];
      title?: string;
    };

    if (!messages) {
      return NextResponse.json(
        { error: "Missing required field: messages" },
        { status: 400 },
      );
    }

    await updateConversationMessages(
      client,
      id,
      userEmail,
      messages as never,
      title,
    );

    return NextResponse.json({ updated: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Internal error";
    const status =
      message.includes("Unauthorized") || message.includes("token")
        ? 401
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );

    await deleteConversation(client, id, userEmail);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
