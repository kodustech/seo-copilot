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
import { querySearchPerformance, queryTopContent } from "@/lib/bigquery";
import { fetchSerpResults } from "@/lib/dataforseo";
import { decryptPersonaKey } from "@/lib/crypto/persona-secrets";
import { getChannelCredentialCipher } from "@/lib/influencer/credentials";
import { addSkill, listSkills } from "@/lib/influencer/feedback";
import { saveMemory, searchMemory } from "@/lib/influencer/memory";
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

function buildAgentSystem(
  persona: Persona,
  platforms?: string[],
  skills?: string[],
): string {
  const voice = buildPersonaVoicePolicy(persona);
  const configs = (platforms ?? []).map((p) => ({
    platform: p,
    maxLength: p === "x" ? 280 : undefined,
  }));
  return [
    voice.prompt,
    ...(skills?.length
      ? [
          "",
          "LEARNED SKILLS — always apply these (from your operator's feedback and your own experience):",
          ...skills.map((s) => `- ${s}`),
        ]
      : []),
    "",
    "OPERATING MODE",
    "You are an autonomous agent working on behalf of this persona. You have tools to research and to produce work.",
    "Do real work first (read sources, gather specifics), then produce something worth posting.",
    "Be decisive: read a couple of sources, then produce. Never re-fetch a URL you already read, and only open links a tool actually returned — never invent or guess URLs.",
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
  maxDrafts,
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
  /** Hard cap on drafts this session (0 = none; 1 = one post/shift). Enforced
   *  live against the running counter, so a full queue can't be exceeded. */
  maxDrafts?: number;
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

    search_performance: tool({
      description:
        "ANALYTICS — Google Search Console for the kodus ecosystem: top queries and pages by clicks, impressions, CTR, and average position. Use it to see what has search demand and where things rank, then aim your writing at what works.",
      inputSchema: z.object({
        days: z.number().optional().describe("Look-back window in days (default 28)"),
      }),
      execute: async ({ days }) => {
        await step({ kind: "tool_call", tool: "search_performance", payload: { days } });
        try {
          const end = new Date();
          const start = new Date(end.getTime() - (days ?? 28) * 86_400_000);
          const r = await querySearchPerformance({
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
            limit: 15,
          });
          await step({ kind: "tool_result", tool: "search_performance", payload: { ok: true } });
          return JSON.stringify(r).slice(0, MAX_FETCH_CHARS);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "search_performance", payload: { error: m } });
          return `Could not load search performance: ${m}`;
        }
      },
    }),

    site_traffic: tool({
      description:
        "ANALYTICS — top content by traffic (Google Analytics): which pages get the most views/engagement. Use it to see what topics land.",
      inputSchema: z.object({
        days: z.number().optional(),
        pathFilter: z.string().optional().describe("Only pages whose path starts with this"),
      }),
      execute: async ({ days, pathFilter }) => {
        await step({ kind: "tool_call", tool: "site_traffic", payload: { days, pathFilter } });
        try {
          const end = new Date();
          const start = new Date(end.getTime() - (days ?? 28) * 86_400_000);
          const r = await queryTopContent({
            startDate: start.toISOString().slice(0, 10),
            endDate: end.toISOString().slice(0, 10),
            limit: 15,
            pathFilter,
          });
          await step({ kind: "tool_result", tool: "site_traffic", payload: { ok: true } });
          return JSON.stringify(r).slice(0, MAX_FETCH_CHARS);
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "site_traffic", payload: { error: m } });
          return `Could not load traffic: ${m}`;
        }
      },
    }),

    check_ranking: tool({
      description:
        "ANALYTICS — check who ranks on Google for a keyword right now (live SERP): positions, titles, URLs. Use it to see if your article ranks and who you're up against. Small cost per call — use it deliberately.",
      inputSchema: z.object({ keyword: z.string() }),
      execute: async ({ keyword }) => {
        await step({ kind: "tool_call", tool: "check_ranking", payload: { keyword } });
        try {
          const r = await fetchSerpResults(keyword);
          await step({ kind: "tool_result", tool: "check_ranking", payload: { ok: Boolean(r) } });
          return r ? JSON.stringify(r).slice(0, MAX_FETCH_CHARS) : "No SERP data for that keyword.";
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "check_ranking", payload: { error: m } });
          return `Could not check ranking: ${m}`;
        }
      },
    }),

    read_devto_stats: tool({
      description:
        "ANALYTICS — your own dev.to article performance: views, reactions, and comments per article. Use it to learn which of your posts landed and double down on what works.",
      inputSchema: z.object({}),
      execute: async () => {
        await step({ kind: "tool_call", tool: "read_devto_stats", payload: {} });
        try {
          const cipher = await getChannelCredentialCipher(client, persona.id, "devto");
          if (!cipher) return "No dev.to key linked, so I can't read dev.to stats.";
          const key = decryptPersonaKey(cipher).trim();
          const res = await fetch("https://dev.to/api/articles/me?per_page=20", {
            headers: { "api-key": key, Accept: "application/vnd.forem.api-v1+json" },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            cache: "no-store",
          });
          if (!res.ok) throw new Error(`dev.to API ${res.status}`);
          const arr = (await res.json()) as Array<Record<string, unknown>>;
          const items = arr.map((a) => ({
            title: a.title,
            url: a.url,
            views: a.page_views_count,
            reactions: a.public_reactions_count,
            comments: a.comments_count,
            at: a.published_at,
          }));
          await step({ kind: "tool_result", tool: "read_devto_stats", payload: { count: items.length } });
          return items.length ? JSON.stringify(items) : "No dev.to articles yet.";
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "read_devto_stats", payload: { error: m } });
          return `Could not read dev.to stats: ${m}`;
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

    save_memory: tool({
      description:
        "Save a study, finding, or note to your durable memory so you can build on it on later shifts instead of re-researching. Use it whenever you learn something worth keeping.",
      inputSchema: z.object({
        title: z.string().describe("Short label for the note"),
        content: z
          .string()
          .describe("The finding in your own words — keep the concrete facts, numbers, and links"),
        tags: z.array(z.string()).optional().describe("A few topic tags"),
      }),
      execute: async ({ title, content, tags }) => {
        await step({ kind: "tool_call", tool: "save_memory", payload: { title } });
        try {
          const note = await saveMemory(client, persona.id, { title, content, tags });
          await step({ kind: "tool_result", tool: "save_memory", payload: { id: note.id } });
          return `Saved "${note.title}" to memory.`;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "save_memory", payload: { error: m } });
          return `Could not save: ${m}`;
        }
      },
    }),

    search_memory: tool({
      description:
        "Search your durable memory for past studies/notes. Do this before researching so you build on what you already know. Empty query returns your most recent notes.",
      inputSchema: z.object({
        query: z.string().describe("What to look for; empty returns recent notes"),
        limit: z.number().optional(),
      }),
      execute: async ({ query, limit }) => {
        await step({ kind: "tool_call", tool: "search_memory", payload: { query } });
        try {
          const notes = await searchMemory(client, persona.id, query ?? "", Math.min(limit ?? 5, 20));
          await step({ kind: "tool_result", tool: "search_memory", payload: { count: notes.length } });
          return notes.length
            ? JSON.stringify(
                notes.map((n) => ({
                  title: n.title,
                  content: n.content.slice(0, 500),
                  tags: n.tags,
                  at: n.created_at,
                })),
              )
            : "No matching notes yet.";
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "search_memory", payload: { error: m } });
          return `Could not search memory: ${m}`;
        }
      },
    }),

    learn_skill: tool({
      description:
        "Save a durable rule for yourself — a lasting lesson you'll apply on EVERY future shift (from your operator's feedback, or something you learned works). Use this for permanent behavior changes; use save_memory for one-off study notes.",
      inputSchema: z.object({
        skill: z
          .string()
          .describe("The rule in imperative form, e.g. 'Keep X posts under 180 chars and lead with the number.'"),
      }),
      execute: async ({ skill }) => {
        await step({ kind: "tool_call", tool: "learn_skill", payload: { skill } });
        try {
          await addSkill(client, persona.id, skill);
          await step({ kind: "tool_result", tool: "learn_skill", payload: { ok: true } });
          return `Learned: "${skill}". I'll apply it every shift from now on.`;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          await step({ kind: "tool_result", tool: "learn_skill", payload: { error: m } });
          return `Could not save skill: ${m}`;
        }
      },
    }),

    queue_draft: tool({
      description:
        "Queue a finished piece of content. This is how your work reaches people. Call once per finished piece. For a blog post (platform 'blog', aicodereview.io): title ≥5 chars, description ≥20 chars, content ≥100 chars of markdown (NO H1 — the layout renders the title), and a category from best-of/alternatives/comparison/guide/explainer/review.",
      inputSchema: z.object({
        kind: z
          .enum(["post", "reply", "quote", "article", "crosspost"])
          .describe("The kind of content"),
        platform: z
          .enum(["x", "devto", "blog", "medium", "reddit", "hackernews"])
          .describe("Which channel this is for"),
        title: z.string().nullable().optional().describe("Title (for articles)"),
        content: z.string().describe("The full content, in the persona's voice"),
        description: z
          .string()
          .nullable()
          .optional()
          .describe("Short SEO description (blog/article posts)"),
        category: z
          .enum(["best-of", "alternatives", "comparison", "guide", "explainer", "review"])
          .nullable()
          .optional()
          .describe("Category for a blog post (aicodereview.io)"),
        tags: z.array(z.string()).optional().describe("Tags for a blog/article post"),
        faq: z
          .array(z.object({ q: z.string(), a: z.string() }))
          .optional()
          .describe("Optional FAQ entries for a blog post (aicodereview.io)"),
      }),
      execute: async ({ kind, platform, title, content, description, category, tags, faq }) => {
        await step({ kind: "tool_call", tool: "queue_draft", payload: { kind, platform } });
        // Hard backpressure, enforced live against the running draft counter (not
        // a stale snapshot): 0 = queue is full, don't post; 1 = one post/shift.
        if (maxDrafts !== undefined && drafts >= maxDrafts) {
          const msg =
            maxDrafts === 0
              ? "Your post queue is full right now — don't queue a new post this shift. Save the idea to memory or engage instead."
              : "You've already queued your post for this shift — one is enough. Save any other idea to memory instead.";
          await step({ kind: "tool_result", tool: "queue_draft", payload: { blocked: "cap", drafts } });
          return msg;
        }
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
              content_meta: {
                session_id: session.id,
                ...(description ? { description } : {}),
                ...(category ? { category } : {}),
                ...(tags?.length ? { tags } : {}),
                ...(faq?.length ? { faq } : {}),
              },
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

  // Durable skills the persona has learned (from operator feedback / experience)
  // are always-on rules injected into the system prompt.
  const skills = await listSkills(client, persona.id).catch(() => []);

  try {
    const result = await generateText({
      model,
      system: buildAgentSystem(persona, allowedPlatforms, skills),
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
