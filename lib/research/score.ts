import { generateText } from "ai";

import { getModel } from "@/lib/ai/provider";
import type {
  CriterionResult,
  PackOutput,
  Rubric,
  ScoreResult,
} from "@/lib/research/types";

type LlmCriterion = {
  id?: string;
  status?: string;
  confidence?: number;
  evidence?: string | null;
  source_urls?: string[];
};

function applyDeterministicCareersHints(
  rubric: Rubric,
  packs: Record<string, PackOutput>,
  llmResults: Map<string, CriterionResult>,
): void {
  const careers = packs.careers;
  if (!careers?.meta) return;

  const signals = (careers.meta.signals as Array<{
    type: string;
    strength: string;
    title: string;
    url: string;
    evidence: string;
  }>) ?? [];
  const flags = (careers.meta.extraFlags as Record<string, unknown>) ?? {};

  const bump = (
    criterionId: string,
    status: "pass" | "fail",
    evidence: string,
    url: string,
    confidence = 0.9,
  ) => {
    const criterion = rubric.criteria.find((c) => c.id === criterionId);
    if (!criterion) return;
    const existing = llmResults.get(criterionId);
    if (existing?.status === "pass" && status === "pass") return;
    llmResults.set(criterionId, {
      criterionId,
      kind: criterion.kind,
      status,
      confidence,
      evidence,
      sources: [{ url, pack: "careers", title: evidence.slice(0, 80) }],
      weight: criterion.weight,
      veto: criterion.veto,
    });
  };

  for (const s of signals) {
    if (s.type === "qa_automation_hiring") {
      bump("qa_automation_hiring", "pass", s.evidence, s.url);
      bump("hiring_signal", "pass", s.evidence, s.url);
    }
    if (s.type === "test_suite_rescue") {
      bump("test_suite_rescue", "pass", s.evidence, s.url);
    }
    if (s.type === "ai_feature") {
      bump("ai_feature_shipping", "pass", s.evidence, s.url);
    }
    if (s.type === "dev_hiring_no_qa") {
      bump("eng_growth_no_qa", "pass", s.evidence, s.url);
      bump("hiring_signal", "pass", s.evidence, s.url);
    }
    if (s.type === "e2e_tooling" && !llmResults.has("test_suite_rescue")) {
      // medium signal — leave for LLM unless nothing else
    }
  }

  if (flags.mentionsMigration) {
    bump(
      "migration_or_redesign",
      "pass",
      "Job postings mention migration/rewrite/redesign",
      "careers://extra",
      0.75,
    );
  }
  if (flags.mentionsCompliance) {
    bump(
      "compliance_or_enterprise",
      "pass",
      "Job postings mention compliance/SOC2/HIPAA/security",
      "careers://extra",
      0.8,
    );
  }
  if (flags.mentionsFlaky) {
    bump(
      "test_suite_rescue",
      "pass",
      "Job postings mention flaky/unreliable tests or test debt",
      "careers://extra",
      0.85,
    );
  }
  if (flags.mentionsManualFactory) {
    bump(
      "manual_qa_factory",
      "pass",
      "Job postings suggest manual test-case factory hiring",
      "careers://extra",
      0.85,
    );
  }
  if (flags.mobileHeavy) {
    bump(
      "mobile_native_central",
      "pass",
      "Board is heavily mobile-native engineering roles",
      "careers://extra",
      0.8,
    );
  }
  if (
    typeof flags.engOpenings === "number" &&
    flags.engOpenings >= 3 &&
    typeof flags.qaOpenings === "number" &&
    flags.qaOpenings === 0
  ) {
    bump(
      "eng_growth_no_qa",
      "pass",
      `${flags.engOpenings} eng openings, 0 QA openings`,
      "careers://extra",
      0.9,
    );
  }
  if (typeof flags.engOpenings === "number" && flags.engOpenings >= 1) {
    bump(
      "hiring_signal",
      "pass",
      `${flags.engOpenings} engineering-related openings`,
      "careers://extra",
      0.85,
    );
  }
  if (
    typeof flags.engOpenings === "number" &&
    flags.engOpenings >= 3 &&
    flags.engOpenings <= 40
  ) {
    bump(
      "mid_size_eng_org",
      "pass",
      `${flags.engOpenings} open eng-related roles suggests non-trivial eng org`,
      "careers://extra",
      0.55,
    );
  }
}

function buildEvidenceBlob(packs: Record<string, PackOutput>): string {
  const parts: string[] = [];
  for (const [name, pack] of Object.entries(packs)) {
    parts.push(`## PACK: ${name} (ok=${pack.ok}${pack.error ? ` err=${pack.error}` : ""})`);
    if (pack.meta) {
      parts.push(`META: ${JSON.stringify(pack.meta).slice(0, 2500)}`);
    }
    for (const s of pack.snippets.slice(0, 8)) {
      parts.push(`### ${s.title ?? "untitled"} — ${s.url}\n${s.text.slice(0, 1200)}`);
    }
  }
  return parts.join("\n\n").slice(0, 28000);
}

