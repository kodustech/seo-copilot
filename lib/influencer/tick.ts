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

import { getVisibilitySummary } from "@/lib/ai-visibility";
import { getSupabaseServiceClient } from "@/lib/supabase-server";

import { runInfluencerAgentSession } from "@/lib/influencer/agent";
import { contentEnvNameFor } from "@/lib/influencer/publish";
import { alertOperator } from "@/lib/influencer/alerts";
import {
  listNewFeedback,
  markFeedbackApplied,
  type Feedback,
} from "@/lib/influencer/feedback";
import { buildGoalsBrief, computeProgress, silentChannels, startOfIsoWeek } from "@/lib/influencer/goals";
import { recentMemoryTitles } from "@/lib/influencer/memory";
import { formatVisibilityBrief } from "@/lib/influencer/visibility-brief";
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
// The unpublished buffer is held PER CHANNEL: a channel has room while it holds
// less than one day of its own cap. A single global ceiling looks tidier but
// starves the slow channels — X fills 8 a day, so a week of queued tweets froze
// every blog and dev.to draft even though those queues were empty and their
// weekly quota was behind. The per-channel daily caps still do the real pacing.
function channelBuffer(channel: PersonaChannel): number {
  return Math.max(1, channel.max_posts_per_day);
}

/**
 * Which platforms the shift can write for, and the exact channel each draft
 * will land on. Pure, so the rule is testable without a database.
 *
 * One channel per platform decides — the first actionable one, which is the
 * only channel the writer would have used anyway. A platform is open when THAT
 * channel has room, never when some sibling does.
 *
 * The alternative, opening a platform because any of its channels has room and
 * letting the writer deflect onto the free one, needs a policy nobody has
 * chosen: an activity takes its status from the channel it lands on, so
 * deflecting off an `approve_first` channel publishes unreviewed what a human
 * asked to see first, and refusing that deflection contradicts a brief that
 * just called the platform open. Deciding here, once, means the brief and the
 * tool cannot disagree — and no persona has two channels on one platform yet,
 * so nothing is given up today.
 */
