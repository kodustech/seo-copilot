import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { listReplyThreads } from "@/lib/outreach/inbox";
import { sendOutreachEmail } from "@/lib/outreach/send-email";

import { insertActivities } from "@/lib/influencer/activities";
import { getExecutor } from "@/lib/influencer/executor";
import { getModelForPersona } from "@/lib/influencer/model";
import { listChannelsForPersona } from "@/lib/influencer/personas";
import {
  SOCIAL_ANTI_AI_GUARDRAILS,
  SOCIAL_STYLE_GUIDE,
  platformRules,
} from "@/lib/social-writing-style";
import { fetchFeedPosts } from "@/lib/feed-sources";
import {
  createSession,
  finishSession,
  recordStep,
  type SessionTrigger,
} from "@/lib/influencer/sessions";
import {
  normalizeActivityKind,
  normalizeChannelPlatform,
  type Persona,
  type PersonaChannel,
} from "@/lib/influencer/types";
import { buildPersonaVoicePolicy } from "@/lib/influencer/voice";

const MAX_STEPS = 16;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 8_000;
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

/** Private / reserved / loopback / link-local address → not fetchable. */
function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  const low = ip.toLowerCase();
  if (low === "::1" || low === "::") return true;
  if (low.startsWith("fe80")) return true; // link-local
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // unique local
  const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return false;
}

/**
 * SSRF guard: the model chooses the URL, so a manipulated goal could aim
 * fetch_url at cloud metadata (169.254.169.254), localhost, or a private host.
 * Require http(s), block known hosts, and reject any host that resolves to a
 * private/reserved address. (Residual DNS-rebinding gap between resolve and
 * fetch is acceptable for a model tool; a pinned-IP fetch is a later hardening.)
 */
async function assertPublicUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https URLs are allowed.");
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("That host is not allowed.");
  }
  const ips = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address);
  if (ips.some(isPrivateIp)) {
    throw new Error("URL resolves to a private or reserved address.");
  }
  return parsed;
}

async function fetchText(url: string): Promise<string> {
  const parsed = await assertPublicUrl(url);
  const res = await fetch(parsed, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "seo-copilot-influencer/1.0" },
    redirect: "error", // don't let a redirect bounce past the SSRF guard
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const raw = await res.text();
  // Crude tag strip to hand readable-ish text to the model (not a DOM sink).
  // Blanket strip rather than a script/style-specific filter; proper
  // readability extraction (Exa/readability) is a follow-up.
  const text = raw
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, MAX_FETCH_CHARS);
}

/**
 * Approximate X's weighted character count for a drafting guardrail: every URL
 * counts as 23 (X shortens links via t.co), and the rest is measured by code
 * point rather than UTF-16 unit. Not the full twitter-text algorithm — voice
 * bans emoji and these personas write mostly ASCII — but it stops the real
 * false-reject: a valid tweet with a long link counted at its full length.
 */
function tweetLength(text: string): number {
  const URL = /https?:\/\/\S+/g;
  const urls = text.match(URL)?.length ?? 0;
  const rest = text.replace(URL, "");
  return Array.from(rest).length + urls * 23;
}

function buildAgentSystem(persona: Persona, platforms?: string[]): string {
  const voice = buildPersonaVoicePolicy(persona);
  const configs = (platforms ?? []).map((p) => ({
    platform: p,
    maxLength: p === "x" ? 280 : undefined,
  }));
  return [
    voice.prompt,
    "",
    "OPERATING MODE",
    "You are an autonomous agent working on behalf of this persona. You have tools to research and to produce work.",
    "Do real work first (read sources, gather specifics), then produce something worth posting.",
    "When you have something genuinely worth posting — a tweet, an article, a reply — call queue_draft.",
    "You NEVER publish directly. queue_draft only queues; the system publishes on its own rules (some channels auto-publish, others wait for human approval).",
    "Quality over output: if after researching nothing meets the bar, finish without drafting. Never post filler to have posted.",
    "Stay in character and honor every boundary in your voice policy.",
    "",
    "HOW TO WRITE (this is not a corporate blog — write like a real person):",
    SOCIAL_STYLE_GUIDE,
    "",
    SOCIAL_ANTI_AI_GUARDRAILS,
    "",
    "PLATFORM FORMAT — match the channel exactly:",
    platformRules(configs),
    "For X specifically: write ONE standalone tweet — a single, self-contained idea in ≤280 characters that makes complete sense on its own. Do NOT write threads or thread pieces: this account posts through a scheduler with no thread support, so every tweet must stand alone. One shift produces one tweet, not a series.",
  ].join("\n");
}

