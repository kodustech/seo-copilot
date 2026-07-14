// Signal classification for job postings. Cheap regex prefilter first so the
// LLM only sees postings that plausibly carry a signal, then one LLM call per
// company batch. Mirrors the JSON-extraction pattern in contact-discovery.ts.

import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import type { JobPosting } from "@/lib/icp/job-boards";

export type SignalType =
  | "qa_automation_hiring" // strong: QA/SDET/SEiT role mentioning E2E, CI or flaky tests
  | "test_suite_rescue" // strong: role asks to build, recover or take over a test suite
  | "ai_feature" // strong: building AI features that will need evals
  | "e2e_tooling" // medium: posting mentions Playwright/Cypress/Selenium
  | "dev_hiring_no_qa"; // medium: several dev roles open, zero QA/SDET roles

export type SignalStrength = "strong" | "medium";

export type PostingSignal = {
  signalType: SignalType;
  strength: SignalStrength;
  title: string;
  url: string;
  evidence: string;
};

// Prefilter so the LLM only sees plausible carriers: QA/testing/AI keywords
// in the TITLE, or unambiguous testing terms in the body. Generic words like
// "testing" in a job description are too common to qualify on their own.
const TITLE_REGEX =
  /\b(qa|sdet|quality|test(ing|s|er|es)?|e2e|automation|automa[çc][ãa]o|qualidade|evals?|llm|ai|machine learning)\b/i;
const CONTENT_REGEX =
  /\b(playwright|cypress|selenium|flaky|sdet|e2e test|end[- ]to[- ]end test|test suite|test coverage|qa automation|automa[çc][ãa]o de testes|su[íi]te de testes|testes automatizados|evals?\b)/i;

export function prefilterPostings(postings: JobPosting[]): JobPosting[] {
  return postings.filter(
    (p) => TITLE_REGEX.test(p.title) || CONTENT_REGEX.test(p.content),
  );
}

const DEV_ROLE_REGEX =
  /\b(software|backend|frontend|front[- ]end|back[- ]end|full[- ]?stack|platform|devops|mobile|ios|android|data)\s+(engineer|developer)\b|\bengenheir[oa]\b|\bdesenvolvedor(a)?\b/i;

const QA_ROLE_REGEX = /\b(qa|sdet|quality|test|qualidade)\b/i;

// Deterministic cross-posting signal: hiring several devs but no QA at all.
export function detectDevHiringNoQa(postings: JobPosting[]): {
  devCount: number;
  triggered: boolean;
} {
  const devPostings = postings.filter((p) => DEV_ROLE_REGEX.test(p.title));
  const qaPostings = postings.filter((p) => QA_ROLE_REGEX.test(p.title));
  return {
    devCount: devPostings.length,
    triggered: devPostings.length >= 3 && qaPostings.length === 0,
  };
}

const CLASSIFY_SYSTEM_PROMPT = `You classify job postings as buying-intent signals for a dev-tools company selling automated E2E testing / QA automation.

Signal taxonomy (only these types):
- qa_automation_hiring (strong): QA Automation, SDET or Software Engineer in Test role that mentions E2E tests, CI, or flaky tests.
- test_suite_rescue (strong): any role explicitly asked to build from scratch, recover, rewrite, or take ownership of a test suite / test coverage.
- ai_feature (strong): the company is building AI/LLM product features (the posting is FOR building AI features, not just "we use AI internally" or generic AI hype).
- e2e_tooling (medium): posting mentions Playwright, Cypress or Selenium but does not qualify for a strong signal above.

Rules:
- Postings may be in English or Portuguese; classify either, keep evidence quotes in the original language.
- A posting can carry multiple signals; emit one entry per (posting, type).
- Prefer the strong type when both a strong and e2e_tooling match the same posting; still emit e2e_tooling only if no strong type matched.
- evidence must be a short verbatim quote (max 200 chars) from the posting that justifies the signal.
- If nothing qualifies, return [].

Respond with ONLY a JSON array, no prose:
[{"index": <posting index>, "signalType": "...", "strength": "strong"|"medium", "evidence": "..."}]`;

type RawClassification = {
  index?: number;
  signalType?: string;
  strength?: string;
  evidence?: string;
};

const VALID_TYPES = new Set<string>([
  "qa_automation_hiring",
  "test_suite_rescue",
  "ai_feature",
  "e2e_tooling",
]);

const STRENGTH_BY_TYPE: Record<string, SignalStrength> = {
  qa_automation_hiring: "strong",
  test_suite_rescue: "strong",
  ai_feature: "strong",
  e2e_tooling: "medium",
};

export async function classifyPostings(
  companyName: string,
  postings: JobPosting[],
): Promise<PostingSignal[]> {
  if (postings.length === 0) return [];

  const blob = postings
    .map(
      (p, i) =>
        `--- POSTING ${i} ---\nTitle: ${p.title}\nTeam: ${p.team ?? "?"}\n${p.content}`,
    )
    .join("\n\n");

  const { text } = await generateText({
    model: getModel(),
    system: CLASSIFY_SYSTEM_PROMPT,
    prompt: `Company: ${companyName}\n\n${blob}`,
  });

  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: RawClassification[];
  try {
    parsed = JSON.parse(match[0]) as RawClassification[];
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const signals: PostingSignal[] = [];
  for (const item of parsed) {
    if (
      typeof item?.index !== "number" ||
      !item.signalType ||
      !VALID_TYPES.has(item.signalType)
    ) {
      continue;
    }
    const posting = postings[item.index];
    if (!posting) continue;
    signals.push({
      signalType: item.signalType as SignalType,
      strength: STRENGTH_BY_TYPE[item.signalType],
      title: posting.title,
      url: posting.url,
      evidence: (item.evidence ?? "").slice(0, 300),
    });
  }
  return signals;
}
