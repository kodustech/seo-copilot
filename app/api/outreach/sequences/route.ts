import { NextResponse } from "next/server";

import { getDefaultMailbox } from "@/lib/outreach/mailbox";
import {
  createSequence,
  listSequences,
} from "@/lib/outreach/sequences";
import {
  getSupabaseServiceClient,
  getSupabaseUserClient,
} from "@/lib/supabase-server";

export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const sequences = await listSequences(client);
    let mailboxConfigured = false;
    try {
      const box = await getDefaultMailbox(getSupabaseServiceClient());
      mailboxConfigured = Boolean(box?.enabled && box.hasPassword);
    } catch {
      mailboxConfigured = false;
    }
    return NextResponse.json({ sequences, mailboxConfigured });
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
    const body = await req.json().catch(() => ({}));
    const name = typeof body.name === "string" ? body.name : "";
    if (!name.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const result = await createSequence(client, {
      name,
      description: body.description ?? null,
      createdByEmail: userEmail,
      defaultFromEmail: body.defaultFromEmail ?? null,
      steps: Array.isArray(body.steps) ? body.steps : undefined,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
