import { NextResponse } from "next/server";

import {
  deleteResearchRows,
  getRow,
  listEvidence,
  listPeople,
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
    const row = await getRow(client, id);
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const [evidence, people] = await Promise.all([
      listEvidence(client, id),
      listPeople(client, id),
    ]);
    return NextResponse.json({ row, evidence, people });
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
    const result = await deleteResearchRows(client, [id]);
    if (result.deleted === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
