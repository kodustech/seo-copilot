import { NextResponse } from "next/server";

import {
  deleteTable,
  getTable,
  listPeopleForRows,
  listRows,
} from "@/lib/research/tables";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const table = await getTable(client, id);
    if (!table) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const url = new URL(req.url);
    const passOnly = url.searchParams.get("passOnly") === "1";
    const minScore = url.searchParams.get("minScore");
    const rows = await listRows(client, id, {
      passOnly,
      minScore: minScore ? Number(minScore) : undefined,
    });
    const peopleMap = await listPeopleForRows(
      client,
      rows.map((r) => r.id),
    );
    // Attach people onto each row for Clay-style grid (serializable).
    const rowsWithPeople = rows.map((r) => ({
      ...r,
      people: peopleMap.get(r.id) ?? [],
    }));
    return NextResponse.json({ table, rows: rowsWithPeople });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    await deleteTable(client, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unauthorized" },
      { status: 401 },
    );
  }
}
