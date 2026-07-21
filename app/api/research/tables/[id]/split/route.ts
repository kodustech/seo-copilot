import { NextResponse } from "next/server";

import { splitTableByMarket } from "@/lib/research/split";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST body:
 * { dry_run?: boolean (default true), confirm?: true to execute,
 *   brazil_name?, world_name?, unknown_name?, unknown_into_world?: boolean }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));

    // Default dry-run. Execute only when confirm=true or dry_run=false.
    const isDry = !(
      body.confirm === true ||
      body.dry_run === false ||
      body.dryRun === false
    );

    const result = await splitTableByMarket(client, id, {
      dryRun: isDry,
      brazilName:
        typeof body.brazil_name === "string" ? body.brazil_name : undefined,
      worldName:
        typeof body.world_name === "string" ? body.world_name : undefined,
      unknownName:
        typeof body.unknown_name === "string" ? body.unknown_name : undefined,
      unknownIntoWorld: body.unknown_into_world === true,
      createdByEmail: userEmail,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Split failed" },
      { status: 400 },
    );
  }
}
