// ---------------------------------------------------------------------------
// Repair AI column cells that stored a boolean instead of the real answer.
//
// runAiFieldCell used to prefer result.booleanAnswer over result.answer without
// consulting the column's declared type. The model fills `boolean` in on open
// questions too ("did I find the domain? yes" → true), so every AI-enriched
// text column ended up holding true/false: useless for filtering, sorting and
// export. Filtering for "unknown" in the UI matched nothing, because the stored
// value was `false`.
//
// No LLM is re-run. runAiColumn already wrote the correct string to
// research_rows.pack_raw.ai_columns[<prompt truncated to 120 chars>].answer
// before returning, and that write was never affected by the bug — so the fix
// is a lookup and a value swap. Re-enriching instead would cost ~15s and one
// LLM call per cell to reproduce data we already have.
//
// Only `value` changes. evidence, sources, status and updatedAt are left
// exactly as they were — the evidence is the part that was always correct.
//
// Dry run by default. --apply is the only thing that writes.
//
//   npx tsx scripts/backfill-ai-column-boolean-cells.ts
//   npx tsx scripts/backfill-ai-column-boolean-cells.ts --table outbound-cold-thesis-2026-q3-brazil
//   npx tsx scripts/backfill-ai-column-boolean-cells.ts --apply
//
// Flags:
//   --table <slug>   restrict to one table (default: every table)
//   --apply          take a snapshot, then write the repaired values
//   --no-snapshot    skip the pre-write snapshot (not recommended)
// ---------------------------------------------------------------------------

import { pathToFileURL } from "node:url";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

import type { ResearchCell, ResearchColumn } from "@/lib/research/types";

config({ path: ".env" });

type Args = {
  tableSlug: string | null;
  apply: boolean;
  snapshot: boolean;
};

export function parseArgs(argv: string[]): Args {
  const out: Args = { tableSlug: null, apply: false, snapshot: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--no-snapshot") out.snapshot = false;
    else if (a === "--table") {
      // Without this, a trailing `--table` silently becomes "every table" —
      // so `--apply --table` would repair the whole database instead of
      // failing. A scoping flag has to mean scoping or nothing.
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--table requires a slug argument");
      }
      out.tableSlug = value;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return out;
}

function getClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env",
    );
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** The pack_raw.ai_columns key runAiColumn writes under. */
function packKey(prompt: string): string {
  return prompt.slice(0, 120);
}

/**
 * Whether a snapshot failure is the "one request carrying the whole table was
 * too big" kind — the only kind --no-snapshot is a legitimate answer to.
 */
export function looksLikeSizeLimit(message: string): boolean {
  return /too large|entity too large|payload|body size|413|exceeds|out of memory|heap/i.test(
    message,
  );
}

export type Repair = {
  rowId: string;
  company: string;
  columnKey: string;
  from: boolean;
  to: string;
};

export type Unrepairable = {
  rowId: string;
  company: string;
  columnKey: string;
  value: boolean;
  reason: string;
};

export type RowInput = {
  id: string;
  company_name: string | null;
  cells: Record<string, ResearchCell> | null;
  pack_raw: Record<string, unknown> | null;
};

/** AI columns that could have hit the bug — boolean ones were always correct. */
export function targetColumns(columns: ResearchColumn[]): ResearchColumn[] {
  return columns.filter((c) => c.enrich?.kind === "ai" && c.type !== "boolean");
}

/**
 * Decide what to repair, without touching a database.
 *
 * The whole risk of this backfill is picking the wrong cells, so the choice
 * lives here where it can be tested against fixtures rather than against
 * production rows.
 */
export function planRowRepairs(
  target: ResearchColumn[],
  row: RowInput,
): {
  repairs: Repair[];
  unrepairable: Unrepairable[];
  cells: Record<string, ResearchCell> | null;
} {
  const cells = row.cells ?? {};
  const packRaw = row.pack_raw ?? {};
  const aiStore =
    (packRaw.ai_columns as Record<string, { answer?: unknown }> | undefined) ??
    {};
  const company = row.company_name ?? "(unnamed)";
  const repairs: Repair[] = [];
  const unrepairable: Unrepairable[] = [];
  let next: Record<string, ResearchCell> | null = null;

  for (const column of target) {
    const cell = cells[column.key];
    // Only a boolean sitting in a non-boolean column is the bug.
    if (!cell || typeof cell.value !== "boolean") continue;

    const prompt = column.enrich.kind === "ai" ? column.enrich.prompt : "";
    const stored = aiStore[packKey(prompt)];
    const answer = stored?.answer;

    if (typeof answer !== "string" || !answer.trim()) {
      unrepairable.push({
        rowId: row.id,
        company,
        columnKey: column.key,
        value: cell.value,
        reason: stored
          ? "pack_raw entry has no string answer"
          : "no pack_raw.ai_columns entry for this prompt",
      });
      continue;
    }

    // Only the cells this backfill actually changes. Carrying the whole
    // `cells` object forward to the write would mean writing back every
    // other column exactly as it looked at scan time, reverting anything
    // edited in between.
    next = next ?? {};
    // Swap the value only. evidence/sources/status were never wrong.
    next[column.key] = { ...cell, value: answer.trim() };
    repairs.push({
      rowId: row.id,
      company,
      columnKey: column.key,
      from: cell.value,
      to: answer.trim(),
    });
  }

  return { repairs, unrepairable, cells: next };
}

