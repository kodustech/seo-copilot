import type { SupabaseClient } from "@supabase/supabase-js";

import { HUMAN_REPLY_CLASSES, type ReplyClass } from "@/lib/outreach/reply-classification";

/**
 * Outbound metrics.
 *
 * All aggregation happens in `public.outbound_metrics(...)` (see migration
 * 20260805000000_outbound_metrics.sql), which returns raw counts. Rates are
 * derived here so division-by-zero and rounding live in one place, and so the
 * denominators are visible in code rather than buried in SQL.
 *
 * Open and click rate are deliberately absent: nothing in the sender adds a
 * tracking pixel or rewrites links, and with Apple MPP an open rate would be
 * noise anyway. Reply rate is the honest signal.
 */

export type OutboundVolume = {
  emails_sent: number;
  linkedin_sent: number;
  auto_sent: number;
  semi_sent: number;
  total_sent: number;
  contacts_touched: number;
  tasks_failed: number;
  tasks_skipped: number;
};

export type OutboundEnrollment = {
  created: number;
  from_research: number;
  from_outreach: number;
  from_manual: number;
  active_now: number;
};

export type OutboundFunnel = {
  contacted: number;
  replied: number;
  bounced: number;
  failed: number;
  completed_no_reply: number;
  in_flight: number;
  cancelled: number;
};

export type OutboundStepRow = {
  position: number;
  sent: number;
  contacts: number;
  replies: number;
  positive: number;
};

export type OutboundSequenceRow = {
  sequence_id: string;
  name: string;
  status: string;
  sent: number;
  contacts: number;
  replies: number;
  positive: number;
  bounces: number;
};

export type OutboundDailyRow = {
  date: string;
  sent: number;
  replies: number;
  positive: number;
  bounces: number;
};

export type OutboundSpeed = {
  samples: number;
  median_hours: number | null;
  p90_hours: number | null;
};

export type OutboundPipeline = {
  accounts_total: number;
  created_in_window: number;
  by_status: Record<string, number>;
  entered_in_window: Record<string, number>;
  arr_won: number;
  arr_open: number;
};

export type OutboundMailbox = {
  id: string;
  label: string;
  from_email: string;
  enabled: boolean;
  daily_cap: number;
  sent_today: number;
  last_sent_at: string | null;
  last_test_ok: boolean | null;
};

export type OutboundHygiene = {
  ready_overdue: Record<string, number>;
  ready_oldest_hours: number | null;
  scheduled_overdue: number;
  stalled_enrollments: number;
  enrollments_failed: number;
  unclassified_threads: number;
  unmatched_threads: number;
  mailboxes: OutboundMailbox[];
  contact_coverage: {
    people_total: number;
    with_email: number;
    verified: number;
    risky_or_invalid: number;
  };
};

export type OutboundMetricsRaw = {
  since: string;
  until: string;
  sequence_id: string | null;
  volume: OutboundVolume;
  enrollment: OutboundEnrollment;
  funnel: OutboundFunnel;
  reply_classes: Partial<Record<ReplyClass | "unclassified", number>>;
  by_step: OutboundStepRow[];
  by_sequence: OutboundSequenceRow[];
  daily: OutboundDailyRow[];
  speed: OutboundSpeed;
  pipeline: OutboundPipeline;
  hygiene: OutboundHygiene;
};

export type OutboundRates = {
  /** Cohort replied ÷ contacted. The headline number. */
  replyRate: number | null;
  /** Cohort bounced ÷ contacted. Deliverability health; >2% is a problem. */
  bounceRate: number | null;
  /** Positive-class replies ÷ contacted. What actually moves pipeline. */
  positiveRate: number | null;
  /** Positive ÷ all human replies. Quality of the list and the copy. */
  positiveShareOfReplies: number | null;
  /** Failed tasks ÷ (sent + failed). Technical send errors, not bounces. */
  sendFailureRate: number | null;
  /** Share of window's inbound threads still missing a label. */
  unclassifiedShare: number | null;
};

export type OutboundMetrics = OutboundMetricsRaw & {
  rates: OutboundRates;
  /** Human replies in the window (everything except bounces and autoresponders). */
  humanReplies: number;
  positiveReplies: number;
  /** Warnings worth surfacing above the numbers. */
  alerts: OutboundAlert[];
};

export type OutboundAlert = {
  level: "warn" | "danger";
  message: string;
};