export async function scoreCompany(
  rubric: Rubric,
  companyName: string,
  domain: string | null,
  packs: Record<string, PackOutput>,
): Promise<ScoreResult> {
  const blob = buildEvidenceBlob(packs);
  const criterionList = rubric.criteria
    .map(
      (c) =>
        `- ${c.id} (${c.kind}, weight=${c.weight}${c.veto ? ", VETO" : ""}): ${c.pass_hint}`,
    )
    .join("\n");

  const results = new Map<string, CriterionResult>();

  // Always seed unknown for every criterion.
  for (const c of rubric.criteria) {
    results.set(c.id, {
      criterionId: c.id,
      kind: c.kind,
      status: "unknown",
      confidence: 0,
      evidence: null,
      sources: [],
      weight: c.weight,
      veto: c.veto,
    });
  }

  applyDeterministicCareersHints(rubric, packs, results);

  if (blob.length > 80) {
    try {
      const { text } = await generateText({
        model: getModel(),
        system: `You score companies against an ICP rubric using ONLY the provided evidence packs.
Rules:
- status must be pass | fail | unknown
- NEVER mark pass without a short verbatim-ish evidence quote grounded in the packs
- If evidence is missing or weak, use unknown (not fail), except for anti criteria where clear counter-evidence is present
- For anti criteria, status=pass means the ANTI condition is TRUE (bad for ICP)
- confidence 0-1
- source_urls must be URLs present in the packs when possible
- Respond with ONLY a JSON array:
[{"id":"criterion_id","status":"pass|fail|unknown","confidence":0.0,"evidence":"...","source_urls":["https://..."]}]`,
        prompt: `Company: ${companyName}
Domain: ${domain ?? "unknown"}
Rubric: ${rubric.id}

Criteria:
${criterionList}

Evidence packs:
${blob}`,
      });

      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as LlmCriterion[];
        for (const item of parsed) {
          if (!item.id) continue;
          const criterion = rubric.criteria.find((c) => c.id === item.id);
          if (!criterion) continue;
          const status =
            item.status === "pass" || item.status === "fail" || item.status === "unknown"
              ? item.status
              : "unknown";
          // Prefer deterministic pass already set at higher confidence.
          const existing = results.get(item.id);
          if (
            existing?.status === "pass" &&
            (existing.confidence ?? 0) >= 0.8 &&
            status !== "pass"
          ) {
            continue;
          }
          if (
            status === "pass" &&
            (!item.evidence || item.evidence.trim().length < 8)
          ) {
            continue;
          }
          const sources =
            (item.source_urls ?? [])
              .filter(Boolean)
              .slice(0, 5)
              .map((url) => ({ url, pack: "llm", title: null })) ?? [];
          results.set(item.id, {
            criterionId: item.id,
            kind: criterion.kind,
            status,
            confidence:
              typeof item.confidence === "number"
                ? Math.max(0, Math.min(1, item.confidence))
                : status === "pass"
                  ? 0.6
                  : 0.3,
            evidence: item.evidence ?? null,
            sources,
            weight: criterion.weight,
            veto: criterion.veto,
          });
        }
      }
    } catch (err) {
      console.error("[research/score] LLM scoring failed:", err);
    }
  }

  const criteria = rubric.criteria.map(
    (c) => results.get(c.id) ?? {
      criterionId: c.id,
      kind: c.kind,
      status: "unknown" as const,
      confidence: 0,
      evidence: null,
      sources: [],
      weight: c.weight,
      veto: c.veto,
    },
  );

  let triggerScore = 0;
  let fitScore = 0;
  const antiFlags: string[] = [];
  let vetoed = false;

  for (const c of criteria) {
    if (c.kind === "trigger" && c.status === "pass") triggerScore += c.weight;
    if (c.kind === "fit" && c.status === "pass") fitScore += c.weight;
    if (c.kind === "anti" && c.status === "pass") {
      antiFlags.push(c.criterionId);
      if (c.veto) vetoed = true;
    }
  }

  const maxTrigger = rubric.criteria
    .filter((c) => c.kind === "trigger")
    .reduce((n, c) => n + c.weight, 0);
  const maxFit = rubric.criteria
    .filter((c) => c.kind === "fit")
    .reduce((n, c) => n + c.weight, 0);

  // Normalize to 0-100: 55% triggers + 45% fit (anti is veto/flag, not score).
  const triggerNorm = maxTrigger > 0 ? (triggerScore / maxTrigger) * 55 : 0;
  const fitNorm = maxFit > 0 ? (fitScore / maxFit) * 45 : 0;
  let icpScore = Math.round(triggerNorm + fitNorm);

  // Soft penalty for non-veto anti flags.
  icpScore = Math.max(0, icpScore - antiFlags.filter((id) => {
    const c = rubric.criteria.find((x) => x.id === id);
    return c && !c.veto;
  }).length * 8);

  if (vetoed) icpScore = Math.min(icpScore, rubric.pass_threshold - 1);

  const pass = !vetoed && icpScore >= rubric.pass_threshold;

  const whyBits = criteria
    .filter((c) => c.status === "pass" && c.kind === "trigger")
    .slice(0, 3)
    .map((c) => c.evidence || c.criterionId);

  return {
    criteria,
    triggerScore,
    fitScore,
    icpScore,
    antiFlags,
    pass,
    whyNow: whyBits.length > 0 ? whyBits.join(" · ") : null,
  };
}
