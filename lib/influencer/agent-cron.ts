import { getSupabaseServiceClient } from "@/lib/supabase-server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { runInfluencerAgentSession, type AgentRunResult } from "@/lib/influencer/agent";
import { listActivePersonas } from "@/lib/influencer/personas";
import type { Persona } from "@/lib/influencer/types";

// Each run does multi-minute LLM sessions sequentially, so bound how many
// personas one cron tick processes. Cadence gating means most personas are
// skipped anyway; the rest roll to the next tick (logged, never silently).
const MAX_PERSONAS_PER_RUN = 25;

type Cadence = "off" | "daily" | "weekly";

const WINDOW_MS: Record<Exclude<Cadence, "off">, number> = {
  daily: 20 * 60 * 60 * 1000, // ~a day, with slack
  weekly: 6 * 24 * 60 * 60 * 1000, // ~a week, with slack
};

function cadenceOf(persona: Persona): Cadence {
  const raw = persona.content_config.agent_cadence;
  return raw === "daily" || raw === "weekly" ? raw : "off";
}

function autonomousGoal(persona: Persona): string {
  return [
    `You're operating autonomously on your beat: ${persona.beat}.`,
    "Use your tools to see what's happening in your space right now, pick the single most worthwhile thing to say or make, do the work, and — only if it clears the bar — queue one draft for review.",
    "If nothing is genuinely worth posting, finish without drafting.",
  ].join(" ");
}

async function hasSessionSince(
  client: SupabaseClient,
  personaId: string,
  sinceIso: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("persona_sessions")
    .select("id", { count: "exact", head: true })
    .eq("persona_id", personaId)
    .gte("started_at", sinceIso);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export type AgentCronResult = {
  persona_id: string;
  handle: string;
  ran: boolean;
  result?: AgentRunResult;
  skipped_reason?: string;
  error?: string;
};

/**
 * Autonomous trigger: for each active persona whose agent cadence is due,
 * run one self-directed session. Autonomy is opt-in per persona
 * (content_config.agent_cadence) — a persona with no cadence never auto-runs.
 */
export async function runInfluencerAgentCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<AgentCronResult[]> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const personas = await listActivePersonas(client);
  const results: AgentCronResult[] = [];

  // Only personas that opted into a cadence are eligible; cap the batch.
  const eligible = personas.filter((p) => cadenceOf(p) !== "off");
  const batch = eligible.slice(0, MAX_PERSONAS_PER_RUN);
  if (eligible.length > batch.length) {
    console.warn(
      `[influencer-agent] ${eligible.length} personas due; processing ${batch.length} this run, rest roll to the next tick`,
    );
  }

  for (const persona of batch) {
    const base: AgentCronResult = {
      persona_id: persona.id,
      handle: persona.handle,
      ran: false,
    };
    const cadence = cadenceOf(persona);
    if (cadence === "off") continue; // already filtered, defensive

    try {
      const since = new Date(now.getTime() - WINDOW_MS[cadence]).toISOString();
      if (await hasSessionSince(client, persona.id, since)) {
        results.push({ ...base, skipped_reason: "ran within the window" });
        continue;
      }
      const result = await runInfluencerAgentSession({
        client,
        persona,
        goal: autonomousGoal(persona),
        trigger: "scheduled",
      });
      results.push({ ...base, ran: true, result });
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
      console.error(`[influencer-agent] ${persona.handle} failed:`, err);
      results.push(base);
    }
  }

  return results;
}
