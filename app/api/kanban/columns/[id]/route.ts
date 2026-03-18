import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { updateColumn, deleteColumn, reorderColumns } from "@/lib/kanban";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing column id." }, { status: 400 });
  }

  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const body = await req.json().catch(() => ({}));

    // Batch reorder: { orderedIds: string[] }
    if (Array.isArray(body.orderedIds)) {
      await reorderColumns(client, body.orderedIds);
      return NextResponse.json({ success: true });
    }

    const updates: { name?: string; position?: number } = {};
    if (typeof body.name === "string") updates.name = body.name;
    if (typeof body.position === "number") updates.position = body.position;

    const column = await updateColumn(client, id, updates);
    return NextResponse.json({ column });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Missing column id." }, { status: 400 });
  }

  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    await deleteColumn(client, id);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal error";
    if (message.toLowerCase().includes("token") || message === "Unauthorized") {
      return unauthorized(message);
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