export function planRepairs(
  columns: ResearchColumn[],
  rows: RowInput[],
): {
  repairs: Repair[];
  unrepairable: Unrepairable[];
  pending: Map<string, Record<string, ResearchCell>>;
} {
  const target = targetColumns(columns);
  const repairs: Repair[] = [];
  const unrepairable: Unrepairable[] = [];
  const pending = new Map<string, Record<string, ResearchCell>>();

  for (const row of rows) {
    const r = planRowRepairs(target, row);
    repairs.push(...r.repairs);
    unrepairable.push(...r.unrepairable);
    if (r.cells) pending.set(row.id, r.cells);
  }

  return { repairs, unrepairable, pending };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const client = getClient();

  let q = client.from("research_tables").select("id, name, slug, columns");
  if (args.tableSlug) q = q.eq("slug", args.tableSlug.toLowerCase());
  const { data: tables, error: tablesError } = await q;
  if (tablesError) throw new Error(`Failed to list tables: ${tablesError.message}`);
  if (!tables?.length) {
    console.log(
      args.tableSlug ? `No table with slug "${args.tableSlug}".` : "No tables.",
    );
    return;
  }

  console.log(
    `${args.apply ? "APPLY" : "DRY RUN"} — scanning ${tables.length} table(s)\n`,
  );

  let totalRepairs = 0;
  let totalUnrepairable = 0;
  let totalBooleanColumnsSkipped = 0;
  let totalSkippedTables = 0;

  for (const table of tables) {
    const columns = (table.columns as ResearchColumn[] | null) ?? [];
    const aiColumns = columns.filter((c) => c.enrich?.kind === "ai");
    const target = targetColumns(columns);
    totalBooleanColumnsSkipped += aiColumns.length - target.length;
    if (target.length === 0) continue;

    // Keyset-paginated, and each page is planned and dropped rather than
    // accumulated. Offset paging would skip exactly one row per boundary
    // whenever a row is deleted mid-scan — the silent partial scan this loop
    // exists to prevent — and holding every row would grow memory with the
    // table, including its pack_raw blobs, on precisely the tables that need
    // paging in the first place.
    const repairs: Repair[] = [];
    const unrepairable: Unrepairable[] = [];
    const pending = new Map<string, Record<string, ResearchCell>>();
    let scanned = 0;
    let lastId: string | null = null;
    for (;;) {
      let q = client
        .from("research_rows")
        .select("id, company_name, cells, pack_raw")
        .eq("table_id", table.id as string)
        .order("id", { ascending: true })
        .limit(1000);
      if (lastId) q = q.gt("id", lastId);
      const { data, error } = await q;
      if (error) {
        throw new Error(`Failed to read rows for ${table.slug}: ${error.message}`);
      }
      const page = (data ?? []) as RowInput[];
      if (page.length === 0) break;
      scanned += page.length;
      for (const row of page) {
        const r = planRowRepairs(target, row);
        repairs.push(...r.repairs);
        unrepairable.push(...r.unrepairable);
        if (r.cells) pending.set(row.id, r.cells);
      }
      if (page.length < 1000) break;
      lastId = page[page.length - 1].id;
    }

    if (repairs.length === 0 && unrepairable.length === 0) continue;

    console.log(`── ${table.name} (${table.slug}) ──`);
    console.log(
      `   scanned ${scanned} row(s); ${repairs.length} cell(s) repairable across ${pending.size} row(s), ${unrepairable.length} not`,
    );
    for (const r of repairs.slice(0, 12)) {
      console.log(
        `   ${r.columnKey.padEnd(20)} ${r.company.slice(0, 24).padEnd(26)} ${r.from} → "${r.to.slice(0, 60)}"`,
      );
    }
    if (repairs.length > 12) console.log(`   … ${repairs.length - 12} more`);
    for (const u of unrepairable.slice(0, 8)) {
      console.log(
        `   SKIP ${u.columnKey.padEnd(18)} ${u.company.slice(0, 24).padEnd(26)} ${u.value} — ${u.reason}`,
      );
    }
    if (unrepairable.length > 8) {
      console.log(`   … ${unrepairable.length - 8} more skipped`);
    }

    // A cell whose answer is literally "true"/"false" is the model's own text,
    // not the bug — worth flagging so it is not read as a failed repair.
    const literal = repairs.filter((r) => /^(true|false)$/i.test(r.to));
    if (literal.length) {
      console.log(
        `   note: ${literal.length} repaired value(s) are the string "true"/"false" — that is what the model answered`,
      );
    }

    if (args.apply && pending.size > 0) {
      if (args.snapshot) {
        try {
          const { snapshotResearchTable } = await import(
            "@/lib/research/tables"
          );
          const snapshotId = await snapshotResearchTable(
            client,
            table.id as string,
            { reason: "backfill_ai_column_boolean_cells" },
          );
          console.log(`   snapshot ${snapshotId}`);
        } catch (err) {
          // The snapshot is the only way back from this write. Failing to
          // take one is a reason to leave this table alone — not to repair it
          // unprotected, and not to abandon the tables after it either. A
          // snapshot is one request carrying the whole table, so a large
          // enough table can exceed the request body limit; that surfaces
          // here rather than halfway through the repair.
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`   SKIPPED — snapshot failed: ${msg}`);
          // Only recommend dropping the safety net when the cause is the one
          // it cannot do anything about. For an auth error, schema drift or a
          // transient fault, "run it again without the rollback path" is bad
          // advice: it trades away the only way back for a reason that had
          // nothing to do with the snapshot being too big.
          if (looksLikeSizeLimit(msg)) {
            console.log(
              `   ${scanned} row(s) scanned — that payload looks too large for one request.`,
            );
            console.log(
              `   Narrow the scope, or re-run with --no-snapshot to repair it with no way back.`,
            );
          } else {
            console.log(
              `   This does not look like a size limit. Fix the cause and re-run with the snapshot on.`,
            );
          }
          console.log();
          totalSkippedTables += 1;
          continue;
        }
      }
      let written = 0;
      let skippedAlreadyFixed = 0;
      let conflicted = 0;
      for (const rowId of pending.keys()) {
        // Re-read, recompute and write under an optimistic lock, retrying on
        // conflict. Re-reading alone only narrows the window where a
        // concurrent setCell gets clobbered; guarding the update on the
        // updated_at we observed closes it, because any write that lands in
        // between moves that timestamp and our update then matches no row.
        let outcome: "written" | "skipped" | "conflict" = "conflict";
        for (let attempt = 0; attempt < 4; attempt++) {
          const { data: fresh, error: readError } = await client
            .from("research_rows")
            .select("id, company_name, cells, pack_raw, updated_at")
            .eq("id", rowId)
            .maybeSingle();
          if (readError) {
            throw new Error(`Failed to re-read row ${rowId}: ${readError.message}`);
          }
          if (!fresh) {
            outcome = "skipped"; // deleted since the scan
            break;
          }

          // Recompute from the row as it is now rather than replaying the
          // scan-time answer: whatever is in pack_raw today is the truth we
          // are copying from.
          const replan = planRowRepairs(target, fresh as RowInput);
          if (!replan.cells) {
            outcome = "skipped"; // already fixed, by hand or by a re-run
            break;
          }
          const merged = {
            ...((fresh.cells as Record<string, ResearchCell> | null) ?? {}),
            ...replan.cells,
          };

          const { data: updated, error } = await client
            .from("research_rows")
            .update({ cells: merged, updated_at: new Date().toISOString() })
            .eq("id", rowId)
            .eq("updated_at", fresh.updated_at as string)
            .select("id");
          if (error) {
            throw new Error(`Failed to write row ${rowId}: ${error.message}`);
          }
          if (updated && updated.length > 0) {
            outcome = "written";
            break;
          }
          // Someone wrote first. Loop and rebuild on their version.
        }
        if (outcome === "written") written += 1;
        else if (outcome === "skipped") skippedAlreadyFixed += 1;
        else conflicted += 1;
      }
      console.log(`   wrote ${written} row(s)`);
      if (skippedAlreadyFixed > 0) {
        console.log(
          `   skipped ${skippedAlreadyFixed} row(s) already fixed or deleted since the scan`,
        );
      }
      if (conflicted > 0) {
        console.log(
          `   WARNING: ${conflicted} row(s) lost the write race 4x and were left alone — re-run to pick them up`,
        );
      }
    }
    console.log();

    totalRepairs += repairs.length;
    totalUnrepairable += unrepairable.length;
  }

  console.log("─".repeat(60));
  console.log(
    `${args.apply ? "Repaired" : "Would repair"} ${totalRepairs} cell(s); ${totalUnrepairable} could not be repaired from pack_raw.`,
  );
  if (totalBooleanColumnsSkipped > 0) {
    console.log(
      `Left ${totalBooleanColumnsSkipped} genuinely-boolean AI column(s) untouched.`,
    );
  }
  if (!args.apply && totalRepairs > 0) {
    console.log("Re-run with --apply to write.");
  }
  if (totalUnrepairable > 0) {
    console.log(
      "Unrepairable cells need the enrichment re-run — pack_raw has no answer to copy.",
    );
  }
  if (totalSkippedTables > 0) {
    console.log(
      `${totalSkippedTables} table(s) left untouched because their safety snapshot could not be taken.`,
    );
    // Non-zero, or a run where every snapshot failed and nothing was repaired
    // reports success to whoever called it. Set the code rather than exiting
    // so the summary above still flushes.
    process.exitCode = 1;
  }
}

// Only run when invoked directly — planRepairs is imported by its test.
const invokedDirectly =
  Boolean(process.argv[1]) &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
