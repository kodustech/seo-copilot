import type { SupabaseClient } from "@supabase/supabase-js";

import { getCached, setCache, domainCacheKey } from "@/lib/research/cache";
import { resolveDomain } from "@/lib/research/domain-resolver";
import { packsRequiredByRubric, runPacks } from "@/lib/research/packs";
import { resolveRubric } from "@/lib/research/rubrics";
import { scoreCompany } from "@/lib/research/score";
import {
  getRow,
  getTable,
  markRow,
  saveScore,
} from "@/lib/research/tables";
import type { PackOutput, ScoreResult } from "@/lib/research/types";

export type ResearchCompanyResult = {
  rowId: string;
  companyName: string;
  domain: string | null;
  score: ScoreResult;
  packs: Record<string, PackOutput>;
};

function serializePacks(
  packs: Record<string, PackOutput>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(packs)) {
    out[k] = {
      ok: v.ok,
      error: v.error ?? null,
      meta: v.meta ?? null,
      snippetCount: v.snippets.length,
      snippets: v.snippets.slice(0, 6).map((s) => ({
        url: s.url,
        title: s.title,
        text: s.text.slice(0, 800),
      })),
    };
  }
  return out;
}

export async function researchRow(
  client: SupabaseClient,
  rowId: string,
  opts: { force?: boolean } = {},
): Promise<ResearchCompanyResult> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error(`Row ${rowId} not found`);

  const table = await getTable(client, row.tableId);
  if (!table) throw new Error(`Table ${row.tableId} not found`);
  const rubric = resolveRubric(table);

  await markRow(client, rowId, { status: "researching", error: null });

  try {
    // Discovery rows (Gupy, LinkedIn, Programathor…) arrive without a domain,
    // which blinds product/pain packs, the cache, and the people waterfall.
    let domain = row.domain;
    if (!domain) {
      const discovery = (row.packRaw?.discovery ?? null) as {
        sourceUrl?: string;
      } | null;
      const resolved = await resolveDomain(client, row.companyName, {
        hintUrl: discovery?.sourceUrl ?? null,
      });
      if (resolved.domain) {
        domain = resolved.domain;
        await markRow(client, rowId, { domain });
      }
    }

    const cacheKey = domain
      ? domainCacheKey(domain, `research:${rubric.id}:v1`)
      : null;

    let packs: Record<string, PackOutput> | null = null;
    let score: ScoreResult | null = null;

    if (!opts.force && cacheKey) {
      const cached = await getCached<{
        packs: Record<string, PackOutput>;
        score: ScoreResult;
      }>(client, cacheKey);
      if (cached?.packs && cached?.score) {
        packs = cached.packs;
        score = cached.score;
      }
    }

    if (!packs || !score) {
      const needed = packsRequiredByRubric(rubric);
      const discovery = (row.packRaw?.discovery ?? null) as {
        ats?: string;
        boardSlug?: string;
      } | null;
      const knownBoard =
        discovery?.ats && discovery?.boardSlug
          ? { ats: discovery.ats, slug: discovery.boardSlug }
          : null;

      packs = await runPacks({
        companyName: row.companyName,
        domain,
        packs: needed,
        knownBoard,
      });
      score = await scoreCompany(rubric, row.companyName, domain, packs);
      if (cacheKey) {
        await setCache(
          client,
          cacheKey,
          { packs, score },
          60 * 60 * 24 * 14, // 14d
        );
      }
    }

    // Preserve find/discovery metadata when writing pack results.
    const mergedRaw = {
      ...(row.packRaw ?? {}),
      ...serializePacks(packs),
      discovery: row.packRaw?.discovery,
      find: row.packRaw?.find,
    };
    await saveScore(client, rowId, score, mergedRaw);

    return {
      rowId,
      companyName: row.companyName,
      domain,
      score,
      packs,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "research failed";
    await markRow(client, rowId, { status: "failed", error: message });
    throw err;
  }
}

export async function researchRows(
  client: SupabaseClient,
  rowIds: string[],
  opts: { concurrency?: number; force?: boolean } = {},
): Promise<{
  ok: number;
  failed: number;
  results: ResearchCompanyResult[];
  errors: Array<{ rowId: string; error: string }>;
}> {
  const concurrency = opts.concurrency ?? 2;
  const results: ResearchCompanyResult[] = [];
  const errors: Array<{ rowId: string; error: string }> = [];
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < rowIds.length; i += concurrency) {
    const batch = rowIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(
      batch.map((id) => researchRow(client, id, { force: opts.force })),
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      if (s.status === "fulfilled") {
        ok += 1;
        results.push(s.value);
      } else {
        failed += 1;
        errors.push({
          rowId: batch[j],
          error:
            s.reason instanceof Error ? s.reason.message : String(s.reason),
        });
      }
    }
  }

  return { ok, failed, results, errors };
}
