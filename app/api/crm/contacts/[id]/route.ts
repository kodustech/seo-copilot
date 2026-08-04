import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { ContactNotFoundError, deleteContact, updateContact } from "@/lib/crm";

const TEXT_FIELDS = ["email", "role", "phone", "linkedin"] as const;
const PATCHABLE = ["name", ...TEXT_FIELDS, "isPrimary"];

/**
 * Reads a nullable-string field the caller may omit: absent → undefined (leave
 * the column alone), null or "" → clear it, string → set it. Callers must have
 * rejected other types first, so only an explicit value ever clears a column.
 */
function optionalText(body: Record<string, unknown>, key: string) {
  if (!(key in body)) return undefined;
  return body[key] as string | null;
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

  if (!PATCHABLE.some((k) => k in body)) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }
  if ("name" in body && typeof body.name !== "string") {
    return NextResponse.json({ error: "name must be a string" }, { status: 400 });
  }
  if ("name" in body && !(body.name as string).trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }
  for (const key of TEXT_FIELDS) {
    if (key in body && body[key] !== null && typeof body[key] !== "string") {
      return NextResponse.json(
        { error: `${key} must be a string or null` },
        { status: 400 },
      );
    }
  }
  if ("isPrimary" in body && typeof body.isPrimary !== "boolean") {
    return NextResponse.json(
      { error: "isPrimary must be a boolean" },
      { status: 400 },
    );
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
    if (err instanceof ContactNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
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
