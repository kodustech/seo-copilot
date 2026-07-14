// In-memory background runner for the ICP pipeline. Discovery + scan take
// minutes (dozens of board fetches + LLM classification), far past what a
// browser request survives through the proxy, so the API routes kick the work
// off here and return immediately; the UI polls job state. Single-replica
// assumption (same as the cron leader).

import { getSupabaseServiceClient } from "@/lib/supabase-server";

export type IcpJobKind = "discover" | "scan";

export type IcpJobState = {
  running: IcpJobKind | null;
  startedAt: string | null;
  finishedAt: string | null;
  lastKind: IcpJobKind | null;
  lastSummary: string | null;
  lastError: string | null;
};

const state: IcpJobState = {
  running: null,
  startedAt: null,
  finishedAt: null,
  lastKind: null,
  lastSummary: null,
  lastError: null,
};

export function getIcpJobState(): IcpJobState {
  return { ...state };
}

function finish(kind: IcpJobKind, summary: string | null, error: string | null) {
  state.running = null;
  state.finishedAt = new Date().toISOString();
  state.lastKind = kind;
  state.lastSummary = summary;
  state.lastError = error;
}

// Returns false when a job is already in flight.
export function startIcpJob(
  kind: IcpJobKind,
  opts: { userEmail?: string | null; market?: "global" | "brazil" } = {},
): boolean {
  if (state.running) return false;
  state.running = kind;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.lastError = null;

  void (async () => {
    try {
      const client = getSupabaseServiceClient();
      if (kind === "discover") {
        const { discoverAndWatch } = await import("@/lib/icp/discovery");
        const { scanWatchlist } = await import("@/lib/icp/scanner");
        const { discovered, added } = await discoverAndWatch(client, {
          addedByEmail: opts.userEmail ?? null,
          market: opts.market,
        });
        let newSignals = 0;
        if (added.length > 0) {
          const results = await scanWatchlist(client);
          newSignals = results.reduce((n, r) => n + r.newSignals.length, 0);
        }
        finish(
          kind,
          `Discovered ${discovered.length} companies (${added.length} on watchlist), ${newSignals} new signals`,
          null,
        );
      } else {
        const { scanWatchlist } = await import("@/lib/icp/scanner");
        const results = await scanWatchlist(client);
        const newSignals = results.reduce((n, r) => n + r.newSignals.length, 0);
        finish(
          kind,
          `Scanned ${results.length} companies, ${newSignals} new signals`,
          null,
        );
      }
    } catch (err) {
      console.error(`[icp-runner] ${kind} failed:`, err);
      finish(kind, null, err instanceof Error ? err.message : `${kind} failed`);
    }
  })();

  return true;
}
