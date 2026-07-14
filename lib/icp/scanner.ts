// ICP signal scanner orchestration: watchlist CRUD, per-company scan (fetch
// board → prefilter → LLM classify → dedupe → store), and CRM feed. Companies
// with at least one strong signal are upserted into crm_companies with the
// signal payload deep-merged into `enrichment`.

import type { SupabaseClient } from "@supabase/supabase-js";

import { upsertCompanyFromWebhook } from "@/lib/crm";
import {
  classifyPostings,
  detectDevHiringNoQa,
  prefilterPostings,
  type PostingSignal,
  type SignalStrength,
  type SignalType,
} from "@/lib/icp/classify";
import {
  detectBoard,
  fetchBoardJobs,
  type AtsProvider,
  ATS_PROVIDERS,
} from "@/lib/icp/job-boards";

export type WatchlistEntry = {
  id: string;
  companyName: string;
  domain: string | null;
  ats: AtsProvider;
  boardSlug: string;
  active: boolean;
  addedByEmail: string | null;
  lastScannedAt: string | null;
  createdAt: string;
};

export type IcpSignal = {
  id: string;
  watchlistId: string;
  companyId: string | null;
  signalType: SignalType;
  strength: SignalStrength;
  title: string;
  url: string;
  evidence: string | null;
  detectedAt: string;
};

export type ScanResult = {
  watchlistId: string;
  companyName: string;
  boardFound: boolean;
  jobCount: number;
  prefilteredCount: number;
  newSignals: PostingSignal[];
  crmCompanyId: string | null;
};

type WatchlistRow = {
  id: string;
  company_name: string;
  domain: string | null;
  ats: string;
  board_slug: string;
  active: boolean;
  added_by_email: string | null;
  last_scanned_at: string | null;
  created_at: string;
};

type SignalRow = {
  id: string;
  watchlist_id: string;
  company_id: string | null;
  signal_type: string;
  strength: string;
  title: string;
  url: string;
  evidence: string | null;
  detected_at: string;
};

function rowToEntry(row: WatchlistRow): WatchlistEntry {
  return {
    id: row.id,
    companyName: row.company_name,
    domain: row.domain,
    ats: row.ats as AtsProvider,
    boardSlug: row.board_slug,
    active: row.active,
    addedByEmail: row.added_by_email,
    lastScannedAt: row.last_scanned_at,
    createdAt: row.created_at,
  };
}

function rowToSignal(row: SignalRow): IcpSignal {
  return {
    id: row.id,
    watchlistId: row.watchlist_id,
    companyId: row.company_id,
    signalType: row.signal_type as SignalType,
    strength: row.strength as SignalStrength,
    title: row.title,
    url: row.url,
    evidence: row.evidence,
    detectedAt: row.detected_at,
  };
}

function normalizeDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "")
    .trim()
    .toLowerCase();
  return cleaned || null;
}

// ---------------------------------------------------------------------------
// Watchlist CRUD
// ---------------------------------------------------------------------------

export async function addToWatchlist(
  client: SupabaseClient,
  input: {
    companyName: string;
    domain?: string | null;
    ats?: AtsProvider | null;
    boardSlug?: string | null;
    addedByEmail?: string | null;
  },
): Promise<{ entry: WatchlistEntry; detected: boolean }> {
  let ats = input.ats ?? null;
  let boardSlug = input.boardSlug ?? null;
  let detected = false;

  if (ats && !ATS_PROVIDERS.includes(ats)) {
    throw new Error(`Unknown ATS "${ats}". Use one of: ${ATS_PROVIDERS.join(", ")}`);
  }

  if (!ats || !boardSlug) {
    const board = await detectBoard({
      companyName: input.companyName,
      domain: input.domain,
    });
    if (!board) {
      throw new Error(
        `No public Greenhouse/Lever/Ashby board found for "${input.companyName}". ` +
          "Pass ats + board_slug explicitly if you know them.",
      );
    }
    ats = board.ats;
    boardSlug = board.slug;
    detected = true;
  }

  const { data, error } = await client
    .from("icp_watchlist")
    .upsert(
      {
        company_name: input.companyName,
        domain: normalizeDomain(input.domain),
        ats,
        board_slug: boardSlug,
        active: true,
        added_by_email: input.addedByEmail ?? null,
      },
      { onConflict: "ats,board_slug", ignoreDuplicates: false },
    )
    .select("*")
    .single();
  if (error) throw new Error(`Failed to add to watchlist: ${error.message}`);
  return { entry: rowToEntry(data as WatchlistRow), detected };
}

