/**
 * persona-planner: the persona plans its own work. For each autonomous persona
 * it reviews its beat, channels, and open backlog, then fills persona_tasks
 * with a realistic slate for the week — posts, an article, research, email,
 * etc. The worker executes those tasks later; the human only reviews drafts.
 */
import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServiceClient } from "@/lib/supabase-server";

import { getModelForPersona } from "@/lib/influencer/model";
import {
  listActivePersonas,
  listChannelsForPersona,
} from "@/lib/influencer/personas";
import { insertTasks, type NewTask } from "@/lib/influencer/tasks";
import type { Persona } from "@/lib/influencer/types";
import { buildPersonaVoicePolicy } from "@/lib/influencer/voice";

const PLAN_WINDOW_MS: Record<"daily" | "weekly", number> = {
  daily: 20 * 60 * 60 * 1000,
  weekly: 6 * 24 * 60 * 60 * 1000,
};
const MAX_TASKS_PER_PLAN = 8;

export function planCadenceOf(persona: Persona): "off" | "daily" | "weekly" {
  const raw = persona.content_config.agent_cadence;
  return raw === "daily" || raw === "weekly" ? raw : "off";
}

const PlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        kind: z.enum([
          "post",
          "article",
          "reply",
          "benchmark",
          "site_update",
          "email",
          "research",
          "other",
        ]),
        channel_platform: z.string().nullable().optional(),
        title: z.string().describe("Short label for the task"),
        goal: z
          .string()
          .describe("A concrete, self-contained instruction the agent will execute"),
        day_offset: z
          .number()
          .describe("When to do it: 0 = today, up to 6 = end of the week"),
      }),
    )
    .describe("The plan — a realistic slate, quality over quantity"),
});

function buildPlannerPrompt(
  persona: Persona,
  channelPlatforms: string[],
  hasMailbox: boolean,
): { system: string; prompt: string } {
  const voice = buildPersonaVoicePolicy(persona);
  const system = [
    voice.prompt,
    "",
    "PLANNING MODE",
    "You are planning your own week of work. Produce a realistic slate of tasks you'll then execute autonomously.",
    "Capabilities you have RIGHT NOW: research the web (read pages), write posts and articles (they go to a human review queue, never auto-published)" +
      (hasMailbox ? ", send and read email." : "."),
    "Capabilities that may be unavailable: running code / benchmarks and updating a website. Only plan those if the task can plausibly be done; prefer work you can finish now.",
    `Channels you can post to: ${channelPlatforms.join(", ") || "none yet"}.`,
    "Quality over quantity: a few genuinely worthwhile things beat a wall of filler. It's fine to plan a light week.",
    "Each task's goal must be concrete and self-contained (the executor sees only that goal, not this plan).",
  ].join("\n");
  const prompt = `Plan your work. Beat: ${persona.beat}. Spread tasks across the next 7 days (day_offset 0–6).`;
  return { system, prompt };
}

export async function planPersona({
  client,
  persona,
  now,
}: {
  client: SupabaseClient;
  persona: Persona;
  now: Date;
}): Promise<number> {
  const model = await getModelForPersona(client, persona);
  const channels = await listChannelsForPersona(client, persona.id);
  const channelPlatforms = channels
    .filter((c) => c.status !== "paused")
    .map((c) => c.platform);
  const { system, prompt } = buildPlannerPrompt(
    persona,
    channelPlatforms,
    Boolean(persona.mailbox_id),
  );

  const { object } = await generateObject({ model, schema: PlanSchema, system, prompt });

  const tasks: NewTask[] = object.tasks.slice(0, MAX_TASKS_PER_PLAN).map((t) => {
    const day = Math.max(0, Math.min(6, Math.round(t.day_offset)));
    const when = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
    return {
      kind: t.kind,
      channel_platform: t.channel_platform ?? null,
      title: t.title,
      goal: t.goal,
      scheduled_for: when.toISOString(),
    };
  });

  const inserted = await insertTasks(client, persona.id, tasks);
  return inserted.length;
}

export type PlannerResult = {
  persona_id: string;
  handle: string;
  planned: number;
  skipped_reason?: string;
  error?: string;
};

async function plannedRecently(
  client: SupabaseClient,
  personaId: string,
  sinceIso: string,
): Promise<boolean> {
  const { count, error } = await client
    .from("persona_tasks")
    .select("id", { count: "exact", head: true })
    .eq("persona_id", personaId)
    .gte("created_at", sinceIso);
  if (error) throw new Error(error.message);
  return (count ?? 0) > 0;
}

export async function runInfluencerPlannerCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<PlannerResult[]> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const personas = await listActivePersonas(client);
  const results: PlannerResult[] = [];

  for (const persona of personas) {
    const cadence = planCadenceOf(persona);
    if (cadence === "off") continue;
    const base: PlannerResult = {
      persona_id: persona.id,
      handle: persona.handle,
      planned: 0,
    };
    try {
      const since = new Date(now.getTime() - PLAN_WINDOW_MS[cadence]).toISOString();
      if (await plannedRecently(client, persona.id, since)) {
        results.push({ ...base, skipped_reason: "planned within the window" });
        continue;
      }
      base.planned = await planPersona({ client, persona, now });
    } catch (err) {
      base.error = err instanceof Error ? err.message : String(err);
      console.error(`[influencer-planner] ${persona.handle} failed:`, err);
    }
    results.push(base);
  }

  return results;
}
