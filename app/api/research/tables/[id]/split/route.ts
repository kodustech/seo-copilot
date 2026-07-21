import { NextResponse } from "next/server";

import {
  moveRowsToTable,
  splitTableByRules,
  type RowCondition,
  type SplitRule,
} from "@/lib/research/split";
import { getSupabaseUserClient } from "@/lib/supabase-server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * Horizontal list ops on a research table.
 *
 * POST body modes:
 * 1) Move selection:
 *    { mode: "move", row_ids: string[], target_table_id? | new_table_name? }
 * 2) Split by rules:
 *    { mode: "rules", rules: SplitRule[], remainder?: "leave"|"new_list",
 *      remainder_name?, dry_run?|confirm? }
 */
export async function POST(req: Request, ctx: Ctx) {
  try {
    const { client, userEmail } = await getSupabaseUserClient(
      req.headers.get("authorization"),
    );
    const { id: sourceTableId } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const mode = String(body.mode ?? "rules");

    if (mode === "move") {
      const rowIds = Array.isArray(body.row_ids)
        ? body.row_ids.map(String)
        : Array.isArray(body.rowIds)
          ? body.rowIds.map(String)
          : [];
      if (rowIds.length === 0) {
        return NextResponse.json(
          { error: "row_ids required for move" },
          { status: 400 },
        );
      }
      const result = await moveRowsToTable(client, {
        rowIds,
        targetTableId:
          typeof body.target_table_id === "string"
            ? body.target_table_id
            : typeof body.targetTableId === "string"
              ? body.targetTableId
              : undefined,
        newTableName:
          typeof body.new_table_name === "string"
            ? body.new_table_name
            : typeof body.newTableName === "string"
              ? body.newTableName
              : undefined,
        sourceTableId,
        createdByEmail: userEmail,
      });
      return NextResponse.json({ ok: true, mode: "move", ...result });
    }

    // rules split
    const rules = (Array.isArray(body.rules) ? body.rules : []) as SplitRule[];
    if (rules.length === 0) {
      return NextResponse.json(
        {
          error:
            "Provide mode=move with row_ids, or mode=rules with rules[]. Example rule condition kinds: domain_suffix, pack_path_eq, cell_eq, min_score, row_ids, …",
        },
        { status: 400 },
      );
    }

    // Normalize conditions if needed
    for (const r of rules) {
      if (!r.name || !Array.isArray(r.conditions)) {
        return NextResponse.json(
          { error: "Each rule needs name + conditions[]" },
          { status: 400 },
        );
      }
      r.conditions = r.conditions as RowCondition[];
    }

    const isDry = !(
      body.confirm === true ||
      body.dry_run === false ||
      body.dryRun === false
    );

    const result = await splitTableByRules(client, sourceTableId, {
      rules,
      remainder:
        body.remainder === "new_list" || body.remainder === "leave"
          ? body.remainder
          : "leave",
      remainderName:
        typeof body.remainder_name === "string"
          ? body.remainder_name
          : typeof body.remainderName === "string"
            ? body.remainderName
            : undefined,
      dryRun: isDry,
      createdByEmail: userEmail,
    });

    return NextResponse.json({ ok: true, mode: "rules", ...result });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed" },
      { status: 400 },
    );
  }
}
