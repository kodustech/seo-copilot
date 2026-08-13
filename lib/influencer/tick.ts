/**
 * persona-tick: the self-paced autonomous worker.
 *
 * Instead of a dated backlog, each persona wakes on a heartbeat, does ONE real
 * shift of work (a full multi-step agent session), then decides for itself when
 * to come back ("posted a thread — I'll let it breathe and check in ~2h"). The
 * heartbeat only wakes a persona whose self-chosen next_action_at has arrived.
 *
 * This mirrors how Codex splits an in-session loop (do real work now) from an
 * external scheduler (start a fresh run later): the tick IS the fresh run, and
 * the persona's own reflection sets when the next one fires. The reasoning loop
 * never suspends itself — the wait lives out here, in wall-clock state.
 */
import { generateObject } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseServiceClient } from "@/lib/supabase-server";

import { runInfluencerAgentSession } from "@/lib/influencer/agent";
import { alertOperator } from "@/lib/influencer/alerts";
import { buildGoalsBrief, computeProgress } from "@/lib/influencer/goals";
import { recentMemoryTitles } from "@/lib/influencer/memory";
import { getModelForPersona } from "@/lib/influencer/model";
import {
  listActivePersonas,
  listChannelsForPersona,
  updatePersona,
} from "@/lib/influencer/personas";
import type { Persona, PersonaChannel } from "@/lib/influencer/types";

const MAX_PERSONAS_PER_TICK = 5;
const SHIFT_STEPS = 32;
const MIN_WAIT_MIN = 15;
const MAX_WAIT_MIN = 24 * 60;
const NO_CHANNEL_WAIT_MIN = 6 * 60;
const FAILURE_WAIT_MIN = 60;
// When this many pieces are already waiting to publish, the shift stops adding
// new posts — but it keeps working (research, memory, engagement).
const MAX_PENDING = 6;

export type Cadence = "off" | "daily" | "weekly";

export function cadenceOf(persona: Persona): Cadence {
  const raw = persona.content_config.agent_cadence;
  return raw === "daily" || raw === "weekly" ? raw : "off";
}

export function nextActionAt(persona: Persona): string | null {
  const raw = persona.content_config.next_action_at;
  return typeof raw === "string" && raw.length ? raw : null;
}

export function isDue(persona: Persona, now: Date): boolean {
  const at = nextActionAt(persona);
  return !at || new Date(at).getTime() <= now.getTime();
}

/** A channel the persona can publish to on its own, right now. */
function isActionable(channel: PersonaChannel): boolean {
  if (channel.status !== "active") return false;
  if (channel.automation_level === "draft_only") return false;
  if (channel.publish_via === "post_bridge") {
    return Number(channel.channel_config.post_bridge_account_id) > 0;
  }
  if (channel.publish_via === "api") {
    return typeof channel.credentials_ref === "string" && channel.credentials_ref.length > 0;
  }
  return false;
}

async function setTickState(
  client: SupabaseClient,
  persona: Persona,
  patch: {
    next_action_at: string;
    last_note: string;
    last_tick_at?: string;
    last_session_id?: string | null;
  },
): Promise<void> {
  await updatePersona(client, persona.id, {
    content_config: { ...persona.content_config, ...patch },
  });
}

const ReflectionSchema = z.object({
  wait_minutes: z
    .number()
    .describe("Minutes until your next shift — pace yourself like a real person"),
  note: z
    .string()
    .describe("A short first-person note about what you did and why you'll wait"),
});

