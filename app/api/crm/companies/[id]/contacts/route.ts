import { NextResponse } from "next/server";

import { getSupabaseUserClient } from "@/lib/supabase-server";
import { createContact, listContacts } from "@/lib/crm";

function unauthorized(message = "Unauthorized") {
  return NextResponse.json({ error: message }, { status: 401 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }
  try {
    const contacts = await listContacts(client, id);
    return NextResponse.json({ contacts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load" },
      { status: 500 },
    );
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let client;
  try {
    ({ client } = await getSupabaseUserClient(req.headers.get("authorization")));
  } catch (err) {
    return unauthorized(err instanceof Error ? err.message : "Unauthorized");
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const name = typeof body.name === "string" ? body.name : null;
  if (!name) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  try {
    const contact = await createContact(client, id, {
      name,
      email: typeof body.email === "string" ? body.email : null,
      role: typeof body.role === "string" ? body.role : null,
      phone: typeof body.phone === "string" ? body.phone : null,
      linkedin: typeof body.linkedin === "string" ? body.linkedin : null,
      isPrimary: body.isPrimary === true,
    });
    return NextResponse.json({ contact }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create" },
      { status: 500 },
    );
  }
}
