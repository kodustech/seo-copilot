/**
 * Per-persona goals + progress. Goals live in content_config.goals so there's
 * no migration. Some are measurable now (weekly posts per channel, X followers
 * via the X API); others are qualitative guidance the persona works toward but
 * we can't put a number on yet (e.g. "get quoted by someone notable"). The
 * progress brief is injected into each shift so the persona actually steers
 * toward what it's behind on.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

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

export async function computeProgress(
  client: SupabaseClient,
  persona: Persona,
  now: Date,
): Promise<GoalProgress[]> {
  const goals = getGoals(persona);
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
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
