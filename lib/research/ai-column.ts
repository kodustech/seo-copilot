import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import { searchWebContent, scrapePageContent } from "@/lib/exa";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRow } from "@/lib/research/tables";

export type AiColumnResult = {
  rowId: string;
  answer: string;
  booleanAnswer: boolean | null;
  evidence: string | null;
  sources: Array<{ url: string; title?: string | null }>;
};

/**
 * Claygent-light: one free-text research question per row.
 * Uses domain scrape + short web search + LLM.
 */
export async function runAiColumn(
  client: SupabaseClient,
  rowId: string,
  prompt: string,
  opts: { sourceColumnKeys?: string[] } = {},
): Promise<AiColumnResult> {
  const row = await getRow(client, rowId);
  if (!row) throw new Error("Row not found");

  const sourceCells = (opts.sourceColumnKeys ?? []).map((key) => ({
    key,
    value: row.cells?.[key]?.value ?? null,
  }));
  const restrictedSources = opts.sourceColumnKeys?.length
    ? sourceCells
        .filter((cell) => cell.value !== null && cell.value !== "")
        .map((cell) => `${cell.key}: ${String(cell.value)}`)
        .join("\n")
    : null;

  if (opts.sourceColumnKeys?.length && !restrictedSources) {
    return {
      rowId,
      answer: "Sem contexto público de engenharia para usar no outreach.",
      booleanAnswer: null,
      evidence: `No value in source columns: ${opts.sourceColumnKeys.join(", ")}`,
      sources: [],
    };
  }

  const sources: Array<{ url: string; title?: string | null }> = [];
  const blobs: string[] = [];

  if (!restrictedSources && process.env.EXA_API_KEY?.trim()) {
    // Only the homepage scrape needs a domain; the web search keys off the
    // company name, so it must run for domain-less rows too — otherwise the
    // model answers "unknown" because nobody went looking.
    if (row.domain) {
      try {
        const page = await scrapePageContent({
          url: `https://${row.domain}`,
          maxCharacters: 5000,
          includeSummary: true,
        });
        sources.push({ url: page.url, title: page.title });
        blobs.push(
          `Homepage (${page.url}): ${page.summary ?? ""}\n${page.text ?? ""}`,
        );
      } catch {
        // ignore
      }
    }

    try {
      const web = await searchWebContent({
        query: `"${row.companyName}" ${prompt}`,
        numResults: 5,
        // No date filter. Research questions are about durable facts — who
        // regulates the company, what its corporate domain is — and the pages
        // carrying those facts (registry entries, homepages) publish no date,
        // so any startPublishedDate drops them and leaves only recent chatter.
        daysBack: 0,
        textMaxCharacters: 1500,
      });
      for (const r of web.results) {
        sources.push({ url: r.url, title: r.title });
        // The URL and date belong in the evidence, not just in `sources`:
        // these prompts ask the model to answer "<fact> | <source URL> |
        // <date>", and it cannot cite what it was never shown.
        blobs.push(
          `${r.title} (${r.url}${r.publishedDate ? `, published ${r.publishedDate.slice(0, 10)}` : ""}): ${r.summary ?? ""}\n${(r.highlights ?? []).join(" ")}`,
        );
      }
    } catch {
      // ignore
    }
  }

  if (restrictedSources) {
    blobs.push(`Allowed column evidence:\n${restrictedSources}`);
  } else {
    const packRaw = row.packRaw ?? {};
    blobs.push(`Prior research raw (truncated): ${JSON.stringify(packRaw).slice(0, 4000)}`);
  }

  const { text } = await generateText({
    model: getModel(),
    system: `Answer the research question about a company using only the evidence.
Return ONLY JSON:
{"answer":"short answer","boolean":true|false|null,"evidence":"quote or reason","source_urls":["..."]}`,
    prompt: `Company: ${row.companyName}
Domain: ${row.domain ?? "unknown"}
Question: ${prompt}

Evidence:
${blobs.join("\n\n").slice(0, 20000)}`,
  });

  let answer = text.trim();
  let booleanAnswer: boolean | null = null;
  let evidence: string | null = null;
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as {
        answer?: string;
        boolean?: boolean | null;
        evidence?: string;
        source_urls?: string[];
      };
      answer = parsed.answer ?? answer;
      booleanAnswer =
        typeof parsed.boolean === "boolean" ? parsed.boolean : null;
      evidence = parsed.evidence ?? null;
      if (parsed.source_urls?.length) {
        for (const u of parsed.source_urls) {
          if (!sources.some((s) => s.url === u)) {
            sources.push({ url: u });
          }
        }
      }
    }
  } catch {
    // keep raw text
  }

  // Persist into pack_raw.ai_columns without wiping other research.
  const prev = (row.packRaw ?? {}) as Record<string, unknown>;
  const aiColumns = {
    ...((prev.ai_columns as Record<string, unknown>) ?? {}),
    [prompt.slice(0, 120)]: {
      answer,
      boolean: booleanAnswer,
      evidence,
      sources,
      at: new Date().toISOString(),
    },
  };
  await client
    .from("research_rows")
    .update({
      pack_raw: { ...prev, ai_columns: aiColumns },
      updated_at: new Date().toISOString(),
    })
    .eq("id", rowId);

  return { rowId, answer, booleanAnswer, evidence, sources };
}
