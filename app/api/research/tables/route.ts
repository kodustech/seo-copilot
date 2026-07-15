import { NextResponse } from "next/server";

import {
  createTable,
  getDefaultRubricId,
  listRubrics,
  listTables,
} from "@/lib/research/tables";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function GET(req: Request) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const tables = await listTables(client);
    return NextResponse.json({ tables, rubrics: listRubrics() });
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
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const table = await createTable(client, {
      name,
      rubricId: body.rubricId ?? getDefaultRubricId(),
      description: body.description ?? null,
      createdByEmail: userEmail,
    });
    return NextResponse.json({ table }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed";
    const status = message.includes("Unauthorized") || message.includes("token")
      ? 401
      : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
