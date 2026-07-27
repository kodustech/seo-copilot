import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Workspace-wide outreach schedule.
 *
 * The sequence engine is a pure "delay in hours" model, so without this every
 * step lands on whatever wall-clock moment the previous one completed —
 * including Saturday 03:00. This narrows both sides of the engine:
 *
 *   1. scheduling — the next task's `scheduled_for` rolls forward to a sending day
 *   2. sending    — the cron refuses to send / release on a non-sending day
 */
export type OutreachSendingWindow = {
  /** 0 = Sunday … 6 = Saturday (matches JS `Date#getDay`). */
  sendingDays: number[];
  /** IANA timezone used to resolve which weekday a timestamp falls on. */
  timezone: string;
};

export const DEFAULT_SENDING_WINDOW: OutreachSendingWindow = {
  sendingDays: [1, 2, 3, 4, 5],
  timezone: "America/Sao_Paulo",
};

export const WEEKDAY_LABELS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = 60_000;

let cache: { value: OutreachSendingWindow; at: number } | null = null;

/** Drop the in-process cache (called after a write). */
export function clearSendingWindowCache(): void {
  cache = null;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function normalizeSendingDays(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [...DEFAULT_SENDING_WINDOW.sendingDays];
  const days = Array.from(
    new Set(
      raw
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    ),
  ).sort((a, b) => a - b);
  // Fail open: an empty set would mean "never send" and would spin
  // `nextSendingSlot` forever. Treat it as unconfigured.
  return days.length > 0 ? days : [...DEFAULT_SENDING_WINDOW.sendingDays];
}

/**
 * Read the workspace schedule. Cached for 60s — `processDueSequenceTasks`
 * calls this per tick and we don't want a round trip per task.
 */
export async function getSendingWindow(
  client: SupabaseClient,
): Promise<OutreachSendingWindow> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const { data, error } = await client
    .from("outreach_settings")
    .select("sending_days, timezone")
    .eq("id", "default")
    .maybeSingle();

  if (error) {
    // Table not migrated yet (or not in the schema cache): fall back to the
    // default Mon–Fri window rather than breaking enrollment and the cron.
    const missingTable =
      error.code === "42P01" ||
      error.code === "PGRST205" ||
      /outreach_settings/i.test(error.message ?? "");
    if (!missingTable) throw new Error(error.message);
    console.warn(
      "[outreach] outreach_settings unavailable, using default Mon–Fri window:",
      error.message,
    );
    cache = { value: { ...DEFAULT_SENDING_WINDOW }, at: Date.now() };
    return cache.value;
  }

  const tz = (data?.timezone as string | undefined) ?? "";
  const value: OutreachSendingWindow = {
    sendingDays: normalizeSendingDays(data?.sending_days),
    timezone: isValidTimezone(tz) ? tz : DEFAULT_SENDING_WINDOW.timezone,
  };
  cache = { value, at: Date.now() };
  return value;
}

export async function updateSendingWindow(
  client: SupabaseClient,
  input: { sendingDays?: number[]; timezone?: string; updatedByEmail?: string | null },
): Promise<OutreachSendingWindow> {
  const patch: Record<string, unknown> = {
    id: "default",
    updated_at: new Date().toISOString(),
  };

  if (input.sendingDays !== undefined) {
    const days = Array.from(
      new Set(
        input.sendingDays
          .map((d) => Number(d))
          .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
      ),
    ).sort((a, b) => a - b);
    if (days.length === 0) {
      throw new Error("Pick at least one sending day");
    }
    patch.sending_days = days;
  }

  if (input.timezone !== undefined) {
    if (!isValidTimezone(input.timezone)) {
      throw new Error(`Unknown timezone: ${input.timezone}`);
    }
    patch.timezone = input.timezone;
  }

  if (input.updatedByEmail !== undefined) {
    patch.updated_by_email = input.updatedByEmail;
  }

  const { data, error } = await client
    .from("outreach_settings")
    .upsert(patch, { onConflict: "id" })
    .select("sending_days, timezone")
    .single();
  if (error) throw new Error(error.message);

  clearSendingWindowCache();
  return {
    sendingDays: normalizeSendingDays(data.sending_days),
    timezone: (data.timezone as string) ?? DEFAULT_SENDING_WINDOW.timezone,
  };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Weekday (0-6) that `date` falls on *in the given timezone*, not in UTC. */
export function weekdayInTimezone(date: Date, timezone: string): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  }).format(date);
  const idx = WEEKDAY_INDEX[label];
  return idx === undefined ? date.getUTCDay() : idx;
}

export function isSendingDay(
  date: Date,
  window: OutreachSendingWindow,
): boolean {
  return window.sendingDays.includes(
    weekdayInTimezone(date, window.timezone),
  );
}

/**
 * Roll `date` forward to the next allowed weekday, preserving time of day.
 * Returns `date` untouched when it already lands on a sending day.
 */
export function nextSendingSlot(
  date: Date,
  window: OutreachSendingWindow,
): Date {
  let candidate = date;
  // At most 6 hops: `sendingDays` is guaranteed non-empty by normalization.
  for (let i = 0; i < 7; i++) {
    if (isSendingDay(candidate, window)) return candidate;
    candidate = new Date(candidate.getTime() + DAY_MS);
  }
  return date;
}

export function describeSendingDays(days: number[]): string {
  if (days.length === 7) return "Every day";
  if (days.length === 0) return "No days";
  const sorted = [...days].sort((a, b) => a - b);
  if (
    sorted.length === 5 &&
    sorted.every((d, i) => d === i + 1)
  ) {
    return "Mon–Fri";
  }
  return sorted.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(", ");
}
