/**
 * Split a research list into Brazil vs rest-of-world for language/outbound.
 * Rows are MOVEd (table_id update) so people + evidence stay attached.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createTable, getTable, listRows } from "@/lib/research/tables";
import type { ResearchRow, ResearchTable } from "@/lib/research/types";

export type MarketBucket = "brazil" | "world" | "unknown";

export type SplitPreview = {
  brazil: number;
  world: number;
  unknown: number;
  samples: {
    brazil: Array<{ id: string; company: string; domain: string | null; why: string }>;
    world: Array<{ id: string; company: string; domain: string | null; why: string }>;
    unknown: Array<{ id: string; company: string; domain: string | null; why: string }>;
  };
};

export type SplitResult = {
  sourceTableId: string;
  brazilTable: { id: string; slug: string | null; name: string; moved: number };
  worldTable: { id: string; slug: string | null; name: string; moved: number };
  unknownTable: {
    id: string;
    slug: string | null;
    name: string;
    moved: number;
  } | null;
  preview: SplitPreview;
};

function domainLooksBrazil(domain: string | null): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return (
    d.endsWith(".br") ||
    d.includes(".com.br") ||
    d.includes(".org.br") ||
    d.includes(".net.br") ||
    d.includes(".io.com.br")
  );
}

function textLooksBrazil(blob: string): boolean {
  return /\b(brasil|brazil|brasileir|são paulo|sao paulo|rio de janeiro|curitiba|belo horizonte|porto alegre|brasília|brasilia|\.br\b|gupy|programathor)\b/i.test(
    blob,
  );
}

function textLooksNonBrazilStrong(blob: string): boolean {
  // Only use as soft signal when we have explicit non-BR HQ
  return /\b(united states|usa|u\.s\.|united kingdom|uk\b|germany|deutschland|france|netherlands|canada|australia|singapore|india)\b/i.test(
    blob,
  );
}

/**
 * Classify a research row for language/market split.
 * Returns why for debugging / agent transparency.
 */
export function classifyRowMarket(
  row: ResearchRow,
): { bucket: MarketBucket; why: string } {
  const pack = row.packRaw ?? {};

  // Explicit find market from discovery
  const find = pack.find as { market?: string } | undefined;
  if (find?.market === "brazil") {
    return { bucket: "brazil", why: "find.market=brazil" };
  }
  if (find?.market === "global") {
    // still check domain — global discovery can include .br
    if (domainLooksBrazil(row.domain)) {
      return { bucket: "brazil", why: "domain=.br (over global find)" };
    }
  }

  // Brazilian job boards in discovery
  const discovery = pack.discovery as { ats?: string; sourceUrl?: string } | null;
  const ats = (discovery?.ats ?? "").toLowerCase();
  if (
    ats.includes("gupy") ||
    ats.includes("programathor") ||
    ats.includes("vagas") ||
    ats.includes("catho") ||
    ats.includes("infojobs")
  ) {
    return { bucket: "brazil", why: `discovery.ats=${discovery?.ats}` };
  }
  if (discovery?.sourceUrl && textLooksBrazil(discovery.sourceUrl)) {
    return { bucket: "brazil", why: "discovery.sourceUrl" };
  }

  // Firmographics HQ country (NinjaPear)
  const firmo = pack.firmo as
    | { meta?: { hqCountry?: string | null }; snippets?: unknown }
    | undefined;
  const hq = (firmo?.meta?.hqCountry ?? "").toString().toUpperCase();
  if (hq === "BR" || hq === "BRA") {
    return { bucket: "brazil", why: `firmo.hqCountry=${hq}` };
  }
  if (hq && hq.length === 2 && hq !== "BR") {
    return { bucket: "world", why: `firmo.hqCountry=${hq}` };
  }

  // Domain TLD
  if (domainLooksBrazil(row.domain)) {
    return { bucket: "brazil", why: `domain=${row.domain}` };
  }

  // Dynamic cells
  const cellBlob = Object.values(row.cells ?? {})
    .map((c) => String(c?.value ?? ""))
    .join(" ");
  if (textLooksBrazil(cellBlob)) {
    return { bucket: "brazil", why: "cells text" };
  }

  // Snippet dump from packs
  const packBlob = JSON.stringify(pack).slice(0, 8000);
  if (textLooksBrazil(packBlob) || textLooksBrazil(row.companyName)) {
    return { bucket: "brazil", why: "pack/company text" };
  }
  if (hq || textLooksNonBrazilStrong(packBlob)) {
    return {
      bucket: "world",
      why: hq ? `hq=${hq}` : "non-BR geo text",
    };
  }

  // Domain present but not .br and no BR signals → world default for outbound language
  if (row.domain && !domainLooksBrazil(row.domain)) {
    return { bucket: "world", why: "non-.br domain (default world)" };
  }

  return { bucket: "unknown", why: "no country signal" };
}

