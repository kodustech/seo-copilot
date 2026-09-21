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
  scopesIncludeCalendarReadonly,
  scopesIncludeGmailCompose,
} from "@/lib/outreach/google-oauth";
import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
  listMailboxes,
  type OutreachMailboxPublic,
} from "@/lib/outreach/mailbox";

/** Per-message body cap in thread output; quoted history makes bodies long. */
const THREAD_BODY_MAX = 12_000;
/** Most recent messages kept from a thread, so a long one cannot flood the context. */
const THREAD_MESSAGES_MAX = 15;

type GmailMessageWithLabels = GmailMessage & { labelIds?: string[] };

type GmailNeed = "read" | "compose" | "reply";

/** What a mailbox's Google grant lets the agent do. Each owner grants their own. */
export function mailboxCapabilities(box: OutreachMailboxPublic): {
  read_email: boolean;
  draft: boolean;
  read_calendar: boolean;
} {
  const google =
    box.connected && (box.authMethod === "oauth" || box.provider === "google_oauth");
  return {
    read_email: box.inboxSyncReady,
    draft: google && scopesIncludeGmailCompose(box.oauthGrantedScopes),
    read_calendar: google && scopesIncludeCalendarReadonly(box.oauthGrantedScopes),
  };
}

function canDo(box: OutreachMailboxPublic, need: GmailNeed): boolean {
  const can = mailboxCapabilities(box);
  if (need === "read") return can.read_email;
  if (need === "compose") return can.draft;
  return can.read_email && can.draft;
}

/**
 * Appended to a missing-scope error: the default mailbox failing says nothing
 * about the others, and without this the agent reads "reconnect" as "I cannot".
 */
async function mailboxesThatCan(
  client: SupabaseClient,
  need: GmailNeed,
  exceptId: string,
): Promise<string> {
  const boxes = (await listMailboxes(client)).filter(
    (b) => b.enabled && b.id !== exceptId && canDo(b, need),
  );
  if (!boxes.length) return "";
  const list = boxes.map((b) => `${b.fromEmail} (mailbox_id ${b.id})`).join(", ");
  return ` Mailboxes that can: ${list}.`;
}

export type GmailAccess =
  | { ok: true; accessToken: string; mailbox: string; fromHeader: string }
  | { ok: false; message: string };

/**
 * Resolve a mailbox (default when no id) and a fresh access token, checking
 * the scope the caller needs. A missing scope comes back as a message telling
 * the user to reconnect, never as an empty result.
 *
 * "reply" needs both: the draft reads the thread before writing into it, and
 * Google's per-permission consent can grant compose without readonly.
 */
export async function openGmailMailbox(
  client: SupabaseClient,
  mailboxId: string | null,
  need: GmailNeed,
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
  if ((need === "read" || need === "reply") && !box.inboxSyncReady) {
    return {
      ok: false,
      message: `${label}: connected without gmail.readonly — reconnect the mailbox in Settings to read email.${await mailboxesThatCan(client, need, box.id)}`,
    };
  }
  if (
    (need === "compose" || need === "reply") &&
    !scopesIncludeGmailCompose(box.oauthGrantedScopes)
  ) {
    return {
      ok: false,
      message: `${label}: connected without gmail.compose — reconnect the mailbox in Settings to create drafts.${await mailboxesThatCan(client, need, box.id)}`,
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
    // One message deleted between list and get (404) or a burst 429 skips
    // that message, not the whole search — same as crm-emails.
    const batch = await Promise.all(
      ids.slice(i, i + concurrency).map((id) =>
        gmailGetJson<GmailMessageWithLabels>(
          accessToken,
          `users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
        ).catch(() => null),
      ),
    );
    for (const msg of batch) {
      if (!msg?.id) continue;
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

export type GmailSearchHit = GmailMessageSummary & {
  mailbox: string;
  /** Thread ids belong to one mailbox: pass this on to read or reply. */
  mailbox_id: string;
};

/**
 * Search every enabled mailbox that has read access, newest first across all
 * of them. Mailboxes without read access, or that fail, are reported instead
 * of silently contributing nothing.
 */
export async function searchGmailMailboxes(
  client: SupabaseClient,
  query: string,
  maxResults: number,
): Promise<{ messages: GmailSearchHit[]; searched: string[]; skipped: string[] }> {
  const boxes = (await listMailboxes(client)).filter((b) => b.enabled && b.connected);
  const messages: GmailSearchHit[] = [];
  const searched: string[] = [];
  const skipped: string[] = [];
  for (const box of boxes) {
    if (!box.inboxSyncReady) {
      skipped.push(`${box.fromEmail}: no email read access — reconnect the mailbox in Settings to include it`);
      continue;
    }
    try {
      const secrets = await getMailboxWithSecrets(client, box.id);
      if (!secrets) continue;
      const accessToken = await ensureFreshAccessToken(client, secrets);
      const found = await searchGmailMessages(accessToken, query, maxResults);
      messages.push(
        ...found.map((m) => ({ ...m, mailbox: box.fromEmail, mailbox_id: box.id })),
      );
      searched.push(box.fromEmail);
    } catch (err) {
      skipped.push(`${box.fromEmail}: ${err instanceof Error ? err.message : "search failed"}`);
    }
  }
  messages.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
  return { messages: messages.slice(0, maxResults), searched, skipped };
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
  /** Older messages left out; the newest are always kept, newest last. */
  omitted_older: number;
  messages: GmailThreadMessage[];
};

/**
 * One call for the whole thread. `bodies: false` fetches headers only — what a
 * reply draft needs to thread itself — instead of every body in the thread.
 */
export async function getGmailThread(
  accessToken: string,
  threadId: string,
  opts: { bodies?: boolean } = {},
): Promise<GmailThread> {
  const headersOnly = ["From", "To", "Cc", "Subject", "Message-ID", "References"]
    .map((h) => `metadataHeaders=${h}`)
    .join("&");
  const format =
    opts.bodies === false ? `format=metadata&${headersOnly}` : "format=full";
  const thread = await gmailGetJson<{
    id?: string;
    messages?: GmailMessage[];
  }>(accessToken, `users/me/threads/${encodeURIComponent(threadId)}?${format}`);

  const all = (thread.messages ?? []).filter((m) => m.id);
  const kept = all.slice(-THREAD_MESSAGES_MAX);
  const messages: GmailThreadMessage[] = kept
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
    // From the first message of the whole thread, not the first one kept.
    subject: headerValue(all[0]?.payload?.headers, "Subject"),
    omitted_older: all.length - kept.length,
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