function pickChannel(
  channels: PersonaChannel[],
  platform: string,
): PersonaChannel | undefined {
  const active = channels.filter((c) => c.platform === platform && c.status !== "paused");
  return active[0] ?? channels.find((c) => c.platform === platform);
}

export type AgentRunResult = {
  session_id: string;
  status: "completed" | "failed";
  drafts: number;
  summary?: string;
  error?: string;
};

/**
 * Run one agentic job for a persona: resolve its own model, loop with tools,
 * record every step to the session trace, and end with drafts in the review
 * queue. The loop never publishes — that stays with persona-publish and its
 * walls.
 */
export async function runInfluencerAgentSession({
  client,
  persona,
  goal,
  trigger,
  createdBy,
  allowedPlatforms,
  maxSteps,
}: {
  client: SupabaseClient;
  persona: Persona;
  goal: string;
  trigger: SessionTrigger;
  createdBy?: string;
  /** If set, queue_draft may only target these platforms (connected channels). */
  allowedPlatforms?: string[];
  /** Override the per-session step budget (a self-paced shift runs longer). */
  maxSteps?: number;
}): Promise<AgentRunResult> {
  const model = await getModelForPersona(client, persona);
  const channels = await listChannelsForPersona(client, persona.id);
  const executor = getExecutor();

  const session = await createSession(client, {
    persona_id: persona.id,
    trigger,
    goal,
    model_provider: persona.model_provider,
    model_name: persona.model_name,
    created_by: createdBy,
  });

  let idx = 0;
  let drafts = 0;
  // Best-effort: a trace write failing must never break the run.
  const step = (s: Parameters<typeof recordStep>[3]) =>
    recordStep(client, session.id, idx++, s).catch(() => {});

  const tools = {
    fetch_url: tool({
      description:
        "Fetch a web page and return its readable text (truncated). Use to read articles, docs, changelogs, discussions.",
      inputSchema: z.object({ url: z.string().describe("Absolute URL to fetch") }),
      execute: async ({ url }) => {
        await step({ kind: "tool_call", tool: "fetch_url", payload: { url } });
        try {
          const text = await fetchText(url);
          await step({ kind: "tool_result", tool: "fetch_url", payload: { url, chars: text.length } });
          return text;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "fetch_url", payload: { url, error: message } });
          return `Failed to fetch ${url}: ${message}`;
        }
      },
    }),

    browse_signals: tool({
      description:
        "See what the dev community is discussing right now, from the app's own signal feeds (Exa-backed): Hacker News, Reddit dev/AI subreddits (ExperiencedDevs, LocalLLaMA, MachineLearning, ClaudeAI…), research papers, and competitor takes. Use it at the start of a shift to find something current in your beat to react to. Returns titles, links, and excerpts.",
      inputSchema: z.object({
        source: z
          .enum(["hackernews", "reddit", "research", "competitor", "all"])
          .optional()
          .describe(
            "Which feed to read. Default 'hackernews' (cheapest). 'reddit'/'research'/'competitor' pull via Exa; 'all' merges everything (heavier).",
          ),
        limit: z.number().optional().describe("Max items (default 10, max 20)"),
      }),
      execute: async ({ source, limit }) => {
        const n = Math.min(Math.max(limit ?? 10, 1), 20);
        const src = source ?? "hackernews";
        await step({ kind: "tool_call", tool: "browse_signals", payload: { source: src } });
        try {
          const items = await fetchFeedPosts(src);
          const trimmed = items.slice(0, n).map((i) => ({
            source: i.source,
            title: i.title,
            link: i.link,
            excerpt: (i.excerpt || i.content || "").slice(0, 300),
            at: i.publishedAt,
          }));
          await step({ kind: "tool_result", tool: "browse_signals", payload: { count: trimmed.length } });
          return trimmed.length
            ? JSON.stringify(trimmed).slice(0, MAX_FETCH_CHARS)
            : "No signals right now.";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "browse_signals", payload: { error: message } });
          return `Could not load signals: ${message}`;
        }
      },
    }),

    run_bash: tool({
      description:
        "Run a shell command in an isolated sandbox (clone a repo, run a benchmark, inspect code). Returns stdout/stderr. Only available when code execution is configured.",
      inputSchema: z.object({ command: z.string().describe("Shell command to run") }),
      execute: async ({ command }) => {
        await step({ kind: "tool_call", tool: "run_bash", payload: { command } });
        if (!executor) {
          const msg = "Code execution is not configured yet. This capability is unavailable — work with the web tools instead.";
          await step({ kind: "tool_result", tool: "run_bash", payload: { unavailable: true } });
          return msg;
        }
        try {
          const r = await executor.run(command);
          await step({
            kind: "tool_result",
            tool: "run_bash",
            payload: { exit_code: r.exit_code, stdout_chars: r.stdout.length },
          });
          return `exit=${r.exit_code}\n${r.stdout}\n${r.stderr}`.slice(0, MAX_FETCH_CHARS);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "run_bash", payload: { error: message } });
          return `Command failed: ${message}`;
        }
      },
    }),

    send_email: tool({
      description:
        "Send an email from the persona's own mailbox. Use for outreach or to reply to a received email. Returns success or a clear failure (e.g. no mailbox linked).",
      inputSchema: z.object({
        to: z.string().describe("Recipient email"),
        subject: z.string(),
        body: z.string().describe("Plain-text body, in the persona's voice"),
      }),
      execute: async ({ to, subject, body }) => {
        await step({ kind: "tool_call", tool: "send_email", payload: { to, subject } });
        // Require an explicitly linked mailbox. Without this guard
        // sendOutreachEmail silently falls back to the workspace default
        // mailbox, so the persona would send as someone else.
        if (!persona.mailbox_id) {
          await step({
            kind: "tool_result",
            tool: "send_email",
            payload: { error: "no_mailbox" },
          });
          return "Could not send — no mailbox is linked to this persona.";
        }
        const r = await sendOutreachEmail(client, {
          to,
          subject,
          text: body,
          mailboxId: persona.mailbox_id,
        });
        await step({
          kind: "tool_result",
          tool: "send_email",
          payload: r.ok ? { ok: true, to } : { error: r.error, code: r.code },
        });
        return r.ok
          ? `Sent to ${to}.`
          : `Could not send${r.code === "no_mailbox" ? " — no mailbox is linked to this persona" : ""}: ${r.error}`;
      },
    }),

    read_inbox: tool({
      description:
        "Read recent emails/replies in the persona's inbox (sender, subject, snippet). Use to see what came in before deciding to reply.",
      inputSchema: z.object({ limit: z.number().optional() }),
      execute: async ({ limit }) => {
        await step({ kind: "tool_call", tool: "read_inbox", payload: {} });
        // Require an explicitly linked mailbox. The worker runs on the service
        // client (RLS bypassed), so an unfiltered listReplyThreads would return
        // every mailbox's threads across the whole workspace — never do that.
        if (!persona.mailbox_id) {
          await step({ kind: "tool_result", tool: "read_inbox", payload: { count: 0 } });
          return "No mailbox is linked to this persona.";
        }
        try {
          const { threads } = await listReplyThreads(client, {
            mailboxId: persona.mailbox_id,
            channel: "email",
            limit: Math.min(limit ?? 10, 25),
          });
          const items = threads.map((t) => ({
            from: t.contactEmail ?? t.contactName ?? "unknown",
            subject: t.subject,
            snippet: t.snippet,
            at: t.lastInboundAt,
          }));
          await step({ kind: "tool_result", tool: "read_inbox", payload: { count: items.length } });
          return items.length ? JSON.stringify(items) : "Inbox is empty.";
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "read_inbox", payload: { error: message } });
          return `Could not read inbox: ${message}`;
        }
      },
    }),

    queue_draft: tool({
      description:
        "Queue a finished piece of content for human review. This is how your work reaches people — it drafts, it does not publish. Call once per finished piece.",
      inputSchema: z.object({
        kind: z
          .enum(["post", "reply", "quote", "article", "crosspost"])
          .describe("The kind of content"),
        platform: z
          .enum(["x", "devto", "blog", "medium", "reddit", "hackernews"])
          .describe("Which channel this is for"),
        title: z.string().nullable().optional().describe("Title (for articles)"),
        content: z.string().describe("The full content, in the persona's voice"),
      }),
      execute: async ({ kind, platform, title, content }) => {
        await step({ kind: "tool_call", tool: "queue_draft", payload: { kind, platform } });
        const normalizedKind = normalizeActivityKind(kind) ?? "post";
        const normalizedPlatform = normalizeChannelPlatform(platform);
        if (
          allowedPlatforms &&
          (!normalizedPlatform || !allowedPlatforms.includes(normalizedPlatform))
        ) {
          const msg = `You can only post to connected channels right now: ${allowedPlatforms.join(", ") || "none"}. Skip "${platform}".`;
          await step({ kind: "tool_result", tool: "queue_draft", payload: { blocked: platform } });
          return msg;
        }
        const channel = normalizedPlatform
          ? pickChannel(channels, normalizedPlatform)
          : undefined;
        if (!channel) {
          const msg = `No "${platform}" channel exists for this persona. Add the channel first, or use one it has.`;
          await step({ kind: "tool_result", tool: "queue_draft", payload: { error: msg } });
          return msg;
        }
        // Hard platform limit: an X post is one tweet. A thread is many drafts.
        if (normalizedPlatform === "x") {
          const len = tweetLength(content);
          if (len > 280) {
            const msg = `That's ${len} chars (X counts each link as 23) — an X post must be ≤280 and stand on its own (no threads). Tighten it to one self-contained idea.`;
            await step({ kind: "tool_result", tool: "queue_draft", payload: { too_long: len } });
            return msg;
          }
        }
        // Honor the channel's automation level: an `auto` channel publishes
        // without review; everything else waits in the queue for a human.
        const autoPublish = channel.automation_level === "auto";
        try {
          const [activity] = await insertActivities(client, [
            {
              persona_id: persona.id,
              channel_id: channel.id,
              kind: normalizedKind,
              status: autoPublish ? "approved" : "draft",
              title: title ?? null,
              content,
              content_meta: { session_id: session.id },
              source_kind: "agent",
              source_ref: session.id,
            },
          ]);
          drafts += 1;
          await step({
            kind: "tool_result",
            tool: "queue_draft",
            payload: { activity_id: activity?.id, platform, kind, auto: autoPublish },
          });
          return autoPublish
            ? `Queued to publish (${platform} ${kind}). This channel is on auto — it goes out on the next publish cycle.`
            : `Queued for review (${platform} ${kind}). A human approves it before it goes live.`;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "queue_draft", payload: { error: message } });
          return `Failed to queue: ${message}`;
        }
      },
    }),
  };

  try {
    const result = await generateText({
      model,
      system: buildAgentSystem(persona, allowedPlatforms),
      prompt: goal,
      tools,
      stopWhen: stepCountIs(maxSteps ?? MAX_STEPS),
    });
    await step({ kind: "message", payload: { text: result.text } });
    await finishSession(client, session.id, {
      status: "completed",
      result_summary: result.text.slice(0, 500),
    });
    return { session_id: session.id, status: "completed", drafts, summary: result.text };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await step({ kind: "error", payload: { message } });
    await finishSession(client, session.id, { status: "failed", error: message });
    return { session_id: session.id, status: "failed", drafts, error: message };
  }
}
