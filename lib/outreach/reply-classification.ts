import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getModel } from "@/lib/ai/provider";
import { isAutoReplyInbound, isBounceInbound } from "@/lib/outreach/inbox";

/**
 * Reply classification.
 *
 * A raw reply count is not a funnel metric: out-of-office, mailer-daemon and
 * "remove me" all land in the same bucket as "let's book a call". Every thread
 * with inbound mail gets a label so the dashboard can separate the reply that
 * means something from the reply that means nothing.
 *
 * Runs after the Gmail sync (see /api/cron/outreach-inbox) rather than inside
 * it: an LLM outage must not stop reply detection or the cadence from halting.
 */

export const REPLY_CLASSES = [
  "positive",
  "neutral",
  "not_now",
  "not_interested",
  "referral",
  "auto_reply",
  "unsubscribe",
  "bounce",
] as const;

export type ReplyClass = (typeof REPLY_CLASSES)[number];

/** Classes that mean a human on the other side engaged with the pitch. */
export const HUMAN_REPLY_CLASSES: ReplyClass[] = [
  "positive",
  "neutral",
  "not_now",
  "not_interested",
  "referral",
];

const ClassificationSchema = z.object({
  reply_class: z.enum(REPLY_CLASSES),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(280),
});

const SYSTEM = `You classify inbound replies to B2B cold outreach emails.

Return exactly one class:

- positive: wants to talk, asks for a call/demo/pricing, asks a buying question, or accepts a meeting.
- neutral: a human answered but gave no signal either way ("thanks", "got it", "send me info" with no intent stated).
- not_now: interested but explicitly deferred to a later date ("circle back in Q3", "revisit next year").
- not_interested: explicit no, "not a fit", "we already use X and are happy", "stop pitching".
- referral: redirects you to a different person or team, without answering for themselves.
- auto_reply: out-of-office, vacation autoresponder, ticket acknowledgement, "your message was received" bot.
- unsubscribe: asks to be removed from the list, opt-out, GDPR/LGPD deletion request, threatens spam report.
- bounce: delivery status notification, mailer-daemon, "address not found", mailbox full.

Rules:
- Judge only the INBOUND message. Our own sent copy is context, never the thing being classified.
- An out-of-office that also names a colleague is auto_reply, not referral: nobody read the pitch.
- "Send me more info" is neutral unless they state interest or ask something specific.
- A polite brush-off ("we're all set, thanks") is not_interested, not neutral.
- When two classes fit, prefer the one that stops the cadence (unsubscribe > not_interested > neutral).
- confidence is your own certainty, 0 to 1. Below 0.5 means the text was too thin to tell.
- reason: one short sentence, quoting the phrase that decided it.`;

type ThreadRow = {
  id: string;
  enrollment_id: string | null;
  subject: string | null;
  snippet: string | null;
  contact_name: string | null;
  company_name: string | null;
  last_inbound_at: string | null;
  channel: string | null;
};

type MessageRow = {
  direction: string;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  snippet: string | null;
  internal_date: string | null;
};

