/**
 * Replays completed submissions of the self-hosted trial form (Tally GxED1z)
 * into the CRM, through the same handler the webhook uses. For the requests
 * that came in before the webhook existed; safe to re-run, since a submission
 * already recorded is skipped.
 *
 * Dry-run by default: prints what each submission would match or create, and
 * the answers read from it, and writes nothing.
 *   npx tsx --env-file=.env scripts/replay-tally-trials.ts
 *   npx tsx --env-file=.env scripts/replay-tally-trials.ts --since 2026-09-01
 *   npx tsx --env-file=.env scripts/replay-tally-trials.ts --apply
 *
 * Needs TALLY_API_KEY (Tally → Settings → API keys) plus the Supabase service
 * role. --since defaults to 2026-08-01, the start of what #263 covers.
 */
import {
  TRIAL_FORM_ID,
  fromTallyApi,
  handleTrialSubmission,
  type TrialSubmission,
} from "../lib/crm-trial-requests";
import { getSupabaseServiceClient } from "../lib/supabase-server";

const APPLY = process.argv.includes("--apply");
const sinceArg = process.argv.indexOf("--since");
const SINCE = sinceArg > 0 ? process.argv[sinceArg + 1] : "2026-08-01";
const MAX_PAGES = 50;

async function fetchSubmissions(apiKey: string): Promise<TrialSubmission[]> {
  const out: TrialSubmission[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = new URL(`https://api.tally.so/forms/${TRIAL_FORM_ID}/submissions`);
    url.searchParams.set("filter", "completed");
    url.searchParams.set("startDate", new Date(`${SINCE}T00:00:00Z`).toISOString());
    url.searchParams.set("limit", "100");
    url.searchParams.set("page", String(page));
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Tally API ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as {
      hasMore?: boolean;
      questions?: unknown[];
      submissions?: unknown[];
    };
    for (const raw of body.submissions ?? []) {
      const submission = fromTallyApi(raw, body.questions);
      if (submission) out.push(submission);
      else console.warn("Unreadable submission, skipped:", JSON.stringify(raw).slice(0, 200));
    }
    if (!body.hasMore) break;
  }
  // Oldest first, like they arrived: when two requests resolve to one new
  // account, the first creates it and the second matches it.
  return out.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
}

async function main() {
  const apiKey = process.env.TALLY_API_KEY;
  if (!apiKey) throw new Error("TALLY_API_KEY is not set");
  if (Number.isNaN(Date.parse(`${SINCE}T00:00:00Z`))) throw new Error(`Bad --since: ${SINCE}`);

  const submissions = await fetchSubmissions(apiKey);
  console.log(
    `${submissions.length} completed submissions of ${TRIAL_FORM_ID} since ${SINCE} — ${APPLY ? "APPLYING" : "dry run"}\n`,
  );
  // The label table in lib/crm-trial-requests.ts is checked against these.
  const labels = new Set(submissions.flatMap((s) => s.fields.map((f) => `${f.hidden ? "[hidden] " : ""}${f.label}`)));
  console.log(`Form labels seen: ${[...labels].join(" | ")}\n`);

  const client = getSupabaseServiceClient();
  const tally: Record<string, number> = {};
  for (const submission of submissions) {
    const o = await handleTrialSubmission(client, submission, { apply: APPLY });
    const key = o.reason ? `${o.action}:${o.reason}` : o.action;
    tally[key] = (tally[key] ?? 0) + 1;
    const target =
      o.action === "matched"
        ? `→ ${o.companyName} (${o.companyId}) by ${o.matchedBy}`
        : o.action === "created"
          ? `→ new account "${o.companyName}"`
          : `(${o.reason}${o.companyId ? `, ${o.companyId}` : ""})`;
    const flip =
      o.previousDeployment !== undefined ? ` · deployment ${o.previousDeployment ?? "null"} → self_hosted` : "";
    console.log(`${submission.submittedAt.slice(0, 10)} ${submission.submissionId} ${o.action} ${target}${flip}`);
    if (o.answers) console.log(`    ${JSON.stringify(o.answers)}`);
  }

  console.log(`\n${JSON.stringify(tally)}`);
  if (!APPLY) {
    console.log(
      "Dry run: nothing written. Two requests from the same new company both read as `created` here; with --apply the second matches the first.",
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
