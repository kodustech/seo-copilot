/**
 * Gmail read + draft for the agent (gmailSearch, gmailGetThread,
 * gmailCreateDraft). Uses the same mailbox OAuth tokens as the outreach
 * inbox — no new credentials.
 *
 * Drafts only: nothing here sends. A human opens the draft in Gmail and
 * sends it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  extractTextBody,
  gmailGetJson,
  headerValue,
  type GmailMessage,
} from "@/lib/crm-emails";
import {
  buildRawGmailMessage,
  scopesIncludeGmailCompose,
} from "@/lib/outreach/google-oauth";
import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
} from "@/lib/outreach/mailbox";

/** Per-message body cap in thread output; quoted history makes bodies long. */
const THREAD_BODY_MAX = 12_000;

type GmailMessageWithLabels = GmailMessage & { labelIds?: string[] };

export type GmailAccess =
  | { ok: true; accessToken: string; mailbox: string; fromHeader: string }
  | { ok: false; message: string };

/**
 * Resolve a mailbox (default when no id) and a fresh access token, checking
 * the scope the caller needs. A missing scope comes back as a message telling
 * the user to reconnect, never as an empty result.
 */
export async function openGmailMailbox(
  client: SupabaseClient,
  mailboxId: string | null,
  need: "read" | "compose",
): Promise<GmailAccess> {
  const box = await getMailboxWithSecrets(client, mailboxId);
  if (!box) return { ok: false, message: "No connected mailbox found" };
  if (box.authMethod !== "oauth" && box.provider !== "google_oauth") {
    return {
      ok: false,
      message: `${box.fromEmail} is an SMTP mailbox — Gmail access needs a Google-connected mailbox`,
    };
  }
  const label = box.fromEmail;
  if (need === "read" && !box.inboxSyncReady) {
    return {
      ok: false,
      message: `${label}: connected without gmail.readonly — reconnect the mailbox in Settings to read email`,
    };
  }
  if (need === "compose" && !scopesIncludeGmailCompose(box.oauthGrantedScopes)) {
    return {
      ok: false,
      message: `${label}: connected without gmail.compose — reconnect the mailbox in Settings to create drafts`,
    };
  }
  const accessToken = await ensureFreshAccessToken(client, box);
  const fromHeader = box.fromName
    ? `${box.fromName} <${box.fromEmail}>`
    : box.fromEmail;
  return { ok: true, accessToken, mailbox: box.fromEmail, fromHeader };
}

export type GmailMessageSummary = {
  id: string;
  thread_id: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  snippet: string | null;
  unread: boolean;
};

/** Gmail search syntax (from:, to:, subject:, newer_than:, is:unread, …). */
export async function searchGmailMessages(
  accessToken: string,
  query: string,
  maxResults: number,
): Promise<GmailMessageSummary[]> {
  const list = await gmailGetJson<{
    messages?: Array<{ id?: string; threadId?: string }>;
  }>(
    accessToken,
    `users/me/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`,
  );
  const ids = (list.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  const out: GmailMessageSummary[] = [];
  const concurrency = 5;
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = await Promise.all(
      ids.slice(i, i + concurrency).map((id) =>
        gmailGetJson<GmailMessageWithLabels>(
          accessToken,
          `users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        ),
      ),
    );
    for (const msg of batch) {
      if (!msg.id) continue;
      const headers = msg.payload?.headers;
      out.push({
        id: msg.id,
        thread_id: msg.threadId ?? null,
        from: headerValue(headers, "From"),
        to: headerValue(headers, "To"),
        subject: headerValue(headers, "Subject"),
        date: toIso(msg.internalDate),
        snippet: msg.snippet?.trim() || null,
        unread: (msg.labelIds ?? []).includes("UNREAD"),
      });
    }
  }
  return out;
}

export type GmailThreadMessage = {
  id: string;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  body: string | null;
  body_truncated: boolean;
  /** RFC Message-ID, used to thread a reply draft. */
  message_id: string | null;
  references: string | null;
};

export type GmailThread = {
  thread_id: string;
  subject: string | null;
  messages: GmailThreadMessage[];
};

export async function getGmailThread(
  accessToken: string,
  threadId: string,
): Promise<GmailThread> {
  const thread = await gmailGetJson<{
    id?: string;
    messages?: GmailMessage[];
  }>(accessToken, `users/me/threads/${encodeURIComponent(threadId)}?format=full`);

  const messages: GmailThreadMessage[] = (thread.messages ?? [])
    .filter((m) => m.id)
    .map((m) => {
      const headers = m.payload?.headers;
      const body = extractTextBody(m);
      return {
        id: m.id as string,
        from: headerValue(headers, "From"),
        to: headerValue(headers, "To"),
        cc: headerValue(headers, "Cc"),
        subject: headerValue(headers, "Subject"),
        date: toIso(m.internalDate),
        body: body ? body.slice(0, THREAD_BODY_MAX) : null,
        body_truncated: Boolean(body && body.length > THREAD_BODY_MAX),
        message_id: headerValue(headers, "Message-ID"),
        references: headerValue(headers, "References"),
      };
    });

  return {
    thread_id: thread.id ?? threadId,
    subject: messages[0]?.subject ?? null,
    messages,
  };
}

/**
 * Headers that make a draft land as a reply in the thread: In-Reply-To the
 * last message, References extended with it, subject "Re: <original>".
 */
export function replyHeadersFor(
  thread: GmailThread,
  subjectOverride?: string | null,
): { subject: string; inReplyTo: string | null; references: string | null } {
  const last = thread.messages[thread.messages.length - 1];
  const inReplyTo = last?.message_id ?? null;
  const refs = (last?.references ?? "").split(/\s+/).filter(Boolean);
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo);

  const base = (thread.subject ?? "").trim();
  const subject =
    subjectOverride?.trim() ||
    (/^re:/i.test(base) ? base : base ? `Re: ${base}` : "Re:");
  return {
    subject,
    inReplyTo,
    references: refs.length ? refs.join(" ") : null,
  };
}

export async function createGmailDraft(opts: {
  accessToken: string;
  from: string;
  to: string;
  cc?: string | null;
  subject: string;
  text: string;
  gmailThreadId?: string | null;
  inReplyTo?: string | null;
  references?: string | null;
}): Promise<{ draftId: string; messageId: string | null; threadId: string | null }> {
  const raw = buildRawGmailMessage({
    from: opts.from,
    to: opts.to,
    cc: opts.cc,
    subject: opts.subject,
    text: opts.text,
    thread: { inReplyTo: opts.inReplyTo, references: opts.references },
  });
  const message: Record<string, string> = { raw };
  if (opts.gmailThreadId?.trim()) message.threadId = opts.gmailThreadId.trim();

  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message }),
  });
  const data = (await res.json()) as {
    id?: string;
    message?: { id?: string; threadId?: string };
    error?: { message?: string };
  };
  if (!res.ok || !data.id) {
    throw new Error(data.error?.message || `Gmail API ${res.status} on drafts`);
  }
  return {
    draftId: data.id,
    messageId: data.message?.id ?? null,
    threadId: data.message?.threadId ?? null,
  };
}

function toIso(internalDate: string | undefined): string | null {
  if (!internalDate) return null;
  const ms = Number(internalDate);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