function buildShiftGoal(
  persona: Persona,
  allowed: string[],
  goalsBrief: string,
  memoryTitles: string[],
  postingAllowed: boolean,
): string {
  const memoryLine = memoryTitles.length
    ? `Recent notes in your memory: ${memoryTitles.map((t) => `"${t}"`).join(", ")}. Call search_memory to reuse them — don't re-study what you already know.`
    : "You have a durable memory (save_memory / search_memory). Use it to keep studies and build on them across shifts.";
  const postBeat = postingAllowed
    ? "4) WRITE and queue ONE self-contained piece with queue_draft. For X, a single standalone tweet that stands on its own — never a thread. A shift with no draft is wasted unless nothing is genuinely worth posting."
    : "4) Your post queue is full right now — do NOT queue a new post. Instead go deeper: read more, save what you learn to memory, and engage (read your inbox / reply if you have email).";
  return [
    `This is your shift as ${persona.display_name} (@${persona.handle}). You're an active worker — you do several things a day, not one post.`,
    `Your beat: ${persona.beat}.`,
    `Channels you can post to right now: ${allowed.join(", ")}.`,
    goalsBrief,
    memoryLine,
    "Work in decisive beats — research, learn, act. Don't linger re-reading:",
    "1) Call browse_signals ONCE ('hackernews' is usually enough) and pick the SINGLE most interesting item for your beat.",
    "2) search_memory first (build on past notes), then read AT MOST two REAL sources with fetch_url — use the exact URLs the tools give you, never invent/guess a URL, never re-fetch one you already read.",
    "3) save_memory: keep the concrete study you just did (facts, numbers, links) so future shifts build on it.",
    postBeat,
    "Not every X post is a data-take. Some shifts, post like a dev building in public: what you're digging into, a small win or dead end, what you're reading, the grind — a genuine day-in-the-life note. It makes you a person, not a stats bot.",
    "Do a couple of real things this shift, then stop.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Pieces already waiting to publish — used to avoid out-producing the queue. */
async function countPendingActivities(
  client: SupabaseClient,
  personaId: string,
): Promise<number> {
  const { count, error } = await client
    .from("persona_activities")
    .select("id", { count: "exact", head: true })
    .eq("persona_id", personaId)
    .in("status", ["draft", "approved", "scheduled"]);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export type TickResult = {
  persona_id: string;
  handle: string;
  acted: boolean;
  drafts: number;
  wait_minutes: number;
  note: string;
  error?: string;
};

export async function runPersonaTick({
  client,
  persona,
  now,
}: {
  client: SupabaseClient;
  persona: Persona;
  now: Date;
}): Promise<TickResult> {
  const channels = await listChannelsForPersona(client, persona.id);
  const allowed = Array.from(
    new Set(channels.filter(isActionable).map((c) => c.platform)),
  );

  const base: TickResult = {
    persona_id: persona.id,
    handle: persona.handle,
    acted: false,
    drafts: 0,
    wait_minutes: 0,
    note: "",
  };

  // Nothing it can publish on its own — wait and ask for a connected channel.
  if (allowed.length === 0) {
    const note = "No connected channel I can publish to on my own — waiting for one to be linked.";
    const next = new Date(now.getTime() + NO_CHANNEL_WAIT_MIN * 60_000);
    await setTickState(client, persona, {
      next_action_at: next.toISOString(),
      last_note: note,
      last_tick_at: now.toISOString(),
    });
    return { ...base, wait_minutes: NO_CHANNEL_WAIT_MIN, note };
  }

  // Backpressure: if the publish queue is full, still work this shift — just
  // don't add a new post (research, memory, and engagement instead).
  const pending = await countPendingActivities(client, persona.id);
  const postingAllowed = pending < MAX_PENDING;

  const goalsBrief = buildGoalsBrief(await computeProgress(client, persona, now));
  const memoryTitles = await recentMemoryTitles(client, persona.id).catch(() => []);

  // Do the shift: one real multi-step session, gated to connected channels.
  const run = await runInfluencerAgentSession({
    client,
    persona,
    goal: buildShiftGoal(persona, allowed, goalsBrief, memoryTitles, postingAllowed),
    trigger: "scheduled",
    allowedPlatforms: allowed,
    maxSteps: SHIFT_STEPS,
  });

  if (run.status === "failed") {
    const note = `Shift failed: ${run.error ?? "unknown error"}`;
    const next = new Date(now.getTime() + FAILURE_WAIT_MIN * 60_000);
    await setTickState(client, persona, {
      next_action_at: next.toISOString(),
      last_note: note,
      last_tick_at: now.toISOString(),
      last_session_id: run.session_id,
    });
    await alertOperator(client, {
      userEmail: persona.created_by,
      title: `@${persona.handle}: shift failed`,
      body: run.error ?? "unknown error",
      dedupeKey: `tick-fail-${persona.id}-${now.toISOString().slice(0, 13)}`,
    });
    return { ...base, wait_minutes: FAILURE_WAIT_MIN, note, error: run.error, drafts: run.drafts };
  }

  // Let the persona pace itself: decide when to come back and why.
  let waitMinutes = 120;
  let note = run.summary?.slice(0, 280) ?? "Finished a shift.";
  try {
    const model = await getModelForPersona(client, persona);
    const { object } = await generateObject({
      model,
      schema: ReflectionSchema,
      prompt: [
        `You are @${persona.handle}. You just finished a work shift. Here is what you did:`,
        "",
        run.summary?.slice(0, 2000) || "(no summary)",
        "",
        `You queued ${run.drafts} draft(s) for review.`,
        "Decide how many minutes until your next shift and a short first-person note. You're an active worker: during the day, check back and do something every 1-3 hours (60-180 min). Only wait longer — up to overnight — if you just did a lot, or it's late. Don't disappear for a whole day.",
      ].join("\n"),
    });
    waitMinutes = Math.round(object.wait_minutes);
    if (object.note.trim()) note = object.note.trim();
  } catch {
    // Reflection is best-effort; fall back to a sane default cadence.
  }

  waitMinutes = Math.max(MIN_WAIT_MIN, Math.min(MAX_WAIT_MIN, waitMinutes));
  const next = new Date(now.getTime() + waitMinutes * 60_000);
  await setTickState(client, persona, {
    next_action_at: next.toISOString(),
    last_note: note,
    last_tick_at: now.toISOString(),
    last_session_id: run.session_id,
  });

  return {
    ...base,
    acted: true,
    drafts: run.drafts,
    wait_minutes: waitMinutes,
    note,
  };
}

export async function runInfluencerTickCron(
  options: { client?: SupabaseClient; now?: Date } = {},
): Promise<TickResult[]> {
  const client = options.client ?? getSupabaseServiceClient();
  const now = options.now ?? new Date();
  const personas = await listActivePersonas(client);

  const due = personas.filter((p) => cadenceOf(p) !== "off" && isDue(p, now));
  const results: TickResult[] = [];

  for (const persona of due.slice(0, MAX_PERSONAS_PER_TICK)) {
    try {
      results.push(await runPersonaTick({ client, persona, now }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[influencer-tick] ${persona.handle} crashed:`, err);
      results.push({
        persona_id: persona.id,
        handle: persona.handle,
        acted: false,
        drafts: 0,
        wait_minutes: 0,
        note: message,
        error: message,
      });
    }
  }

  return results;
}
