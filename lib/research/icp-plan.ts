// Natural-language ICP → structured research plan (Clay-style).
// The user describes their ICP in free text (must-haves, buyer, triggers,
// anti-ICP); the LLM compiles it into a scoring rubric + signal-first
// discovery queries. The rubric is stored per-table (rubric_json) so every
// table can carry its own ICP.

import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import { validateRubric } from "@/lib/research/rubrics";
import type { Rubric } from "@/lib/research/types";

export type HuntSource = "job_postings" | "news" | "incidents" | "web";

export type IcpHunt = {
  source: HuntSource;
  /** Rubric criterion this hunt confirms when the signal checks out. */
  criterionId: string;
  queries: string[];
  /** Yes/no question answered by reading the found page. */
  confirm: string;
};

export type IcpPlan = {
  rubric: Rubric;
  /** Suggested table name, e.g. "SaaS B2B Brasil — dor de QA" */
  tableName: string;
  market: "global" | "brazil";
  size: "any" | "small" | "mid" | "large";
  /** Signal-first discovery queries (job-posting content search). */
  queries: string[];
  /** Short keyword terms for keyword-based job boards (Gupy, LinkedIn…). */
  keywords: string[];
  /** Signal hunts — source-aware search plans chosen from the ICP. */
  hunts: IcpHunt[];
  /** Company-name patterns to drop at discovery time (consultancies etc). */
  excludeNamePatterns: string[];
  /** How the model interpreted the ICP — shown to the user for correction. */
  interpretation: string;
};

const SYSTEM = `You compile a free-text ICP (ideal customer profile) description into a machine-usable research plan for a Clay-style company-research table.

The plan scores companies using ONLY externally observable evidence, collected by these packs:
- careers: public job postings (titles + descriptions) — hiring signals, team size hints, tech mentions
- product: the company's website — what the product is, who it serves
- ship: changelog / release notes / eng blog — shipping cadence
- news: recent news / funding / launches
- pain: public bug complaints, incidents, status pages
- firmo: firmographics from a data provider — real employee count (with dev-team estimate), industry, founded year, HQ country, leadership. Use for company-size and industry criteria.

Rules for the rubric:
- criteria kinds: "trigger" (why-now signal, weight 8-18), "fit" (stable attribute, weight 6-14), "anti" (disqualifier, weight 0-8)
- anti criteria that MUST disqualify get "veto": true and weight 0
- every criterion needs: id (snake_case), label, kind, weight, packs (subset of the 5 above), pass_hint (one line telling the scorer what evidence means PASS; prefix anti hints with "ANTI:")
- ICP conditions that are NOT externally observable (e.g. "has usable staging", "someone internal can clarify behaviors") must NOT become criteria — list them in "call_checklist" instead
- 8-16 criteria total; pass_threshold 45-65
- default_personas: buyer roles from the ICP

Rules for discovery queries (6-10):
- they search full job-posting text on ATS boards, so write signal phrases, not boolean keyword soup
- derive them from the ICP's trigger moments (e.g. "first QA hire", "flaky test suite", "regressão manual atrasando release")
- write them in the language of the target market (Portuguese for brazil, English for global); include both when market is brazil and postings may be bilingual

Also produce "keywords" (4-8): SHORT job-search terms (1-3 words, e.g. "QA", "SDET", "Playwright", "Analista de Testes") for keyword-based job boards (Gupy, LinkedIn, Workable). Same market-language rule.

Also produce "hunts" (2-5): signal hunts — HOW to find companies exhibiting this ICP's trigger moments. Choose the source where each signal actually lives; do NOT default everything to job postings:
- "job_postings": signal appears in hiring text (first QA hire, team being built, migration mentioned in a role)
- "news": funding rounds, launches, enterprise deals, expansion
- "incidents": public outages, status pages, complaint sites, bug backlash
- "web": engineering blogs, changelogs, communities, anything else public
Each hunt: {"source": "job_postings|news|incidents|web", "criterion_id": "<the rubric criterion this hunt confirms>", "queries": ["2-4 search phrases in the market language"], "confirm": "a yes/no question an analyst answers by reading the found page to confirm the signal applies to that company"}.

Respond with ONLY a JSON object:
{
  "table_name": "...",
  "market": "global|brazil",
  "size": "any|small|mid|large",
  "interpretation": "2-4 sentences summarizing how you read the ICP, in the user's language",
  "exclude_name_patterns": ["consultoria", "software house", ...],
  "call_checklist": ["...conditions to verify on a call..."],
  "keywords": ["QA", "SDET", ...],
  "rubric": {
    "id": "custom-...",
    "name": "...",
    "version": 1,
    "description": "...",
    "pass_threshold": 55,
    "default_personas": ["CTO", ...],
    "criteria": [
      {"id": "...", "label": "...", "kind": "trigger|fit|anti", "weight": 12, "packs": ["careers"], "pass_hint": "...", "veto": false}
    ]
  },
  "queries": ["...", "..."],
  "hunts": [
    {"source": "job_postings", "criterion_id": "...", "queries": ["..."], "confirm": "..."}
  ]
}`;