function clean(text: string | null | undefined, max: number): string {
  if (!text) return "";
  return text
    // Strip quoted history so the model classifies the new text, not our pitch.
    .replace(/^\s*(>|On .+ wrote:).*$/gm, "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/**
 * Cheap deterministic pass. Bounces and one-line autoresponders are a fixed
 * shape — spending an LLM call on them is waste, and `isBounceInbound` is
 * already the rule the cadence trusts to stop on a hard bounce.
 */
function ruleClassify(
  thread: ThreadRow,
  lastInbound: MessageRow | null,
): { reply_class: ReplyClass; reason: string } | null {
  const from = lastInbound?.from_email ?? null;
  const subject = lastInbound?.subject ?? thread.subject ?? null;
  const snippet = lastInbound?.snippet ?? thread.snippet ?? null;

  const signals = { fromEmail: from, subject, snippet };

  if (isBounceInbound(signals)) {
    return { reply_class: "bounce", reason: "Matched bounce/DSN heuristics." };
  }

  // Same predicate the sync stops on, so a thread cannot be an autoresponder
  // here and a reply there. Headers are unavailable on a stored message, so
  // this is the text fallback of that check.
  if (isAutoReplyInbound(signals)) {
    return { reply_class: "auto_reply", reason: "Out-of-office autoresponder." };
  }

  return null;
}

export type ClassifyResult = {
  scanned: number;
  classified: number;
  byRule: number;
  byModel: number;
  /** Enrollments whose state was corrected once the class was known. */
  reconciled: number;
  /** New inbound landed mid-classification; the label was dropped, not saved. */
  skippedStale: number;
  failed: number;
  errors: string[];
};

/**
 * Classify threads that have no label yet, or whose label predates the newest
 * inbound message (they replied again and the old label may no longer hold).
 */
export async function classifyPendingReplyThreads(
  client: SupabaseClient,
  opts?: { limit?: number; force?: boolean },
): Promise<ClassifyResult> {
  const limit = Math.min(Math.max(opts?.limit ?? 40, 1), 200);
  const result: ClassifyResult = {
    scanned: 0,
    classified: 0,
    byRule: 0,
    byModel: 0,
    reconciled: 0,
    skippedStale: 0,
    failed: 0,
    errors: [],
  };

  // The queue is simply "reply_class IS NULL": a DB trigger clears the label
  // whenever a newer inbound message lands, so re-classification needs no
  // extra bookkeeping here. `force` re-labels the most recent threads instead.
  let query = client
    .from("outreach_reply_threads")
    .select(
      "id, enrollment_id, subject, snippet, contact_name, company_name, last_inbound_at, channel",
    )
    .not("last_inbound_at", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(limit);

  if (!opts?.force) query = query.is("reply_class", null);

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  const candidates = (data ?? []) as unknown as ThreadRow[];
  result.scanned = candidates.length;

  // Sequential would blow the cron's 120s budget at ~2s per LLM call. Four at
  // a time keeps a 40-thread batch under ~25s without hammering rate limits.
  const CONCURRENCY = 4;
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const thread = candidates[index];
      await classifyOne(client, thread, result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () =>
      worker(),
    ),
  );

  return result;
}

/**
 * Reconcile threads that were classified before the class had any effect.
 *
 * The queue in `classifyPendingReplyThreads` is "reply_class IS NULL", so a
 * thread already labelled auto_reply never comes back through it — including
 * every out-of-office that stopped a cadence and promoted an account while the
 * label was write-only. This walks those labels and applies them.
 *
 * Self-limiting: each pass only finds enrollments still in the wrong state, so
 * once the backlog is drained it costs one query per cron tick and does
 * nothing. Left in place rather than run as a one-off script because the same
 * drift reappears whenever a label changes.
 */
export async function reconcileClassifiedReplyThreads(
  client: SupabaseClient,
  opts?: { limit?: number },
): Promise<{ scanned: number; reconciled: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);

  const { data, error } = await client
    .from("outreach_reply_threads")
    .select("id, enrollment_id, reply_class, reply_class_reason")
    .in("reply_class", ["auto_reply", "bounce"])
    .not("enrollment_id", "is", null)
    .order("last_inbound_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const threads = (data ?? []) as {
    id: string;
    enrollment_id: string;
    reply_class: ReplyClass;
    reply_class_reason: string | null;
  }[];
  if (!threads.length) return { scanned: 0, reconciled: 0 };

  // Only enrollments still marked `replied` are wrong. Everything else either
  // never got there or has already been corrected.
  const { data: stale, error: enrollErr } = await client
    .from("outreach_enrollments")
    .select("id")
    .eq("status", "replied")
    .in(
      "id",
      threads.map((t) => t.enrollment_id),
    );
  if (enrollErr) throw new Error(enrollErr.message);

  const staleIds = new Set((stale ?? []).map((r) => r.id as string));
  if (!staleIds.size) return { scanned: threads.length, reconciled: 0 };

  let reconciled = 0;
  for (const thread of threads) {
    if (!staleIds.has(thread.enrollment_id)) continue;

    const { count } = await client
      .from("outreach_reply_messages")
      .select("id", { count: "exact", head: true })
      .eq("thread_id", thread.id)
      .eq("direction", "inbound");

    const ok = await reconcileEnrollmentForReplyClass(client, {
      threadId: thread.id,
      enrollmentId: thread.enrollment_id,
      label: thread.reply_class,
      inboundCount: count ?? 1,
      reason: thread.reply_class_reason ?? "Reconciled from stored class",
    });
    if (ok) reconciled++;
  }

  return { scanned: threads.length, reconciled };
}

/** CRM demotion is a side effect of reconciling — never a reason to fail it. */
async function demoteQuietly(
  client: SupabaseClient,
  enrollmentId: string,
  reason: "auto_reply" | "bounce",
): Promise<void> {
  try {
    const { demoteReplyPromotion } = await import("@/lib/crm");
    await demoteReplyPromotion(client, enrollmentId, { reason });
  } catch (err) {
    console.warn("[reply-classification] CRM demote failed", enrollmentId, err);
  }
}

/**
 * Does any *other* thread on this enrollment carry inbound mail that might be
 * from a person?
 *
 * The guard in front of undoing a stop. `replied` records that somebody
 * answered, not which thread they answered on, so neither an autoresponder nor
 * a bounce can be read as "the reply was fake" while another conversation on
 * the enrollment could be the real one — the person answers on one thread and
 * their vacation agent, or a DSN for a second address, lands on another.
 *
 * Threads already classified as bounce or auto_reply do not count: they are
 * known to be machine-generated, and counting them would make two bounces on
 * one enrollment block each other forever. Everything else counts, including
 * unclassified — being left stopped is recoverable by hand, and a cadence
 * resuming into a live conversation is not.
 */
async function enrollmentHasOtherLiveThread(
  client: SupabaseClient,
  enrollmentId: string,
  threadId: string,
): Promise<boolean> {
  const { data, error } = await client
    .from("outreach_reply_threads")
    .select("id")
    .eq("enrollment_id", enrollmentId)
    .neq("id", threadId)
    .not("last_inbound_at", "is", null)
    .or("reply_class.is.null,reply_class.not.in.(bounce,auto_reply)")
    .limit(1);
  // On a read failure, assume the risky case and leave the enrollment alone.
  if (error) return true;
  return (data ?? []).length > 0;
}

/**
 * Apply a freshly decided class to the enrollment behind the thread.
 *
 * The sync has to act on an inbound message the moment it lands — it cannot
 * wait for an LLM call, and a cadence that keeps sending into a real reply is
 * worse than one that stops early. So it takes the cautious reading and this
 * runs afterwards to correct it. No detector is going to be perfect; what makes
 * that survivable is that the decision is reversible.
 *
 * Imports are dynamic to keep the cycle (inbox → sequences → crm → this) out of
 * module init, matching how sequences.ts reaches for crm.
 */
async function reconcileEnrollmentForReplyClass(
  client: SupabaseClient,
  input: {
    threadId: string;
    enrollmentId: string | null;
    label: ReplyClass;
    inboundCount: number;
    reason: string;
  },
): Promise<boolean> {
  const { threadId, enrollmentId, label, inboundCount, reason } = input;
  if (!enrollmentId) return false;

  try {
    const {
      deferEnrollmentForAutoReply,
      markEnrollmentBounced,
      markEnrollmentReplied,
    } = await import("@/lib/outreach/sequences");

    if (label === "bounce") {
      // markEnrollmentBounced overwrites `replied`, and the demote below drops
      // the account back to lead. Both are wrong if the reply that set that
      // state came from a different thread — a DSN for one address does not
      // undo a person answering on another.
      if (await enrollmentHasOtherLiveThread(client, enrollmentId, threadId)) {
        return false;
      }
      const marked = await markEnrollmentBounced(client, enrollmentId, {
        source: "reply_classifier",
        reason,
      });
      if (!marked.updated) return false;
      // A DSN the sync's detector missed took the reply path first, so the
      // account was promoted to engaged/high on a message from a mail server.
      // Marking the enrollment bounced without this leaves that promotion
      // standing.
      await demoteQuietly(client, enrollmentId, "bounce");
      return true;
    }

    if (label === "auto_reply") {
      // Only when the autoresponder is the whole conversation. If a human wrote
      // earlier in the thread, the enrollment stopped for that reply and the
      // out-of-office arriving later changes nothing.
      if (inboundCount > 1) return false;
      // ...and only when it is the whole conversation on *every* thread.
      if (await enrollmentHasOtherLiveThread(client, enrollmentId, threadId)) {
        return false;
      }
      const deferred = await deferEnrollmentForAutoReply(client, enrollmentId, {
        source: "reply_classifier",
        reason,
        revertReplied: true,
      });
      if (!deferred.updated) return false;
      await demoteQuietly(client, enrollmentId, "auto_reply");
      return true;
    }

    if (HUMAN_REPLY_CLASSES.includes(label)) {
      // Idempotent: the enrollment is almost always already `replied`. What
      // this adds is the revive the sync withheld — now that a human is known
      // to have answered, an excluded account may come back.
      const marked = await markEnrollmentReplied(client, enrollmentId, {
        source: "reply_classifier",
        revive: true,
      });
      return marked.updated;
    }

    // unsubscribe: the cadence must stop, but nobody engaged and an excluded
    // account being asked to be left alone stays excluded.
    if (label === "unsubscribe") {
      const marked = await markEnrollmentReplied(client, enrollmentId, {
        source: "reply_classifier",
        revive: false,
      });
      return marked.updated;
    }

    return false;
  } catch (err) {
    // Never fail classification over reconciliation: the label is saved, and
    // the thread should not come back through the queue for this.
    console.warn("[reply-classification] reconcile failed", enrollmentId, err);
    return false;
  }
}

async function classifyOne(
  client: SupabaseClient,
  thread: ThreadRow,
  result: ClassifyResult,
): Promise<void> {
  try {
    const { data: msgs } = await client
      .from("outreach_reply_messages")
      .select(
        "direction, from_email, subject, body_text, snippet, internal_date",
      )
      .eq("thread_id", thread.id)
      .order("internal_date", { ascending: true, nullsFirst: true });

    const messages = (msgs ?? []) as MessageRow[];
    const inbound = messages.filter((m) => m.direction === "inbound");
    const lastInbound = inbound.length ? inbound[inbound.length - 1] : null;

    // No inbound message body at all → nothing to classify yet.
    if (!lastInbound && !thread.snippet) return;

    const ruled = ruleClassify(thread, lastInbound);
    let label: ReplyClass;
    let confidence: number;
    let reason: string;
    let model: string;

    if (ruled) {
      label = ruled.reply_class;
      confidence = 1;
      reason = ruled.reason;
      model = "rule";
      result.byRule++;
    } else {
      const ourLast = [...messages]
        .reverse()
        .find((m) => m.direction === "outbound_ours");

      const prompt = [
        `Contact: ${thread.contact_name ?? "unknown"}${
          thread.company_name ? ` at ${thread.company_name}` : ""
        }`,
        `Channel: ${thread.channel ?? "email"}`,
        `Subject: ${thread.subject ?? "(none)"}`,
        "",
        "--- WHAT WE SENT (context only) ---",
        clean(ourLast?.body_text ?? null, 1200) || "(not available)",
        "",
        "--- THEIR REPLY (classify this) ---",
        clean(lastInbound?.body_text ?? null, 3000) ||
          clean(lastInbound?.snippet ?? thread.snippet, 500) ||
          "(empty)",
      ].join("\n");

      const { object } = await generateObject({
        model: getModel(),
        schema: ClassificationSchema,
        system: SYSTEM,
        prompt,
      });

      label = object.reply_class;
      confidence = object.confidence;
      reason = object.reason.trim().slice(0, 280);
      model = process.env.AI_PROVIDER?.toLowerCase() || "kimi";
      result.byModel++;
    }

    // Freshness guard. The label was computed from the messages as they were
    // when this thread was read, and the LLM call takes seconds. If a sync
    // appended new inbound in the meantime, the reset trigger will not save
    // us: it only fires on updates that move `last_inbound_at`, and this write
    // does not. Matching on the snapshot value makes the write a no-op in that
    // case, and the thread stays in the unclassified queue for the next pass.
    const { data: updated, error: upErr } = await client
      .from("outreach_reply_threads")
      .update({
        reply_class: label,
        reply_class_confidence: confidence,
        reply_class_reason: reason,
        reply_class_model: model,
        reply_classified_at: new Date().toISOString(),
        reply_classified_inbound_at: thread.last_inbound_at,
      })
      .eq("id", thread.id)
      .eq("last_inbound_at", thread.last_inbound_at)
      .select("id");

    if (upErr) throw new Error(upErr.message);
    if (!updated?.length) {
      result.skippedStale++;
      return;
    }
    result.classified++;

    // The label is not just a metric. The sync had to decide what to do with
    // this thread before anyone knew what it said; now that we know, make the
    // enrollment agree.
    const reconciled = await reconcileEnrollmentForReplyClass(client, {
      threadId: thread.id,
      enrollmentId: thread.enrollment_id,
      label,
      inboundCount: inbound.length,
      reason,
    });
    if (reconciled) result.reconciled++;
  } catch (err) {
    result.failed++;
    const msg = err instanceof Error ? err.message : String(err);
    if (result.errors.length < 5) {
      result.errors.push(`${thread.id}: ${msg}`);
    }
    console.error("[reply-classification] failed", thread.id, msg);
  }
}
