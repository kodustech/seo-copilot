/**
 * Per-persona goals + progress. Goals live in content_config.goals so there's
 * no migration. Some are measurable now (weekly posts per channel, X followers
 * via the X API); others are qualitative guidance the persona works toward but
 * we can't put a number on yet (e.g. "get quoted by someone notable"). The
 * progress brief is injected into each shift so the persona actually steers
 * toward what it's behind on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { mergeContentConfig } from "@/lib/influencer/personas";
import type { Persona } from "@/lib/influencer/types";
import { getXFollowers } from "@/lib/influencer/x-metrics";

export type Goal = {
  type: "posts_per_week" | "followers" | "custom";
  channel?: string; // for posts_per_week
  handle?: string; // for followers (the X username)
  target?: number;
  label: string;
};

export type GoalProgress = Goal & {
  current: number | null; // null = not measurable right now
  onTrack: boolean | null; // null = qualitative / unmeasured
  detail: string;
};

export function getGoals(persona: Persona): Goal[] {
  const raw = persona.content_config.goals;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (g): g is Goal =>
      Boolean(g) && typeof g === "object" && typeof (g as Goal).label === "string",
  );
}

async function publishedThisWeek(
  client: SupabaseClient,
  personaId: string,
  platform: string,
  sinceIso: string,
): Promise<number> {
  const { data: chans } = await client
    .from("persona_channels")
    .select("id")
    .eq("persona_id", personaId)
    .eq("platform", platform);
  const ids = (chans ?? []).map((c) => c.id as string);
  if (!ids.length) return 0;
  const { count } = await client
    .from("persona_activities")
    .select("id", { count: "exact", head: true })
    .eq("persona_id", personaId)
    .in("channel_id", ids)
    .eq("status", "published")
    .gte("published_at", sinceIso);
  return count ?? 0;
}

/** Monday 00:00 UTC of the week `now` falls in — the weekly quota resets here. */
export function startOfIsoWeek(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  return d;
}

export async function computeProgress(
  client: SupabaseClient,
  persona: Persona,
  now: Date,
): Promise<GoalProgress[]> {
  const goals = getGoals(persona);
  // Calendar week, not a rolling 7-day window: the quota resets every Monday, so
  // a new week starts BEHIND and the persona feels the pressure to post again.
  const since = startOfIsoWeek(now).toISOString();
  const out: GoalProgress[] = [];

  for (const g of goals) {
    if (g.type === "posts_per_week" && g.channel) {
      const current = await publishedThisWeek(client, persona.id, g.channel, since);
      const target = g.target ?? 1;
      out.push({
        ...g,
        current,
        onTrack: current >= target,
        detail: `${current}/${target} published this week on ${g.channel}`,
      });
    } else if (g.type === "followers") {
      const current = g.handle ? await getXFollowers(g.handle) : null;
      const target = g.target ?? 0;
      out.push({
        ...g,
        current,
        onTrack: current == null ? null : current >= target,
        detail:
          current == null
            ? "follower count unavailable (X API credits/token)"
            : `${current}/${target} followers`,
      });
    } else {
      out.push({ ...g, current: null, onTrack: null, detail: g.label });
    }
  }

  return out;
}

/**
 * Coerce whatever the client sent into goals we are willing to store. Goals are
 * injected into every shift, so a malformed one is not a rendering bug, it is a
 * persona steering toward nonsense for a week before anyone notices. Anything
 * that does not survive this is dropped rather than repaired.
 */