export type IcpPlanResult = IcpPlan & { callChecklist: string[] };

export async function buildIcpPlanFromPrompt(
  icpText: string,
  opts: { marketHint?: "global" | "brazil" | null } = {},
): Promise<IcpPlanResult> {
  const { text } = await generateText({
    model: getModel(),
    system: SYSTEM,
    prompt: `ICP description (free text from the user):\n\n${icpText}\n\n${
      opts.marketHint ? `Market hint: ${opts.marketHint}` : ""
    }`,
  });

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("ICP compiler returned no JSON");

  let parsed: {
    table_name?: string;
    market?: string;
    size?: string;
    interpretation?: string;
    exclude_name_patterns?: unknown[];
    call_checklist?: unknown[];
    rubric?: unknown;
    queries?: unknown[];
    keywords?: unknown[];
    hunts?: Array<{
      source?: string;
      criterion_id?: string;
      queries?: unknown[];
      confirm?: string;
    }>;
  };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    throw new Error("ICP compiler returned invalid JSON");
  }

  const rubric = validateRubric(parsed.rubric);

  const queries = (parsed.queries ?? [])
    .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
    .slice(0, 10);
  if (queries.length === 0) {
    throw new Error("ICP compiler returned no discovery queries");
  }

  // An explicit hint from the caller/user always wins over the LLM's guess.
  const market =
    opts.marketHint ??
    (parsed.market === "brazil" || parsed.market === "global"
      ? parsed.market
      : "global");
  const size =
    parsed.size === "small" ||
    parsed.size === "mid" ||
    parsed.size === "large" ||
    parsed.size === "any"
      ? parsed.size
      : "any";

  return {
    rubric,
    tableName:
      typeof parsed.table_name === "string" && parsed.table_name.trim()
        ? parsed.table_name.trim()
        : rubric.name,
    market,
    size,
    queries,
    keywords: (parsed.keywords ?? [])
      .filter((k): k is string => typeof k === "string" && k.trim().length > 0)
      .slice(0, 8),
    hunts: (parsed.hunts ?? [])
      .filter(
        (h) =>
          (h.source === "job_postings" ||
            h.source === "news" ||
            h.source === "incidents" ||
            h.source === "web") &&
          typeof h.criterion_id === "string" &&
          typeof h.confirm === "string" &&
          Array.isArray(h.queries),
      )
      .map((h) => ({
        source: h.source as HuntSource,
        criterionId: h.criterion_id as string,
        queries: (h.queries ?? [])
          .filter((q): q is string => typeof q === "string" && q.trim().length > 2)
          .slice(0, 4),
        confirm: h.confirm as string,
      }))
      .filter((h) => h.queries.length > 0)
      .slice(0, 5),
    excludeNamePatterns: (parsed.exclude_name_patterns ?? [])
      .filter((p): p is string => typeof p === "string" && p.trim().length > 1)
      .slice(0, 20),
    interpretation:
      typeof parsed.interpretation === "string" ? parsed.interpretation : "",
    callChecklist: (parsed.call_checklist ?? []).filter(
      (c): c is string => typeof c === "string",
    ),
  };
}