export async function listWatchlist(
  client: SupabaseClient,
  opts: { activeOnly?: boolean } = {},
): Promise<WatchlistEntry[]> {
  let query = client.from("icp_watchlist").select("*").order("created_at");
  if (opts.activeOnly) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list watchlist: ${error.message}`);
  return (data ?? []).map((r) => rowToEntry(r as WatchlistRow));
}

export async function listSignals(
  client: SupabaseClient,
  opts: { strength?: SignalStrength; days?: number; watchlistId?: string } = {},
): Promise<Array<IcpSignal & { companyName: string; domain: string | null }>> {
  let query = client
    .from("icp_signals")
    .select("*, icp_watchlist(company_name, domain)")
    .order("detected_at", { ascending: false })
    .limit(200);
  if (opts.strength) query = query.eq("strength", opts.strength);
  if (opts.watchlistId) query = query.eq("watchlist_id", opts.watchlistId);
  if (opts.days) {
    const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
    query = query.gte("detected_at", since);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Failed to list signals: ${error.message}`);
  type Joined = SignalRow & {
    icp_watchlist: { company_name: string; domain: string | null } | null;
  };
  return (data ?? []).map((r) => {
    const row = r as Joined;
    return {
      ...rowToSignal(row),
      companyName: row.icp_watchlist?.company_name ?? "?",
      domain: row.icp_watchlist?.domain ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export async function scanWatchlistEntry(
  client: SupabaseClient,
  entry: WatchlistEntry,
): Promise<ScanResult> {
  const result: ScanResult = {
    watchlistId: entry.id,
    companyName: entry.companyName,
    boardFound: false,
    jobCount: 0,
    prefilteredCount: 0,
    newSignals: [],
    crmCompanyId: null,
  };

  const postings = await fetchBoardJobs(entry.ats, entry.boardSlug);
  await client
    .from("icp_watchlist")
    .update({ last_scanned_at: new Date().toISOString() })
    .eq("id", entry.id);

  if (!postings) return result; // board gone or unreachable; keep entry, report as not found
  result.boardFound = true;
  result.jobCount = postings.length;

  // Skip postings whose URL already produced a signal — avoids re-running the
  // LLM over the same ads on every scan.
  const { data: existing } = await client
    .from("icp_signals")
    .select("url")
    .eq("watchlist_id", entry.id);
  const seenUrls = new Set((existing ?? []).map((r) => (r as { url: string }).url));

  const candidates = prefilterPostings(postings).filter((p) => !seenUrls.has(p.url));
  result.prefilteredCount = candidates.length;

  const signals = await classifyPostings(entry.companyName, candidates);

  // Deterministic cross-posting signal, dedupe by a synthetic board-level URL.
  const noQa = detectDevHiringNoQa(postings);
  const boardUrl = `ats://${entry.ats}/${entry.boardSlug}#dev_hiring_no_qa`;
  if (noQa.triggered && !seenUrls.has(boardUrl)) {
    signals.push({
      signalType: "dev_hiring_no_qa",
      strength: "medium",
      title: `${noQa.devCount} open dev roles, zero QA/SDET roles`,
      url: boardUrl,
      evidence: `${noQa.devCount} engineering postings live with no QA/SDET/test role open.`,
    });
  }

  if (signals.length === 0) return result;

  // Strong signal → make sure the company exists in the CRM before linking.
  let crmCompanyId: string | null = null;
  if (signals.some((s) => s.strength === "strong")) {
    const { company } = await upsertCompanyFromWebhook(client, {
      name: entry.companyName,
      domain: entry.domain,
      tags: ["icp-scan"],
      enrichment: {
        icp_scan: {
          ats: entry.ats,
          board_slug: entry.boardSlug,
          last_signals: signals.map((s) => ({
            type: s.signalType,
            strength: s.strength,
            title: s.title,
            url: s.url,
          })),
          scanned_at: new Date().toISOString(),
        },
      },
    });
    crmCompanyId = company.id;
    result.crmCompanyId = company.id;
  }

  const { error } = await client.from("icp_signals").upsert(
    signals.map((s) => ({
      watchlist_id: entry.id,
      company_id: crmCompanyId,
      signal_type: s.signalType,
      strength: s.strength,
      title: s.title,
      url: s.url,
      evidence: s.evidence,
    })),
    { onConflict: "url,signal_type", ignoreDuplicates: true },
  );
  if (error) throw new Error(`Failed to store signals: ${error.message}`);

  result.newSignals = signals;
  return result;
}

export async function scanWatchlist(
  client: SupabaseClient,
  opts: { watchlistId?: string } = {},
): Promise<ScanResult[]> {
  let entries = await listWatchlist(client, { activeOnly: true });
  if (opts.watchlistId) {
    entries = entries.filter((e) => e.id === opts.watchlistId);
  }

  const results: ScanResult[] = [];
  for (const entry of entries) {
    try {
      results.push(await scanWatchlistEntry(client, entry));
    } catch (err) {
      console.error(`[icp-scan] ${entry.companyName} failed:`, err);
    }
    // Politeness gap between companies (public APIs, no auth).
    await new Promise((r) => setTimeout(r, 400));
  }
  return results;
}