export function splitPlatformsByQueueRoom(
  channels: PersonaChannel[],
  pendingByChannel: Map<string, number>,
): { open: string[]; backedUp: string[]; openChannelIds: string[] } {
  const open = new Set<string>();
  const seen = new Set<string>();
  const openChannelIds: string[] = [];
  for (const channel of channels) {
    if (seen.has(channel.platform)) continue; // a later channel never overrides
    seen.add(channel.platform);
    if ((pendingByChannel.get(channel.id) ?? 0) < channelBuffer(channel)) {
      open.add(channel.platform);
      openChannelIds.push(channel.id);
    }
  }
  return {
    open: [...open],
    backedUp: [...seen].filter((p) => !open.has(p)),
    openChannelIds,
  };
}

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
export function isActionable(channel: PersonaChannel): boolean {
  if (channel.status !== "active") return false;
  if (channel.automation_level === "draft_only") return false;
  // Literally the same question the publisher asks, through the same resolver.
  // Answering it here by hand is how the sentinel the connect flow writes got
  // read as an env var name, which would have silenced every blog channel
  // activated through the UI — including the live one.
  if (channel.platform === "blog") {
    const envName = contentEnvNameFor(channel);
    return Boolean(envName && process.env[envName]?.trim());
  }
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
  open: string[],
  backedUp: string[],
  goalsBrief: string,
  visibilityBrief: string,
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
        .join(", ")}. The exception is a deliberate CROSSPOST: an article of yours that already went live on one of our own sites can run again on another channel, as long as you pass canonical_url with that exact URL so the original keeps the credit.`
    : "";
  const postBeat = postingAllowed
    ? `4) WRITE and queue ONE self-contained piece with queue_draft, for one of: ${open.join(", ")}. For X, a single standalone tweet that stands on its own — never a thread. A shift with no draft is wasted unless nothing is genuinely worth posting.`
    : "4) Every one of your channels is backed up right now — do NOT queue a new post. Instead go deeper: read more, save what you learn to memory, and engage (read your inbox / reply if you have email).";
  // Naming the backed-up channels matters: without it the persona keeps writing
  // for the channel it always writes for and the draft is rejected downstream.
  const backedUpLine = backedUp.length
    ? `These channels are backed up and closed this shift: ${backedUp.join(", ")}. Do NOT write for them — put the work into the ones that are open.`
    : "";
  return [
    `This is your shift as ${persona.display_name} (@${persona.handle}). You are a relentless operator: your job is to HIT YOUR GOALS, and you do whatever it takes and never stop working to get there.`,
    `Your beat: ${persona.beat}.`,
    postingAllowed
      ? `Channels you can post to right now: ${open.join(", ")}.`
      : "None of your channels have queue room this shift.",
    backedUpLine,
    failureLine,
    feedbackLine,
    goalsBrief,
    visibilityBrief,
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

/** Unpublished activities per channel — the buffer each channel is holding. */
async function countPendingByChannel(
  client: SupabaseClient,
  personaId: string,
): Promise<Map<string, number>> {
  const { data, error } = await client
    .from("persona_activities")
    .select("channel_id")
    .eq("persona_id", personaId)
    .in("status", ["draft", "approved", "scheduled"]);
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const id = typeof row.channel_id === "string" ? row.channel_id : null;
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/** Titles of the persona's most recent posts, so a shift avoids repeating them. */
async function recentPostTitles(
  client: SupabaseClient,
  personaId: string,
  limit = 6,
): Promise<string[]> {
  const { data, error } = await client
    .from("persona_activities")
    .select("title, content, created_at, external_url")
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
      const label =
        typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 80) : "";
      if (!label) return "";
      // The live URL is what makes a crosspost possible: canonical_url has to be
      // the exact original, and a persona with no URL in front of it invents one.
      const url = typeof r.external_url === "string" ? r.external_url : "";
      return url ? `${label} (${url})` : label;
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
  const actionable = channels.filter(isActionable);
  const allowed = Array.from(new Set(actionable.map((c) => c.platform)));

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

  // Backpressure, per channel: a channel holding a full buffer is off the table
  // this shift, but the others stay open. With nothing open at all the persona
  // still works the shift — it just researches and engages instead of posting.
  const pendingByChannel = await countPendingByChannel(client, persona.id);
  const { open, backedUp, openChannelIds } = splitPlatformsByQueueRoom(
    actionable,
    pendingByChannel,
  );
  const postingAllowed = open.length > 0;

  const progress = await computeProgress(client, persona, now);
  const goalsBrief = buildGoalsBrief(progress);
  // A channel that has published nothing all week is invisible from the inside:
  // the persona is busy every hour and the feed looks healthy. Say it out loud,
  // once per channel per week (the dedupe key carries the week).
  for (const silent of silentChannels(progress, now)) {
    await alertOperator(client, {
      userEmail: persona.created_by,
      title: `@${persona.handle}: nothing published on ${silent.channel} this week`,
      body: `The weekly quota is ${silent.target} and it is still at 0. Check whether the channel is connected, whether its queue is backed up, and whether the shift is being spent elsewhere.`,
      dedupeKey: `silent-${persona.id}-${silent.channel}-${startOfIsoWeek(now).toISOString().slice(0, 10)}`,
    }).catch(() => {});
  }
  // Best-effort: a shift is still worth running without the scoreboard.
  const visibilityBrief = await getVisibilitySummary(client)
    .then(formatVisibilityBrief)
    .catch(() => "");
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
      open,
      backedUp,
      goalsBrief,
      visibilityBrief,
      memoryTitles,
      postingAllowed,
      feedback,
      failures.length,
      recentPosts,
    ),
    trigger: "scheduled",
    // Only the channels with room: a draft for a backed-up channel would just be
    // rejected by queue_draft, wasting the shift's one post.
    allowedPlatforms: open,
    // Which channel of that platform the draft actually lands on.
    openChannelIds,
    maxSteps: SHIFT_STEPS,
    // One post per shift; 0 when every channel is backed up. Deterministic — the
    // running counter can't overshoot a channel's buffer across shifts.
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
