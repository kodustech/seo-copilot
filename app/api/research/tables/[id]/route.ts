import { NextResponse } from "next/server";

import { deleteTable, getTable, listRows } from "@/lib/research/tables";
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
    return NextResponse.json({ table, rows });
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
