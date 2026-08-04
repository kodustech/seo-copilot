import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { deleteContact, updateContact } from "@/lib/crm";

/** Reads an optional nullable-string field: absent → undefined (leave alone). */
function optionalText(body: Record<string, unknown>, key: string) {
  if (!(key in body)) return undefined;
  const v = body[key];
  return typeof v === "string" ? v : null;
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  if ("name" in body && typeof body.name !== "string") {
    return NextResponse.json({ error: "name must be a string" }, { status: 400 });
  }
  if ("name" in body && !(body.name as string).trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const contact = await updateContact(client, id, {
      name: typeof body.name === "string" ? body.name : undefined,
      email: optionalText(body, "email"),
      role: optionalText(body, "role"),
      phone: optionalText(body, "phone"),
      linkedin: optionalText(body, "linkedin"),
      isPrimary:
        typeof body.isPrimary === "boolean" ? body.isPrimary : undefined,
    });
    return NextResponse.json({ contact });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to update" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
  try {
    await deleteContact(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to delete" },
      { status: 500 },
    );
  }
}