export function normalizeGoals(raw: unknown): Goal[] {
  if (!Array.isArray(raw)) return [];
  const out: Goal[] = [];
  for (const item of raw) {
    // Cap on what is KEPT, not on what is examined: slicing first lets a few
    // malformed entries near the front starve valid goals further down.
    if (out.length >= 12) break;
    if (!item || typeof item !== "object") continue;
    const g = item as Record<string, unknown>;
    const label = typeof g.label === "string" ? g.label.trim().slice(0, 200) : "";
    if (!label) continue;

    const channel = typeof g.channel === "string" ? g.channel.trim() : "";
    const handle =
      typeof g.handle === "string" ? g.handle.trim().replace(/^@/, "") : "";

    // A target below 1 is not a goal, and the progress reading divides by it.
    const rawTarget = Number(g.target);
    const target =
      Number.isFinite(rawTarget) && rawTarget >= 1 ? Math.floor(rawTarget) : undefined;

    // Goals predate this validator: some were written by hand with no type at
    // all, and computeProgress reads them as qualitative. Defaulting those to
    // "custom" and then keeping only the fields "custom" uses would strip the
    // channel off a goal nobody touched, on the first save from anywhere. So
    // infer, and only infer a measurable type when the goal is actually
    // measurable — otherwise an incomplete one would be dropped rather than
    // left alone as it is today.
    const declared =
      g.type === "posts_per_week" || g.type === "followers" || g.type === "custom"
        ? g.type
        : undefined;
    // Infer only when the shape says one thing. A goal carrying BOTH a channel
    // and a handle is genuinely ambiguous, and picking either reading invents a
    // measurement that was never there: a typeless goal has always read as
    // qualitative, so leaving it that way loses nothing, while guessing wrong
    // marks it behind every week and steers the persona at the wrong number.
    const ambiguous = Boolean(channel && handle);
    const type: Goal["type"] =
      declared ??
      (ambiguous
        ? "custom"
        : channel && target
          ? "posts_per_week"
          : handle && target
            ? "followers"
            : "custom");

    const goal: Goal = { type, label };
    if (target) goal.target = target;

    if (type === "posts_per_week" && (!channel || !target)) continue; // would read "ongoing" forever while claiming a number
    if (type === "followers" && (!handle || !target)) continue;

    // Carried whatever the type is. computeProgress only reads each field for
    // its own type, so keeping them costs nothing and losing them is permanent.
    if (channel) goal.channel = channel;
    if (handle) goal.handle = handle;

    out.push(goal);
  }
  return out;
}

/** Replace the persona's goals. content_config is one jsonb column shared with
 *  cadence, language and the persona's own notes, so this merges rather than
 *  overwrites; mergeContentConfig re-reads immediately before writing. */
export async function setGoals(
  client: SupabaseClient,
  personaId: string,
  goals: Goal[],
): Promise<Goal[]> {
  await mergeContentConfig(client, personaId, { goals });
  return goals;
}

/** Text block injected into a shift so the persona works toward its goals. */
export function buildGoalsBrief(progress: GoalProgress[]): string {
  if (!progress.length) return "";
  const lines = progress.map((p) => {
    const mark =
      p.onTrack === true ? "on track" : p.onTrack === false ? "BEHIND" : "ongoing";
    return `- ${p.label} — ${p.detail} (${mark})`;
  });
  return [
    "YOUR GOALS AND WHERE YOU STAND:",
    ...lines,
    "Let what you're behind on shape this shift: if you're short on a channel's weekly quota, write for that channel now; if you're chasing followers or a notable mention, make this post genuinely worth sharing and engage the right people.",
  ].join("\n");
}

/**
 * A channel with a weekly quota that has published nothing this week, once the
 * week is far enough along that "it's early" no longer explains it.
 *
 * This is the failure the fleet cannot see from the inside. A persona saturating
 * one channel reports a busy shift every hour and looks healthy from every
 * angle, while a channel with a quota sits at zero for weeks — that is exactly
 * how the blog went 18 days without an article. Nobody was going to notice by
 * reading the activity feed; there was plenty of activity.
 */
const SILENT_AFTER_WEEK_FRACTION = 0.5;

export function silentChannels(
  progress: GoalProgress[],
  now: Date,
): { channel: string; target: number }[] {
  const weekStart = startOfIsoWeek(now).getTime();
  const elapsed = (now.getTime() - weekStart) / (7 * 24 * 60 * 60 * 1000);
  if (elapsed < SILENT_AFTER_WEEK_FRACTION) return [];
  return progress
    .filter((p) => p.type === "posts_per_week" && p.channel && p.current === 0)
    .map((p) => ({ channel: p.channel as string, target: p.target ?? 1 }));
}
