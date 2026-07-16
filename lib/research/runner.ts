// In-memory background runner for research jobs (same single-replica
// assumption as ICP runner / cron leader).

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  createRun,
  finishRun,
  getLatestRun,
  getRun,
  listRows,
} from "@/lib/research/tables";

export type ResearchJobKind =
  | "find"
  | "research"
  | "people"
  | "full"
  | "ai_column";

export type ResearchJobState = {
  running: boolean;
  runId: string | null;
  kind: ResearchJobKind | null;
  tableId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastSummary: string | null;
  lastError: string | null;
};

const state: ResearchJobState = {
  running: false,
  runId: null,
  kind: null,
  tableId: null,
  startedAt: null,
  finishedAt: null,
  lastSummary: null,
  lastError: null,
};

export function getResearchJobState(): ResearchJobState {
  return { ...state };
}

export async function getResearchStatus(tableId?: string) {
  const mem = getResearchJobState();
  if (!tableId) return mem;
  try {
    const client = getSupabaseServiceClient();
    const latest = await getLatestRun(client, tableId);
    return {
      ...mem,
      latestRun: latest,
    };
  } catch {
    return mem;
  }
}

export function startResearchJob(
  kind: ResearchJobKind,
  opts: {
    tableId: string;
    rowIds?: string[];
    userEmail?: string | null;
    force?: boolean;
    onlyIfPass?: boolean;
    aiPrompt?: string;
    enrichPeople?: boolean;
    /** Find-ICP options (kind === "find") */
    market?: "global" | "brazil";
    size?: "any" | "small" | "mid" | "large";
    maxCompanies?: number;
    focus?: string | null;
    researchAfterFind?: boolean;
  },
): boolean {
  if (state.running) return false;

  state.running = true;
  state.kind = kind;
  state.tableId = opts.tableId;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;
  state.lastSummary = null;
  state.runId = null;

  void (async () => {
    const client = getSupabaseServiceClient();
    let runId: string | null = null;
    try {
      const run = await createRun(client, {
        tableId: opts.tableId,
        kind,
        createdBy: opts.userEmail ?? null,
      });
      runId = run.id;
      state.runId = run.id;

      if (kind === "find") {
        const { findIcpCompanies, matchesSizeBand, engOpeningsFromPackRaw } =
          await import("@/lib/research/find");
        state.lastSummary = "Finding companies…";
        const found = await findIcpCompanies(client, {
          tableId: opts.tableId,
          market: opts.market ?? "global",
          size: opts.size ?? "mid",
          maxCompanies: opts.maxCompanies ?? 12,
          focus: opts.focus ?? null,
        });

        let researchSummary: {
          ok: number;
          failed: number;
          passed: number;
          sizeMatched: number;
        } | null = null;

        if (opts.researchAfterFind !== false && found.rowIds.length > 0) {
          state.lastSummary = `Found ${found.added} companies — researching…`;
          const { researchRows } = await import(
            "@/lib/research/research-company"
          );
          const { getRow } = await import("@/lib/research/tables");
          const result = await researchRows(client, found.rowIds, {
            concurrency: 2,
          });

          // Soft size filter for reporting (rows stay; UI can filter).
          let sizeMatched = 0;
          for (const r of result.results) {
            const full = await getRow(client, r.rowId);
            const eng = engOpeningsFromPackRaw(full?.packRaw);
            if (matchesSizeBand(opts.size ?? "mid", eng)) sizeMatched += 1;
          }

          researchSummary = {
            ok: result.ok,
            failed: result.failed,
            passed: result.results.filter((x) => x.score.pass).length,
            sizeMatched,
          };
        }

        const summary = {
          discovered: found.discovered,
          added: found.added,
          skipped: found.skipped,
          market: found.market,
          size: found.size,
          research: researchSummary,
        };
        await finishRun(client, run.id, { status: "done", summary });
        state.lastSummary = researchSummary
          ? `Found ${found.added} (${found.market}). Researched ${researchSummary.ok}: ${researchSummary.passed} passed ICP` +
            (opts.size && opts.size !== "any"
              ? `; ${researchSummary.sizeMatched} match size “${opts.size}”`
              : "")
          : `Found ${found.added} companies (${found.market}) — run research next`;
      } else {
      let rowIds = opts.rowIds;
      if (!rowIds || rowIds.length === 0) {
        const rows = await listRows(client, opts.tableId);
        rowIds = rows
          .filter((r) =>
            kind === "people" || kind === "full"
              ? true
              : r.status !== "researched" || opts.force,
          )
          .map((r) => r.id);
        // For research/full default: all pending/failed, or all if force.
        if (kind === "research" || kind === "full") {
          if (!opts.force) {
            rowIds = rows
              .filter((r) => r.status === "pending" || r.status === "failed")
              .map((r) => r.id);
            if (rowIds.length === 0) {
              // If everything researched, re-run all when explicitly empty selection
              // and no force — research only pending. OK to no-op.
            }
          } else {
            rowIds = rows.map((r) => r.id);
          }
        }
        if (kind === "people") {
          rowIds = rows
            .filter((r) => (opts.onlyIfPass === false ? true : r.pass === true))
            .map((r) => r.id);
        }
      }

      if (kind === "research" || kind === "full") {
        const { researchRows } = await import(
          "@/lib/research/research-company"
        );
        const result = await researchRows(client, rowIds, {
          force: opts.force,
          concurrency: 2,
        });

        let peopleSummary = null as null | {
          ok: number;
          failed: number;
          totalPeople: number;
        };
        if (kind === "full" || opts.enrichPeople) {
          const { enrichPeopleForRows } = await import(
            "@/lib/research/waterfall"
          );
          const passIds = result.results
            .filter((r) => r.score.pass)
            .map((r) => r.rowId);
          peopleSummary = await enrichPeopleForRows(client, passIds, {
            onlyIfPass: true,
          });
        }

        const summary = {
          researched_ok: result.ok,
          researched_failed: result.failed,
          people: peopleSummary,
          passed: result.results.filter((r) => r.score.pass).length,
        };
        await finishRun(client, run.id, { status: "done", summary });
        state.lastSummary = `Researched ${result.ok} ok / ${result.failed} failed; ${summary.passed} passed ICP`;
      } else if (kind === "people") {
        const { enrichPeopleForRows } = await import(
          "@/lib/research/waterfall"
        );
        const result = await enrichPeopleForRows(client, rowIds, {
          onlyIfPass: opts.onlyIfPass !== false,
        });
        const summary = { ...result };
        await finishRun(client, run.id, { status: "done", summary });
        state.lastSummary = `People enriched on ${result.ok} rows (${result.totalPeople} people)`;
      } else if (kind === "ai_column") {
        if (!opts.aiPrompt) throw new Error("aiPrompt required");
        const { runAiColumn } = await import("@/lib/research/ai-column");
        let ok = 0;
        let failed = 0;
        for (const id of rowIds) {
          try {
            await runAiColumn(client, id, opts.aiPrompt);
            ok += 1;
          } catch {
            failed += 1;
          }
        }
        await finishRun(client, run.id, {
          status: "done",
          summary: { ok, failed, prompt: opts.aiPrompt },
        });
        state.lastSummary = `AI column on ${ok} rows (${failed} failed)`;
      }
      } // end non-find kinds

      state.lastError = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "research job failed";
      console.error("[research-runner] failed:", err);
      state.lastError = message;
      state.lastSummary = null;
      if (runId) {
        try {
          await finishRun(client, runId, {
            status: "failed",
            lastError: message,
          });
        } catch {
          // ignore
        }
      }
    } finally {
      state.running = false;
      state.finishedAt = new Date().toISOString();
    }
  })();

  return true;
}

export async function getRunById(runId: string) {
  const client = getSupabaseServiceClient();
  return getRun(client, runId);
}
