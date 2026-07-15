import { NextResponse } from "next/server";

import {
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
