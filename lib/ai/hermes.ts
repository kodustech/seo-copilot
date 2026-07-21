/**
 * Hermes Agent (Nous) OpenAI-compatible API client.
 * Used when HERMES_BASE_URL is set so the app chat goes through Hermes
 * (same brain as Discord/Slack/WhatsApp gateway).
 */

import {
  createUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";

export function hermesEnabled(): boolean {
  return Boolean(process.env.HERMES_BASE_URL?.trim());
}

function hermesBase(): string {
  const base = process.env.HERMES_BASE_URL?.trim().replace(/\/$/, "");
  if (!base) throw new Error("HERMES_BASE_URL not configured");
  return base;
}

function hermesKey(): string {
  const key = process.env.HERMES_API_KEY?.trim();
  if (!key) throw new Error("HERMES_API_KEY not configured");
  return key;
}

/** Convert AI SDK UI messages / model messages to OpenAI chat messages. */
export function toOpenAIMessages(
  messages: Array<{ role: string; content?: unknown; parts?: unknown }>,
): Array<{ role: string; content: string }> {
  const out: Array<{ role: string; content: string }> = [];
  for (const m of messages) {
    const role = m.role === "assistant" || m.role === "system" ? m.role : "user";
    let content = "";
    if (typeof m.content === "string") {
      content = m.content;
    } else if (Array.isArray(m.parts)) {
      content = (m.parts as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
    } else if (Array.isArray(m.content)) {
      content = (m.content as Array<{ type?: string; text?: string }>)
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n");
    }
    if (!content.trim() && role !== "assistant") continue;
    out.push({ role, content: content || "" });
  }
  return out;
}

/**
 * Call Hermes /v1/chat/completions and return an AI SDK UI message stream
 * so the existing AgentChat client keeps working.
 */
export async function streamHermesChat(input: {
  messages: Array<{ role: string; content?: unknown; parts?: unknown }>;
  system?: string;
  userEmail?: string;
  conversationId?: string | null;
}): Promise<Response> {
  const base = hermesBase();
  const key = hermesKey();

  const openaiMessages = toOpenAIMessages(input.messages);
  if (input.system?.trim()) {
    openaiMessages.unshift({ role: "system", content: input.system.trim() });
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  };
  // Stable memory scope per app user
  if (input.userEmail) {
    headers["X-Hermes-Session-Key"] = `kodus-cmo:app:${input.userEmail}`;
  }
  if (input.conversationId) {
    headers["X-Hermes-Session-Id"] = input.conversationId;
  }

  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env.HERMES_MODEL?.trim() || "hermes-agent",
      messages: openaiMessages,
      stream: true,
    }),
    signal: AbortSignal.timeout(280_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Hermes HTTP ${res.status}: ${body.slice(0, 400) || res.statusText}`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("Hermes returned empty body");

  const decoder = new TextDecoder();
  let buffer = "";

  const stream = createUIMessageStream({
    async execute({ writer }) {
      const id = `hermes-${Date.now()}`;
      writer.write({ type: "text-start", id });

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data || data === "[DONE]") continue;
            try {
              const json = JSON.parse(data) as {
                choices?: Array<{
                  delta?: { content?: string };
                  message?: { content?: string };
                }>;
              };
              const delta =
                json.choices?.[0]?.delta?.content ??
                json.choices?.[0]?.message?.content;
              if (delta) {
                writer.write({ type: "text-delta", id, delta });
              }
            } catch {
              // ignore non-JSON SSE lines (tool progress events, etc.)
            }
          }
        }
      } finally {
        writer.write({ type: "text-end", id });
        reader.releaseLock();
      }
    },
  });

  return createUIMessageStreamResponse({ stream });
}
