import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";

import { insertActivities } from "@/lib/influencer/activities";
import { getExecutor } from "@/lib/influencer/executor";
import { getModelForPersona } from "@/lib/influencer/model";
import { listChannelsForPersona } from "@/lib/influencer/personas";
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

function buildAgentSystem(persona: Persona): string {
  const voice = buildPersonaVoicePolicy(persona);
  return [
    voice.prompt,
    "",
    "OPERATING MODE",
    "You are an autonomous agent working on behalf of this persona. You have tools to research and to produce work.",
    "Do real work first (read sources, gather specifics), then produce something worth posting.",
    "When you have something genuinely worth posting — a tweet, an article, a reply — call queue_draft to put it in the human review queue.",
    "You NEVER publish directly. queue_draft only drafts; a human approves before anything goes live.",
    "Quality over output: if after researching nothing meets the bar, finish without drafting. Never post filler to have posted.",
    "Stay in character and honor every boundary in your voice policy. Keep the AI disclosure honest.",
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
}: {
  client: SupabaseClient;
  persona: Persona;
  goal: string;
  trigger: SessionTrigger;
  createdBy?: string;
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
        const channel = normalizedPlatform
          ? pickChannel(channels, normalizedPlatform)
          : undefined;
        if (!channel) {
          const msg = `No "${platform}" channel exists for this persona. Add the channel first, or use one it has.`;
          await step({ kind: "tool_result", tool: "queue_draft", payload: { error: msg } });
          return msg;
        }
        try {
          const [activity] = await insertActivities(client, [
            {
              persona_id: persona.id,
              channel_id: channel.id,
              kind: normalizedKind,
              status: "draft",
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
            payload: { activity_id: activity?.id, platform, kind },
          });
          return `Queued for review (${platform} ${kind}). A human will approve it before it goes live.`;
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
      system: buildAgentSystem(persona),
      prompt: goal,
      tools,
      stopWhen: stepCountIs(MAX_STEPS),
    });
    await step({ kind: "message", payload: { text: result.text } });
    await finishSession(client, session.id, {
      status: "completed",
      result_summary: result.text.slice(0, 500),
    });
    return { session_id: session.id, status: "completed", drafts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await step({ kind: "error", payload: { message } });
    await finishSession(client, session.id, { status: "failed", error: message });
    return { session_id: session.id, status: "failed", drafts, error: message };
  }
}