function rate(numerator: number, denominator: number): number | null {
  if (!denominator) return null;
  return numerator / denominator;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export type OutboundMetricsOptions = {
  since: Date | string;
  until?: Date | string;
  sequenceId?: string | null;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function fetchOutboundMetrics(
  client: SupabaseClient,
  opts: OutboundMetricsOptions,
): Promise<OutboundMetrics> {
  const { data, error } = await client.rpc("outbound_metrics", {
    p_since: toIso(opts.since),
    p_until: toIso(opts.until ?? new Date()),
    p_sequence_id: opts.sequenceId ?? null,
  });

  if (error) {
    // Surface the real cause. Silently returning zeros would read as "outbound
    // did nothing this week", which is a very different (and wrong) story.
    throw new Error(`outbound_metrics failed: ${error.message}`);
  }

  return decorate(data as OutboundMetricsRaw);
}

/** Adds derived rates and alerts to the raw RPC payload. */
export function decorate(raw: OutboundMetricsRaw): OutboundMetrics {
  const classes = raw.reply_classes ?? {};
  const humanReplies = HUMAN_REPLY_CLASSES.reduce(
    (sum, key) => sum + num(classes[key]),
    0,
  );
  const positiveReplies = num(classes.positive);
  const unclassified = num(classes.unclassified);
  const allThreads = Object.values(classes).reduce(
    (sum: number, n) => sum + num(n),
    0,
  );

  const funnel = raw.funnel ?? ({} as OutboundFunnel);
  const volume = raw.volume ?? ({} as OutboundVolume);
  const contacted = num(funnel.contacted);

  const rates: OutboundRates = {
    replyRate: rate(num(funnel.replied), contacted),
    bounceRate: rate(num(funnel.bounced), contacted),
    positiveRate: rate(positiveReplies, contacted),
    positiveShareOfReplies: rate(positiveReplies, humanReplies),
    sendFailureRate: rate(
      num(volume.tasks_failed),
      num(volume.total_sent) + num(volume.tasks_failed),
    ),
    unclassifiedShare: rate(unclassified, allThreads),
  };

  return {
    ...raw,
    rates,
    humanReplies,
    positiveReplies,
    alerts: buildAlerts(raw, rates),
  };
}

function buildAlerts(
  raw: OutboundMetricsRaw,
  rates: OutboundRates,
): OutboundAlert[] {
  const alerts: OutboundAlert[] = [];
  const hygiene = raw.hygiene ?? ({} as OutboundHygiene);

  // Deliverability first — a burning domain invalidates every other number.
  if (rates.bounceRate !== null && rates.bounceRate > 0.05) {
    alerts.push({
      level: "danger",
      message: `Bounce rate at ${(rates.bounceRate * 100).toFixed(1)}% — above 5%. Pause sending and clean the list before the domain gets flagged.`,
    });
  } else if (rates.bounceRate !== null && rates.bounceRate > 0.02) {
    alerts.push({
      level: "warn",
      message: `Bounce rate at ${(rates.bounceRate * 100).toFixed(1)}% — above the 2% comfort line. Verify emails before enrolling.`,
    });
  }

  const readyOverdue = Object.values(hygiene.ready_overdue ?? {}).reduce(
    (sum: number, n) => sum + num(n),
    0,
  );
  if (readyOverdue > 0) {
    const oldest = hygiene.ready_oldest_hours;
    alerts.push({
      level: readyOverdue > 25 || (oldest ?? 0) > 72 ? "danger" : "warn",
      message: `${readyOverdue} task${readyOverdue === 1 ? "" : "s"} waiting in the manual queue${
        oldest ? `, oldest ${Math.round(oldest)}h` : ""
      }. Semi steps only move when a human sends them.`,
    });
  }

  if (num(hygiene.scheduled_overdue) > 0) {
    alerts.push({
      level: "danger",
      message: `${hygiene.scheduled_overdue} scheduled send${
        num(hygiene.scheduled_overdue) === 1 ? " is" : "s are"
      } more than 2h past due — the sequence cron is likely not running.`,
    });
  }

  if (num(hygiene.stalled_enrollments) > 0) {
    alerts.push({
      level: "warn",
      message: `${hygiene.stalled_enrollments} active enrollment${
        num(hygiene.stalled_enrollments) === 1 ? "" : "s"
      } with a next run over 24h in the past.`,
    });
  }

  if (rates.unclassifiedShare !== null && rates.unclassifiedShare > 0.3) {
    alerts.push({
      level: "warn",
      message: `${Math.round(rates.unclassifiedShare * 100)}% of this window's replies have no classification yet — positive-reply numbers are understated.`,
    });
  }

  for (const box of hygiene.mailboxes ?? []) {
    if (!box.enabled) continue;
    if (box.daily_cap > 0 && box.sent_today >= box.daily_cap) {
      alerts.push({
        level: "warn",
        message: `${box.from_email} hit its daily cap (${box.sent_today}/${box.daily_cap}).`,
      });
    }
    if (box.last_test_ok === false) {
      alerts.push({
        level: "danger",
        message: `${box.from_email} failed its last connection test.`,
      });
    }
  }

  return alerts;
}
