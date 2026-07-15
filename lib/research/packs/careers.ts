import type { PackOutput } from "@/lib/research/types";
import {
  detectBoard,
  fetchBoardJobs,
  type JobPosting,
} from "@/lib/icp/job-boards";
import {
  classifyPostings,
  detectDevHiringNoQa,
  prefilterPostings,
} from "@/lib/icp/classify";

function truncate(text: string, max = 600): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export async function runCareersPack(input: {
  companyName: string;
  domain: string | null;
  /** When discovery already knows the board, skip detectBoard. */
  knownBoard?: { ats: string; slug: string } | null;
}): Promise<PackOutput> {
  const pack = "careers";
  try {
    let board: { ats: import("@/lib/icp/job-boards").AtsProvider; slug: string } | null =
      null;

    if (input.knownBoard?.ats && input.knownBoard?.slug) {
      board = {
        ats: input.knownBoard.ats as import("@/lib/icp/job-boards").AtsProvider,
        slug: input.knownBoard.slug,
      };
    }

    if (!board && input.domain) {
      board = await detectBoard({
        companyName: input.companyName,
        domain: input.domain,
      });
    }

    // Fallback: try company name as slug on common ATS if detect failed.
    if (!board && input.companyName) {
      const slugGuess = input.companyName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "")
        .slice(0, 40);
      if (slugGuess.length >= 3) {
        board = await detectBoard({
          companyName: input.companyName,
          domain: slugGuess,
        });
      }
    }

    if (!board) {
      return {
        pack,
        ok: true,
        snippets: [],
        meta: { boardFound: false, jobCount: 0, signals: [] },
      };
    }

    const postings: JobPosting[] =
      (await fetchBoardJobs(board.ats, board.slug)) ?? [];
    const candidates = prefilterPostings(postings);
    const signals = await classifyPostings(input.companyName, candidates);
    const noQa = detectDevHiringNoQa(postings);
    if (noQa.triggered) {
      signals.push({
        signalType: "dev_hiring_no_qa",
        strength: "medium",
        title: `${noQa.devCount} open dev roles, zero QA/SDET roles`,
        url: `ats://${board.ats}/${board.slug}#dev_hiring_no_qa`,
        evidence: `${noQa.devCount} engineering postings live with no QA/SDET/test role open.`,
      });
    }

    // Extra heuristic flags for the scorer (migration, compliance, first QA, manual factory).
    const joined = postings
      .map((p) => `${p.title}\n${p.content}`)
      .join("\n")
      .toLowerCase();
    const extraFlags = {
      mentionsMigration:
        /\b(migrat(e|ion|ing)|rewrite|re[- ]?architect|redesign|moderniz)/i.test(
          joined,
        ),
      mentionsCompliance:
        /\b(soc\s*2|hipaa|pci|gdpr|compliance|iso\s*27001|security questionnaire)/i.test(
          joined,
        ),
      mentionsFirstQa:
        /\b(first\s+qa|first\s+sdet|building\s+(our\s+)?qa|founding\s+sdet)/i.test(
          joined,
        ),
      mentionsManualFactory:
        /\b(manual\s+test(ing|er|s)?|write\s+\d+\s+test\s+cases|test\s+case\s+execution|execute\s+test\s+cases)/i.test(
          joined,
        ),
      mentionsFlaky:
        /\b(flaky|unreliable\s+tests|test\s+debt|brittle\s+tests)/i.test(joined),
      engOpenings: postings.filter((p) =>
        /\b(engineer|developer|engenheir|desenvolvedor)/i.test(p.title),
      ).length,
      qaOpenings: postings.filter((p) =>
        /\b(qa|sdet|quality|test\s*engineer)/i.test(p.title),
      ).length,
      mobileHeavy:
        postings.filter((p) =>
          /\b(ios|android|mobile\s+(engineer|developer)|react\s*native|flutter)\b/i.test(
            p.title,
          ),
        ).length >= Math.max(3, Math.floor(postings.length * 0.4)),
    };

    const snippets = [
      ...signals.map((s) => ({
        url: s.url,
        title: s.title,
        text: `[${s.signalType}/${s.strength}] ${s.evidence}`,
      })),
      ...postings.slice(0, 12).map((p) => ({
        url: p.url,
        title: p.title,
        text: truncate(`${p.title}\n${p.team ?? ""}\n${p.content}`),
      })),
    ];

    return {
      pack,
      ok: true,
      snippets,
      meta: {
        boardFound: true,
        ats: board.ats,
        boardSlug: board.slug,
        jobCount: postings.length,
        signals: signals.map((s) => ({
          type: s.signalType,
          strength: s.strength,
          title: s.title,
          url: s.url,
          evidence: s.evidence,
        })),
        extraFlags,
      },
    };
  } catch (err) {
    return {
      pack,
      ok: false,
      error: err instanceof Error ? err.message : "careers pack failed",
      snippets: [],
    };
  }
}
