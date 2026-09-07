/**
 * What the assistants answered last week, written for a persona's shift.
 *
 * The fleet publishes to be cited by ChatGPT, Perplexity, Claude and Google's
 * overview — and until now nothing about that ever reached the persona doing the
 * writing. It could read Search Console and its own dev.to stats, neither of
 * which says a word about the thing it is actually for. So it optimised for what
 * it could see.
 *
 * Two facts are worth a persona's attention, and no more: the buyer questions we
 * are absent from (what to write about), and whether any of our own pages got
 * cited (whether it is working). The searches the assistants ran to answer those
 * questions are the most concrete brief there is — each one is a page that
 * should exist.
 */
import type { VisibilitySummary } from "@/lib/ai-visibility";
import { isOwnedDomain } from "@/lib/owned-domains";

const MAX_PROMPTS = 4;
const MAX_SEARCHES = 5;

/** Prompts where no engine named the brand in any sample this run. */
function promptsWithoutBrand(summary: VisibilitySummary): string[] {
  const out: string[] = [];
  for (const p of summary.prompts) {
    const results = Object.values(p.runs).filter((r) => r && !r.error);
    if (!results.length) continue;
    if (results.some((r) => r.mentioned > 0)) continue;
    out.push(p.prompt.prompt);
  }
  return out;
}

/** Our own pages the assistants cited, with how often. */
function ownCitations(summary: VisibilitySummary): { domain: string; citations: number }[] {
  const counts = new Map<string, number>();
  for (const p of summary.prompts) {
    for (const r of Object.values(p.runs)) {
      if (!r) continue;
      for (const domain of r.citedDomains) {
        if (!isOwnedDomain(domain)) continue;
        counts.set(domain, (counts.get(domain) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([domain, citations]) => ({ domain, citations }))
    .sort((a, b) => b.citations - a.citations);
}

export function formatVisibilityBrief(summary: VisibilitySummary | null): string {
  if (!summary?.runOn) return "";
  const absent = promptsWithoutBrand(summary).slice(0, MAX_PROMPTS);
  const searches = summary.searches.slice(0, MAX_SEARCHES).map((s) => s.query);
  const own = ownCitations(summary);
  if (!absent.length && !searches.length && !own.length) return "";

  const share =
    summary.overallShare != null ? ` — we're named in ${Math.round(summary.overallShare * 100)}% of answers` : "";
  const lines = [
    `WHAT THE ASSISTANTS ANSWERED (run of ${summary.runOn}${share}). This is the scoreboard your writing is judged on, not clicks:`,
  ];
  if (absent.length) {
    lines.push(
      `- Buyer questions we were NOT named in: ${absent.map((p) => `"${p}"`).join(", ")}.`,
    );
  }
  if (searches.length) {
    lines.push(
      `- Searches the assistants ran to answer them — each one is a page that should exist: ${searches
        .map((q) => `"${q}"`)
        .join(", ")}.`,
    );
  }
  lines.push(
    own.length
      ? `- Our own pages they cited: ${own.map((o) => `${o.domain} (${o.citations})`).join(", ")}. It works — do more of what got you there.`
      : "- None of our own pages were cited this run. Nothing you've published is being read back yet.",
  );
  lines.push(
    "Aim a piece at one of those questions, on the channel that fits it. Write the page the assistant was looking for and couldn't find — not a pitch for us; the answer it needed.",
  );
  return lines.join("\n");
}
