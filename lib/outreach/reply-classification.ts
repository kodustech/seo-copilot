import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getModel } from "@/lib/ai/provider";
import { isBounceInbound } from "@/lib/outreach/inbox";

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

  if (isBounceInbound({ fromEmail: from, subject, snippet })) {
    return { reply_class: "bounce", reason: "Matched bounce/DSN heuristics." };
  }

  const haystack = `${subject ?? ""} ${snippet ?? ""}`.toLowerCase();
  const OOO = [
    "out of office",
    "outofoffice",
    "automatic reply",
    "auto-reply",
    "autoreply",
    "resposta automática",
    "fora do escritório",
    "estou de férias",
    "on annual leave",
    "on parental leave",
  ];
  if (OOO.some((k) => haystack.includes(k))) {
    return { reply_class: "auto_reply", reason: "Out-of-office autoresponder." };
  }

  return null;
}

export type ClassifyResult = {
  scanned: number;
  classified: number;
  byRule: number;
  byModel: number;
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
      "id, subject, snippet, contact_name, company_name, last_inbound_at, channel",
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
  } catch (err) {
    result.failed++;
    const msg = err instanceof Error ? err.message : String(err);
    if (result.errors.length < 5) {
      result.errors.push(`${thread.id}: ${msg}`);
    }
    console.error("[reply-classification] failed", thread.id, msg);
  }
}
