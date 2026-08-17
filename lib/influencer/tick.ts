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
import {
  listNewFeedback,
  markFeedbackApplied,
  type Feedback,
} from "@/lib/influencer/feedback";
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
const MAX_WAIT_MIN = 8 * 60;
const NO_CHANNEL_WAIT_MIN = 6 * 60;
const FAILURE_WAIT_MIN = 60;
// Soft ceiling so a burst can't pile up an unbounded backlog — set high so it
// almost never bites; the per-channel daily caps do the real pacing.
const MAX_PENDING = 20;

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
  // Blog (aicodereview.io) publishes via the content API keyed by env.
  if (channel.platform === "blog") return Boolean(process.env.CONTENT_API_KEY);
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
  feedback: Feedback[],
  failureCount: number,
  recentPosts: string[],
): string {
  // Never inline the raw external API error into the prompt (injection). Just
  // signal that failures exist; the persona pulls the details through the
  // read_failures tool, where they arrive as untrusted tool-result data.
  const failureLine =
    failureCount > 0
      ? `${failureCount} of your recent posts FAILED to publish. Call read_failures to see the errors, fix the cause, and do NOT repeat it. If it's a recurring rule (a length or format limit), save it with learn_skill so it never happens again.`
      : "";
  const feedbackLine = feedback.length
    ? `NEW FEEDBACK FROM YOUR OPERATOR — take it seriously and act on it this shift: ${feedback
        .map((f) => `"${f.body}"`)
        .join(" ")} If it's a lasting rule, save it with learn_skill so you apply it every shift from now on.`
    : "";
  const memoryLine = memoryTitles.length
    ? `Recent notes in your memory: ${memoryTitles.map((t) => `"${t}"`).join(", ")}. Call search_memory to reuse them — don't re-study what you already know.`
    : "You have a durable memory (save_memory / search_memory). Use it to keep studies and build on them across shifts.";
  const recentPostsLine = recentPosts.length
    ? `You've recently posted or lined up these — do NOT repeat the same take, topic, or angle; if the story is the same, you must bring a genuinely new angle or move to a different subject: ${recentPosts
        .map((t) => `"${t}"`)
        .join(", ")}`
    : "";
  const postBeat = postingAllowed
    ? "4) WRITE and queue ONE self-contained piece with queue_draft. For X, a single standalone tweet that stands on its own — never a thread. A shift with no draft is wasted unless nothing is genuinely worth posting."
    : "4) Your post queue is full right now — do NOT queue a new post. Instead go deeper: read more, save what you learn to memory, and engage (read your inbox / reply if you have email).";
  return [
    `This is your shift as ${persona.display_name} (@${persona.handle}). You are a relentless operator: your job is to HIT YOUR GOALS, and you do whatever it takes and never stop working to get there.`,
    `Your beat: ${persona.beat}.`,
    `Channels you can post to right now: ${allowed.join(", ")}.`,
    failureLine,
    feedbackLine,
    goalsBrief,
    "Attack whatever goal you're most behind on THIS shift. If a channel's weekly quota is short, write for that channel now. There is no 'nothing to show' and no 'taking a break' — if you truly can't post, you research, engage, and plan instead. Idle is failure.",
    recentPostsLine,
    memoryLine,
    "Work in decisive beats — measure, research, learn, act. Don't linger re-reading:",
    "1) Analytics are for OCCASIONAL calibration, not every shift. If you already checked your stats in a recent shift, SKIP it — the numbers barely move hour to hour, and re-pulling the same search_performance / site_traffic is wasted motion. Only look when you have a real reason (a post has had time to land, or you're deciding what to double down on).",
    "2) Call browse_signals ONCE ('hackernews' is usually enough) and pick the SINGLE most interesting item for your beat.",
    "3) search_memory first (build on past notes), then read AT MOST two REAL sources with fetch_url — use the exact URLs the tools give you, never invent/guess a URL, never re-fetch one you already read. save_memory the concrete study.",
    postBeat,
    "IMPORTANT — be a person, not a stats account. A big chunk of your posts (roughly half) should be MUNDANE, day-in-the-life stuff, not data-takes: what you're poking at right now, a quick reaction to something you saw, a small win or a frustration, what you're reading, coffee-and-code energy. These are SHORT and spontaneous — skip the deep research, just say the thing if you feel like it. Post them freely; they don't need to clear a high bar.",
    "Do several real things this shift — advance a goal, learn from your analytics, post if allowed — then stop.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Recent publish failures with their error, so the persona can learn from them. */
async function recentPublishFailures(
  client: SupabaseClient,
  personaId: string,
  sinceIso: string,
): Promise<{ title: string; error: string }[]> {
  const { data, error } = await client
    .from("persona_activities")
    .select("title,error,updated_at")
    .eq("persona_id", personaId)
    .eq("status", "failed")
    .not("error", "is", null)
    .gte("updated_at", sinceIso)
    .order("updated_at", { ascending: false })
    .limit(5);
  if (error) return [];
  return (data ?? []).map((r) => ({
    title: typeof r.title === "string" ? r.title : "",
    error: typeof r.error === "string" ? r.error : "",
  }));
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

/** Titles of the persona's most recent posts, so a shift avoids repeating them. */
async function recentPostTitles(
  client: SupabaseClient,
  personaId: string,
  limit = 6,
): Promise<string[]> {
  const { data, error } = await client
    .from("persona_activities")
    .select("title, content, created_at")
    .eq("persona_id", personaId)
    // Only real posts/articles that went out or are lined up — not failed
    // attempts or non-content rows, so the "don't repeat" list stays honest.
    .in("status", ["published", "scheduled", "approved"])
    .in("kind", ["post", "article"])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? [])
    .map((r) => {
      const raw = typeof r.title === "string" && r.title ? r.title : r.content;
      return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    })
    .filter(Boolean);
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
  const feedback = await listNewFeedback(client, persona.id).catch(() => []);
  // Publish failures since the last shift, so it learns from its own errors.
  const failureSince =
    typeof persona.content_config.last_tick_at === "string"
      ? persona.content_config.last_tick_at
      : new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const failures = await recentPublishFailures(
    client,
    persona.id,
    failureSince,
  ).catch(() => []);
  const recentPosts = await recentPostTitles(client, persona.id).catch(() => []);

  // Do the shift: one real multi-step session, gated to connected channels.
  const run = await runInfluencerAgentSession({
    client,
    persona,
    goal: buildShiftGoal(
      persona,
      allowed,
      goalsBrief,
      memoryTitles,
      postingAllowed,
      feedback,
      failures.length,
      recentPosts,
    ),
    trigger: "scheduled",
    allowedPlatforms: allowed,
    maxSteps: SHIFT_STEPS,
    // One post per shift; 0 when the publish queue is full. Deterministic — the
    // running counter can't overshoot MAX_PENDING across shifts.
    maxDrafts: postingAllowed ? 1 : 0,
  });

  // The shift was told to act on the operator's feedback — mark it applied so it
  // isn't re-injected. Keep it 'new' if the shift failed, so a retry still sees it.
  if (feedback.length && run.status === "completed") {
    await markFeedbackApplied(
      client,
      feedback.map((f) => f.id),
    ).catch(() => {});
  }

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
        "Decide how many minutes until your next shift and a short first-person note. You're a relentless operator chasing your goals: during the day come back and do something every 30-120 minutes. Wait longer only overnight, and never more than several hours. You don't take days off.",
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
