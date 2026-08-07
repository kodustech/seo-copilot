/**
 * Repairs AI column cells that stored the model's `boolean` field instead of
 * its text answer.
 *
 * runAiFieldCell used to prefer result.booleanAnswer over result.answer for
 * every column type, so a text column ended up holding true/false while the
 * real answer sat untouched in research_rows.pack_raw.ai_columns[<prompt>]
 * (that write was never affected). This copies the answer back into the cell —
 * no LLM calls, no enrichment re-run.
 *
 * Dry-run by default: prints every repair it would make and writes nothing.
 *   npx tsx --env-file=.env scripts/backfill-ai-column-cells.ts
 *   npx tsx --env-file=.env scripts/backfill-ai-column-cells.ts --table=<slug|id|name>
 *   npx tsx --env-file=.env scripts/backfill-ai-column-cells.ts --apply
 *
 * Only touches cells that are (a) on a non-boolean column with enrich.kind
 * "ai", (b) currently holding a boolean, and (c) backed by a stored answer.
 * Genuine boolean columns and cells with no recoverable answer are left alone
 * and reported.
 */
import { listRows, listTables } from "../lib/research/tables";
import { getSupabaseServiceClient } from "../lib/supabase-server";
import type { ResearchCell, ResearchTable } from "../lib/research/types";

const APPLY = process.argv.includes("--apply");
const TABLE_REF =
  process.argv.find((a) => a.startsWith("--table="))?.slice("--table=".length) ??
  null;

type AiColumnRecord = {
  answer?: unknown;
  boolean?: unknown;
  evidence?: unknown;
  sources?: unknown;
};

/** Key runAiColumn writes pack_raw.ai_columns under. */
function packKey(prompt: string): string {
  return prompt.slice(0, 120);
}

function storedAnswer(
  packRaw: Record<string, unknown>,
  prompt: string,
): string | null {
  const aiColumns = packRaw.ai_columns as
    | Record<string, AiColumnRecord>
    | undefined;
  if (!aiColumns) return null;
  const record = aiColumns[packKey(prompt)];
  const answer = record?.answer;
  if (typeof answer !== "string") return null;
  const trimmed = answer.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function matchesRef(table: ResearchTable, ref: string): boolean {
  const needle = ref.toLowerCase();
  return (
    table.id === ref ||
    table.slug?.toLowerCase() === needle ||
    table.name.toLowerCase() === needle
  );
}

async function main() {
  const client = getSupabaseServiceClient();
  const allTables = await listTables(client);
  const tables = TABLE_REF
    ? allTables.filter((t) => matchesRef(t, TABLE_REF))
    : allTables;

  if (tables.length === 0) {
    console.error(
      TABLE_REF ? `No research list matched "${TABLE_REF}"` : "No research lists found",
    );
    process.exit(1);
  }

  let repaired = 0;
  let unrecoverable = 0;
  let skippedBoolean = 0;

  for (const table of tables) {
    const aiColumns = (table.columns ?? []).filter(
      (c) => c.enrich.kind === "ai",
    );
    if (aiColumns.length === 0) continue;

    const rows = await listRows(client, table.id);
    for (const row of rows) {
      const cells = { ...(row.cells ?? {}) };
      let rowChanged = false;

      for (const column of aiColumns) {
        if (column.enrich.kind !== "ai") continue;
        const cell = cells[column.key] as ResearchCell | undefined;
        if (!cell || typeof cell.value !== "boolean") continue;

        if (column.type === "boolean") {
          skippedBoolean += 1;
          continue;
        }

        const answer = storedAnswer(row.packRaw ?? {}, column.enrich.prompt);
        if (!answer) {
          unrecoverable += 1;
          console.log(
            `  ! ${table.slug ?? table.name} / ${row.companyName} / ${column.key}: ` +
              `cell=${cell.value} but no stored answer — needs a re-run`,
          );
          continue;
        }

        console.log(
          `  ~ ${table.slug ?? table.name} / ${row.companyName} / ${column.key}: ` +
            `${cell.value} -> ${JSON.stringify(answer.slice(0, 80))}`,
        );
        cells[column.key] = { ...cell, value: answer };
        rowChanged = true;
        repaired += 1;
      }

      if (rowChanged && APPLY) {
        const { error } = await client
          .from("research_rows")
          .update({ cells, updated_at: new Date().toISOString() })
          .eq("id", row.id);
        if (error) {
          throw new Error(`Failed to update row ${row.id}: ${error.message}`);
        }
      }
    }
  }

  console.log(
    `\n${APPLY ? "Repaired" : "Would repair"} ${repaired} cell(s). ` +
      `${unrecoverable} without a stored answer, ` +
      `${skippedBoolean} left alone on genuine boolean columns.`,
  );
  if (!APPLY && repaired > 0) console.log("Re-run with --apply to write.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