export async function previewSplitByMarket(
  client: SupabaseClient,
  tableId: string,
): Promise<SplitPreview> {
  const rows = await listRows(client, tableId);
  const samples: SplitPreview["samples"] = {
    brazil: [],
    world: [],
    unknown: [],
  };
  let brazil = 0;
  let world = 0;
  let unknown = 0;

  for (const row of rows) {
    const { bucket, why } = classifyRowMarket(row);
    if (bucket === "brazil") brazil += 1;
    else if (bucket === "world") world += 1;
    else unknown += 1;

    const sample = {
      id: row.id,
      company: row.companyName,
      domain: row.domain,
      why,
    };
    if (samples[bucket].length < 8) samples[bucket].push(sample);
  }

  return { brazil, world, unknown, samples };
}

async function cloneTableShell(
  client: SupabaseClient,
  source: ResearchTable,
  name: string,
  createdByEmail?: string | null,
): Promise<ResearchTable> {
  const table = await createTable(client, {
    name,
    rubricId: source.rubricId,
    rubricJson: source.rubricJson ?? null,
    description: source.description
      ? `${source.description} (split from ${source.name})`
      : `Split from ${source.name}`,
    createdByEmail: createdByEmail ?? source.createdByEmail,
  });
  // Copy column definitions
  if (source.columns?.length) {
    await client
      .from("research_tables")
      .update({ columns: source.columns })
      .eq("id", table.id);
    const refreshed = await getTable(client, table.id);
    return refreshed ?? table;
  }
  return table;
}

async function moveRows(
  client: SupabaseClient,
  rowIds: string[],
  targetTableId: string,
): Promise<number> {
  if (rowIds.length === 0) return 0;
  // Chunk updates
  let moved = 0;
  const chunk = 80;
  for (let i = 0; i < rowIds.length; i += chunk) {
    const ids = rowIds.slice(i, i + chunk);
    const { error, count } = await client
      .from("research_rows")
      .update({
        table_id: targetTableId,
        updated_at: new Date().toISOString(),
      })
      .in("id", ids);
    if (error) throw new Error(`Failed to move rows: ${error.message}`);
    moved += count ?? ids.length;
  }
  return moved;
}

/**
 * Split source list into Brazil / World (/ optional Unknown).
 * Rows are moved (people stay on the same row ids).
 */
export async function splitTableByMarket(
  client: SupabaseClient,
  sourceTableId: string,
  opts: {
    brazilName?: string;
    worldName?: string;
    unknownName?: string;
    /** Put unknown into world instead of a third list (default false → third list if any) */
    unknownIntoWorld?: boolean;
    createdByEmail?: string | null;
    dryRun?: boolean;
  } = {},
): Promise<SplitResult | { dryRun: true; preview: SplitPreview; sourceName: string }> {
  const source = await getTable(client, sourceTableId);
  if (!source) throw new Error("Source table not found");

  const preview = await previewSplitByMarket(client, sourceTableId);
  if (opts.dryRun) {
    return { dryRun: true, preview, sourceName: source.name };
  }

  const rows = await listRows(client, sourceTableId);
  const brazilIds: string[] = [];
  const worldIds: string[] = [];
  const unknownIds: string[] = [];

  for (const row of rows) {
    const { bucket } = classifyRowMarket(row);
    if (bucket === "brazil") brazilIds.push(row.id);
    else if (bucket === "world") worldIds.push(row.id);
    else if (opts.unknownIntoWorld) worldIds.push(row.id);
    else unknownIds.push(row.id);
  }

  const brazilTable = await cloneTableShell(
    client,
    source,
    opts.brazilName?.trim() || `${source.name} — Brasil`,
    opts.createdByEmail,
  );
  const worldTable = await cloneTableShell(
    client,
    source,
    opts.worldName?.trim() || `${source.name} — Global`,
    opts.createdByEmail,
  );

  let unknownTable: ResearchTable | null = null;
  if (unknownIds.length > 0 && !opts.unknownIntoWorld) {
    unknownTable = await cloneTableShell(
      client,
      source,
      opts.unknownName?.trim() || `${source.name} — Unknown market`,
      opts.createdByEmail,
    );
  }

  const movedBr = await moveRows(client, brazilIds, brazilTable.id);
  const movedWorld = await moveRows(client, worldIds, worldTable.id);
  let movedUnknown = 0;
  if (unknownTable) {
    movedUnknown = await moveRows(client, unknownIds, unknownTable.id);
  }

  return {
    sourceTableId: source.id,
    brazilTable: {
      id: brazilTable.id,
      slug: brazilTable.slug,
      name: brazilTable.name,
      moved: movedBr,
    },
    worldTable: {
      id: worldTable.id,
      slug: worldTable.slug,
      name: worldTable.name,
      moved: movedWorld,
    },
    unknownTable: unknownTable
      ? {
          id: unknownTable.id,
          slug: unknownTable.slug,
          name: unknownTable.name,
          moved: movedUnknown,
        }
      : null,
    preview,
  };
}
