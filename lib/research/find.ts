import type { SupabaseClient } from "@supabase/supabase-js";

import {
  discoverCompanies,
  type DiscoveryMarket,
} from "@/lib/icp/discovery";
import type { AtsProvider } from "@/lib/icp/job-boards";
import type { IcpHunt } from "@/lib/research/icp-plan";
import { runHunts, type HuntCandidate } from "@/lib/research/hunts";
import { addRows, getTable } from "@/lib/research/tables";
import type { ResearchRow } from "@/lib/research/types";

export type CompanySizeBand = "any" | "small" | "mid" | "large";

export type FindIcpInput = {
  tableId: string;
  market: DiscoveryMarket;
  size: CompanySizeBand;
  maxCompanies?: number;
  /** Optional extra search terms (appended to default QA/E2E queries). */
  focus?: string | null;
  /** Full custom query set (from an ICP plan) — replaces the defaults. */
  queries?: string[] | null;
  /** Short keyword terms for keyword-based boards (Gupy, LinkedIn…). */
  keywords?: string[] | null;
  /** Signal hunts from the ICP plan — run first; confirmed candidates carry evidence. */
  hunts?: IcpHunt[] | null;
  /** Company-name substrings to drop at discovery time (consultancies etc). */
  excludeNamePatterns?: string[] | null;
};

export type FindIcpResult = {
  discovered: number;
  added: number;
  skipped: number;
  rowIds: string[];
  rows: ResearchRow[];
  market: DiscoveryMarket;
  size: CompanySizeBand;
};

/**
 * Find candidate companies for the ICP (region + hiring signal source),
 * drop them into a research table with board metadata so careers pack
 * can score them without re-guessing the ATS.
 */
export async function findIcpCompanies(
  client: SupabaseClient,
  input: FindIcpInput,
): Promise<FindIcpResult> {
  const table = await getTable(client, input.tableId);
  if (!table) throw new Error("Research table not found");

  const maxCompanies = Math.min(Math.max(input.maxCompanies ?? 12, 3), 30);

  const focus = input.focus?.trim();
  const customQueries = (input.queries ?? []).filter(
    (q) => typeof q === "string" && q.trim().length > 2,
  );
  const queries =
    customQueries.length > 0
      ? customQueries
      : input.market === "brazil"
        ? focus
          ? [focus, "QA", "SDET", "Playwright", "Automação de testes"]
          : undefined
        : focus
          ? [
              focus,
              "QA Automation Engineer end-to-end tests",
              "SDET Playwright Cypress",
            ]
          : undefined;

  // Over-fetch a bit so size filter after research still has enough rows.
  const fetchCap =
    input.size === "any" ? maxCompanies : Math.min(maxCompanies * 2, 30);

  const keywords = (input.keywords ?? []).filter(
    (k) => typeof k === "string" && k.trim().length > 0,
  );

  // Signal hunts first: candidates arrive with confirmed evidence (quote +
  // source URL) and often a domain. Legacy board discovery tops up the rest.
  let huntCandidates: HuntCandidate[] = [];
  if (input.hunts && input.hunts.length > 0) {
    try {
      huntCandidates = await runHunts(input.hunts, {
        maxCandidates: maxCompanies,
        excludeNamePatterns: input.excludeNamePatterns ?? [],
        // Table description stores the compiled ICP interpretation.
        icpContext: table.description,
      });
    } catch (err) {
      console.error("[research/find] hunts failed:", err);
    }
  }

  const remaining = Math.max(fetchCap - huntCandidates.length, 0);
  let discovered =
    remaining > 0
      ? await discoverCompanies({
          market: input.market,
          maxCompanies: remaining,
          queries,
          keywords: keywords.length > 0 ? keywords : undefined,
        })
      : [];

  // Drop board-discovered companies the hunts already confirmed.
  const huntNames = new Set(
    huntCandidates.map((c) => c.companyName.toLowerCase()),
  );
  discovered = discovered.filter(
    (d) => !huntNames.has(d.companyName.toLowerCase()),
  );

  const exclude = (input.excludeNamePatterns ?? [])
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 1);
  if (exclude.length > 0) {
    discovered = discovered.filter((d) => {
      const name = d.companyName.toLowerCase();
      return !exclude.some((p) => name.includes(p));
    });
  }

  const findMeta = {
    market: input.market,
    size: input.size,
    focus: focus ?? null,
    found_at: new Date().toISOString(),
  };

  const toAdd = [
    ...huntCandidates.map((c) => ({
      companyName: c.companyName,
      domain: c.domain,
      source: "icp_signal" as const,
      packRaw: {
        find: findMeta,
        hunt: {
          source: c.source,
          criterionId: c.criterionId,
          query: c.query,
          url: c.url,
          title: c.title,
          quote: c.quote,
          confidence: c.confidence,
        },
      },
    })),
    ...discovered.map((d) => ({
      companyName: d.companyName,
      // Gupy often has no public domain; global ATS slug is not a domain.
      domain: null as string | null,
      source: "discovery" as const,
      packRaw: {
        find: findMeta,
        discovery: {
          ats: d.ats as AtsProvider,
          boardSlug: d.slug,
          jobCount: d.jobCount,
          sourceUrl: d.sourceUrl,
          sourceQuery: d.sourceQuery ?? null,
        },
      },
    })),
  ].slice(0, fetchCap);

  const result = await addRows(client, input.tableId, toAdd);

  return {
    discovered: huntCandidates.length + discovered.length,
    added: result.added,
    skipped: result.skipped,
    rowIds: result.rows.map((r) => r.id),
    rows: result.rows,
    market: input.market,
    size: input.size,
  };
}

/** Post-research filter: does eng-hiring signal match the requested size band? */
export function matchesSizeBand(
  size: CompanySizeBand,
  engOpenings: number | null | undefined,
): boolean {
  if (size === "any") return true;
  const n = engOpenings ?? 0;
  if (size === "small") return n > 0 && n <= 10;
  if (size === "mid") return n >= 3 && n <= 50;
  if (size === "large") return n >= 20;
  return true;
}

export function engOpeningsFromPackRaw(
  packRaw: Record<string, unknown> | null | undefined,
): number | null {
  if (!packRaw) return null;
  const careers = packRaw.careers as
    | { meta?: { extraFlags?: { engOpenings?: number } } }
    | undefined;
  const n = careers?.meta?.extraFlags?.engOpenings;
  return typeof n === "number" ? n : null;
}
