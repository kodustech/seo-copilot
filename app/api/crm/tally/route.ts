import { NextResponse } from "next/server";

import { getSupabaseServiceClient } from "@/lib/supabase-server";
import {
  fromTallyWebhook,
  handleTrialSubmission,
  verifyTallySignature,
} from "@/lib/crm-trial-requests";

export const maxDuration = 60;

// ---------------------------------------------------------------------------
// Tally webhook for the self-hosted trial form (GxED1z). Configure it in Tally
// with a signing secret equal to TALLY_SIGNING_SECRET:
//
//   Tally → form → Integrations → Webhooks → https://<app>/api/crm/tally
//
// Tally waits 10 s for a 2xx and otherwise retries (5 min, 30 min, 1 h, 6 h,
// 1 day), so a failure answers 5xx on purpose and a skip answers 200: another
// form or a partial will never turn into a request worth retrying.
// ---------------------------------------------------------------------------
export async function POST(req: Request) {
  const secret = process.env.TALLY_SIGNING_SECRET;
  // Read as text: the signature is over the body Tally sent.
  const rawBody = await req.text();
  if (!secret || !verifyTallySignature(rawBody, req.headers.get("tally-signature"), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Signed but unreadable (not JSON, or no submissionId/formId to key it on)
  // answers a skip, not a 4xx: Tally retries anything but 2xx, and a retry
  // re-sends the same body, which can never parse differently.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    payload = null;
  }
  const submission = payload == null ? null : fromTallyWebhook(payload);
  if (!submission) {
    console.warn("[crm/tally] skipped a signed delivery that is not a keyable form response");
    return NextResponse.json({ ok: true, action: "skipped", reason: "unkeyable" }, { status: 200 });
  }

  try {
    // Service-role client bypasses RLS — Tally is not an authed user.
    const client = getSupabaseServiceClient();
    const outcome = await handleTrialSubmission(client, submission, { apply: true });
    // Tally keeps the response in its delivery log, so it gets the outcome
    // and not the answers.
    return NextResponse.json(
      {
        ok: true,
        action: outcome.action,
        reason: outcome.reason ?? null,
        companyId: outcome.companyId,
      },
      { status: outcome.action === "created" ? 201 : 200 },
    );
  } catch (err) {
    console.error("[crm/tally] error:", err instanceof Error ? err.message : String(err));
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to record trial request" },
      { status: 500 },
    );
  }
}
