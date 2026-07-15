import { NextResponse } from "next/server";

import { exportTableCsv } from "@/lib/research/actions";
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
    const url = new URL(req.url);
    const csv = await exportTableCsv(client, id, {
      passOnly: url.searchParams.get("passOnly") === "1",
      minScore: url.searchParams.get("minScore")
        ? Number(url.searchParams.get("minScore"))
        : undefined,
    });
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="research-${id.slice(0, 8)}.csv"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
