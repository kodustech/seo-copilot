import { NextResponse } from "next/server";

import {
  importDomains,
  importFromCrm,
  importFromStrongSignals,
  importFromWatchlist,
} from "@/lib/research/import-sources";
import { getSupabaseUserClient } from "@/lib/supabase-server";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { client } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const source = body.source as string;

    let result: { added: number; skipped: number };

    switch (source) {
      case "watchlist":
        result = await importFromWatchlist(client, id);
        break;
      case "icp_signals":
        result = await importFromStrongSignals(client, id);
        break;
      case "crm":
        result = await importFromCrm(client, id);
        break;
      case "domains":
        if (!Array.isArray(body.domains)) {
          return NextResponse.json(
            { error: "domains[] required" },
            { status: 400 },
          );
        }
        result = await importDomains(
          client,
          id,
          body.domains.map((d: string | { domain: string; companyName?: string }) =>
            typeof d === "string"
              ? { domain: d }
              : { domain: d.domain, companyName: d.companyName },
          ),
        );
        break;
      default:
        return NextResponse.json(
          {
            error:
              "source must be watchlist | icp_signals | crm | domains",
          },
          { status: 400 },
        );
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
