import type { SupabaseClient } from "@supabase/supabase-js";

import {
  discoverCompanies,
  type DiscoveryMarket,
} from "@/lib/icp/discovery";
import type { AtsProvider } from "@/lib/icp/job-boards";
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
  const queries =
    input.market === "brazil"
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

  const discovered = await discoverCompanies({
    market: input.market,
    maxCompanies: fetchCap,
    queries,
  });

  const toAdd = discovered.map((d) => ({
    companyName: d.companyName,
    // Gupy often has no public domain; global ATS slug is not a domain.
    domain: null as string | null,
    source: "discovery" as const,
    packRaw: {
      find: {
        market: input.market,
        size: input.size,
        focus: focus ?? null,
        found_at: new Date().toISOString(),
      },
      discovery: {
        ats: d.ats as AtsProvider,
        boardSlug: d.slug,
        jobCount: d.jobCount,
        sourceUrl: d.sourceUrl,
      },
    },
  }));

  const result = await addRows(client, input.tableId, toAdd);

  return {
    discovered: discovered.length,
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
