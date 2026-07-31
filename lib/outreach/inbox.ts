/**
 * Outbound reply inbox — sync Gmail threads for sequence enrollments.
 *
 * Matching order (strong → weak):
 * 1. gmail_thread_id from sent outreach_send_tasks.meta
 * 2. In-Reply-To / References vs our rfc_message_id
 * 3. from_email == enrollment.contact_email (triage only; no auto-stop)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
  listMailboxes,
  type OutreachMailboxPublic,
  type OutreachMailboxSecrets,
} from "@/lib/outreach/mailbox";
import {
  markEnrollmentBounced,
  markEnrollmentReplied,
} from "@/lib/outreach/sequences";
import { scopesIncludeGmailReadonly } from "@/lib/outreach/google-oauth";

/** Bounce / DSN / mailer-daemon — not a human reply. */
const BOUNCE_INBOUND_RE =
  /address not found|endere[cç]o n[aã]o encontrado|delivery status notification|could not be delivered|wasn't delivered|wasn&#39;t delivered|mailbox unavailable|user unknown|550\s*5\.1\.1|does not exist|undeliverable|mail delivery failed|recipient rejected|no such user|unknown user/i;

const MAILER_DAEMON_RE =
  /mailer-daemon|postmaster|mail-delivery|mail delivery subsystem/i;

export function isBounceInbound(opts: {
  subject?: string | null;
  snippet?: string | null;
  fromEmail?: string | null;
  bodyText?: string | null;
}): boolean {
  const from = (opts.fromEmail || "").toLowerCase();
  if (MAILER_DAEMON_RE.test(from)) return true;
  const blob = [opts.subject, opts.snippet, opts.bodyText]
    .filter(Boolean)
    .join("\n");
  return BOUNCE_INBOUND_RE.test(blob);
}

// ── Types ──────────────────────────────────────────────────────────

export type ReplyThreadStatus = "new" | "open" | "done" | "snoozed";
export type ReplyMatchedHow =
  | "gmail_thread"
  | "in_reply_to"
  | "from_email"
  | "linkedin_profile"
  | "unmatched";
export type ReplyMessageDirection = "inbound" | "outbound_ours";
export type ReplyChannel = "email" | "linkedin";

export type ReplyThread = {
  id: string;
  channel: ReplyChannel;
  mailboxId: string | null;
  unipileAccountId: string | null;
  enrollmentId: string | null;
  sequenceId: string | null;
  /** Gmail thread id or Unipile chat_id */
  gmailThreadId: string;
  contactEmail: string | null;
  contactName: string | null;
  contactLinkedin: string | null;
  companyName: string | null;
  subject: string | null;
  snippet: string | null;
  status: ReplyThreadStatus;
  snoozedUntil: string | null;
  matchedHow: ReplyMatchedHow;
  messageCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  createdAt: string;
  updatedAt: string;
  sequenceName?: string | null;
};

export type ReplyMessage = {
  id: string;
  threadId: string;
  gmailMessageId: string;
  direction: ReplyMessageDirection;
  fromEmail: string | null;
  toEmails: string[];
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  internalDate: string | null;
  createdAt: string;
};

export type InboxSyncResult = {
  mailboxId: string;
  fromEmail: string;
  ok: boolean;
  mode: "bootstrap" | "history" | "skipped";
  threadsTouched: number;
  messagesUpserted: number;
  enrollmentsMarkedReplied: number;
  error?: string;
};

const BODY_TEXT_MAX = 50_000;
const BODY_HTML_MAX = 80_000;
const BOOTSTRAP_THREAD_LIMIT = 200;
const LOOKBACK_DAYS = 90;

// ── Mappers ────────────────────────────────────────────────────────

function mapThread(r: Record<string, unknown>): ReplyThread {
  return {
    id: r.id as string,
    channel: (r.channel as ReplyChannel) || "email",
    mailboxId: (r.mailbox_id as string | null) ?? null,
    unipileAccountId: (r.unipile_account_id as string | null) ?? null,
    enrollmentId: (r.enrollment_id as string | null) ?? null,
    sequenceId: (r.sequence_id as string | null) ?? null,
    gmailThreadId: r.gmail_thread_id as string,
    contactEmail: (r.contact_email as string | null) ?? null,
    contactName: (r.contact_name as string | null) ?? null,
    contactLinkedin: (r.contact_linkedin as string | null) ?? null,
    companyName: (r.company_name as string | null) ?? null,
    subject: (r.subject as string | null) ?? null,
    snippet: (r.snippet as string | null) ?? null,
    status: (r.status as ReplyThreadStatus) || "new",
    snoozedUntil: (r.snoozed_until as string | null) ?? null,
    matchedHow: (r.matched_how as ReplyMatchedHow) || "unmatched",
    messageCount: Number(r.message_count ?? 0),
    firstInboundAt: (r.first_inbound_at as string | null) ?? null,
    lastInboundAt: (r.last_inbound_at as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function mapMessage(r: Record<string, unknown>): ReplyMessage {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    gmailMessageId: r.gmail_message_id as string,
    direction: (r.direction as ReplyMessageDirection) || "inbound",
    fromEmail: (r.from_email as string | null) ?? null,
    toEmails: Array.isArray(r.to_emails) ? (r.to_emails as string[]) : [],
    subject: (r.subject as string | null) ?? null,
    bodyText: (r.body_text as string | null) ?? null,
    bodyHtml: (r.body_html as string | null) ?? null,
    snippet: (r.snippet as string | null) ?? null,
    rfcMessageId: (r.rfc_message_id as string | null) ?? null,
    inReplyTo: (r.in_reply_to as string | null) ?? null,
    internalDate: (r.internal_date as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function normalizeMsgId(id: string | null | undefined): string | null {
  if (!id?.trim()) return null;
  const t = id.trim();
  return t.startsWith("<") ? t.toLowerCase() : `<${t}>`.toLowerCase();
}

function extractEmail(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const angle = raw.match(/<([^>]+)>/);
  const candidate = (angle?.[1] || raw).trim().toLowerCase();
  return candidate.includes("@") ? candidate : null;
}

function parseAddressList(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((part) => extractEmail(part))
    .filter((e): e is string => Boolean(e));
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…[truncated]";
}

// ── Gmail helpers ──────────────────────────────────────────────────

type GmailHeader = { name?: string; value?: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPart[];
  headers?: GmailHeader[];
};

type GmailMessage = {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

function headerValue(
  headers: GmailHeader[] | undefined,
  name: string,
): string | null {
  if (!headers?.length) return null;
  const found = headers.find(
    (h) => h.name?.toLowerCase() === name.toLowerCase(),
  );
  return found?.value?.trim() || null;
}

function decodeBodyData(data: string | undefined): string {
  if (!data) return "";
  try {
    const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(b64, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function walkParts(
  part: GmailPart | undefined,
  acc: { text: string[]; html: string[] },
): void {
  if (!part) return;
  const mime = (part.mimeType || "").toLowerCase();
  if (mime === "text/plain" && part.body?.data) {
    acc.text.push(decodeBodyData(part.body.data));
  } else if (mime === "text/html" && part.body?.data) {
    acc.html.push(decodeBodyData(part.body.data));
  }
  for (const child of part.parts ?? []) walkParts(child, acc);
}

function extractBodies(msg: GmailMessage): {
  text: string | null;
  html: string | null;
} {
  const acc = { text: [] as string[], html: [] as string[] };
  walkParts(msg.payload, acc);
  // Single-part body on payload itself
  if (!acc.text.length && !acc.html.length && msg.payload?.body?.data) {
    const mime = (msg.payload.mimeType || "").toLowerCase();
    const raw = decodeBodyData(msg.payload.body.data);
    if (mime.includes("html")) acc.html.push(raw);
    else acc.text.push(raw);
  }
  return {
    text: acc.text.join("\n\n").trim() || null,
    html: acc.html.join("\n").trim() || null,
  };
}

async function gmailGetJson<T>(
  accessToken: string,
  path: string,
): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as T & {
    error?: { message?: string; code?: number };
  };
  if (!res.ok) {
    throw new Error(
      data.error?.message || `Gmail API ${res.status} on ${path}`,
    );
  }
  return data;
}

async function fetchGmailProfile(accessToken: string): Promise<{
  emailAddress?: string;
  historyId?: string;
}> {
  return gmailGetJson(accessToken, "users/me/profile");
}

async function fetchGmailThread(
  accessToken: string,
  threadId: string,
): Promise<{ id?: string; messages?: GmailMessage[]; historyId?: string }> {
  return gmailGetJson(
    accessToken,
    `users/me/threads/${encodeURIComponent(threadId)}?format=full`,
  );
}

async function fetchGmailMessage(
  accessToken: string,
  messageId: string,
): Promise<GmailMessage> {
  return gmailGetJson(
    accessToken,
    `users/me/messages/${encodeURIComponent(messageId)}?format=full`,
  );
}

// ── Send-task index for matching ───────────────────────────────────

type SentThreadIndex = {
  byGmailThread: Map<
    string,
    {
      enrollmentId: string;
      sequenceId: string;
      contactEmail: string | null;
      contactName: string | null;
      companyName: string;
      mailboxId: string | null;
    }
  >;
  byRfcMessageId: Map<
    string,
    {
      enrollmentId: string;
      sequenceId: string;
      gmailThreadId: string | null;
      contactEmail: string | null;
      contactName: string | null;
      companyName: string;
      mailboxId: string | null;
    }
  >;
  ourGmailMessageIds: Set<string>;
  ourRfcIds: Set<string>;
  byContactEmail: Map<
    string,
    Array<{
      enrollmentId: string;
      sequenceId: string;
      gmailThreadId: string | null;
      contactName: string | null;
      companyName: string;
    }>
  >;
};

async function buildSentThreadIndex(
  client: SupabaseClient,
  mailboxId: string,
  fromEmail: string,
): Promise<SentThreadIndex> {
  const since = new Date();
  since.setDate(since.getDate() - LOOKBACK_DAYS);

  // Enrollments with sent email in lookback — join via tasks
  const { data: tasks, error } = await client
    .from("outreach_send_tasks")
    .select(
      "id, enrollment_id, provider_message_id, meta, sent_at, status, channel",
    )
    .eq("channel", "email")
    .eq("status", "sent")
    .gte("sent_at", since.toISOString())
    .order("sent_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);

  const enrollmentIds = [
    ...new Set(
      (tasks ?? [])
        .map((t) => t.enrollment_id as string)
        .filter(Boolean),
    ),
  ];

  const enrollments = new Map<
    string,
    {
      id: string;
      sequenceId: string;
      contactEmail: string | null;
      contactName: string | null;
      companyName: string;
      status: string;
    }
  >();

  if (enrollmentIds.length) {
    const chunk = 100;
    for (let i = 0; i < enrollmentIds.length; i += chunk) {
      const slice = enrollmentIds.slice(i, i + chunk);
      const { data: enrs, error: e2 } = await client
        .from("outreach_enrollments")
        .select(
          "id, sequence_id, contact_email, contact_name, company_name, status",
        )
        .in("id", slice);
      if (e2) throw new Error(e2.message);
      for (const e of enrs ?? []) {
        enrollments.set(e.id as string, {
          id: e.id as string,
          sequenceId: e.sequence_id as string,
          contactEmail: (e.contact_email as string | null)?.toLowerCase() ?? null,
          contactName: (e.contact_name as string | null) ?? null,
          companyName: (e.company_name as string) || "",
          status: e.status as string,
        });
      }
    }
  }

  const index: SentThreadIndex = {
    byGmailThread: new Map(),
    byRfcMessageId: new Map(),
    ourGmailMessageIds: new Set(),
    ourRfcIds: new Set(),
    byContactEmail: new Map(),
  };
  /** contactEmail → enrollmentIds already pushed (O(1) dedupe). */
  const contactEnrollmentSeen = new Map<string, Set<string>>();

  const fromNorm = fromEmail.toLowerCase();

  for (const t of tasks ?? []) {
    const enrollmentId = t.enrollment_id as string;
    const enr = enrollments.get(enrollmentId);
    if (!enr) continue;
    const meta = (t.meta ?? {}) as Record<string, unknown>;
    const taskMailbox =
      typeof meta.mailbox_id === "string" ? meta.mailbox_id : null;
    // Prefer tasks from this mailbox; also accept missing mailbox_id (legacy)
    if (taskMailbox && taskMailbox !== mailboxId) continue;

    const gmailThreadId =
      typeof meta.gmail_thread_id === "string" ? meta.gmail_thread_id : null;
    const rfc =
      normalizeMsgId(
        (meta.rfc_message_id as string | undefined) ||
          (typeof t.provider_message_id === "string" &&
          String(t.provider_message_id).includes("@")
            ? String(t.provider_message_id)
            : null),
      );
    const providerId =
      typeof t.provider_message_id === "string" ? t.provider_message_id : null;
    if (providerId && !providerId.includes("@")) {
      index.ourGmailMessageIds.add(providerId);
    }
    if (rfc) index.ourRfcIds.add(rfc);

    const base = {
      enrollmentId,
      sequenceId: enr.sequenceId,
      contactEmail: enr.contactEmail,
      contactName: enr.contactName,
      companyName: enr.companyName,
      mailboxId: taskMailbox,
    };

    if (gmailThreadId && !index.byGmailThread.has(gmailThreadId)) {
      index.byGmailThread.set(gmailThreadId, base);
    }
    if (rfc && !index.byRfcMessageId.has(rfc)) {
      index.byRfcMessageId.set(rfc, {
        ...base,
        gmailThreadId,
      });
    }
    if (enr.contactEmail) {
      let seen = contactEnrollmentSeen.get(enr.contactEmail);
      if (!seen) {
        seen = new Set();
        contactEnrollmentSeen.set(enr.contactEmail, seen);
      }
      if (!seen.has(enrollmentId)) {
        seen.add(enrollmentId);
        const list = index.byContactEmail.get(enr.contactEmail) ?? [];
        list.push({
          enrollmentId,
          sequenceId: enr.sequenceId,
          gmailThreadId,
          contactName: enr.contactName,
          companyName: enr.companyName,
        });
        index.byContactEmail.set(enr.contactEmail, list);
      }
    }
  }

  // Also track "from us" via mailbox address for direction classification
  void fromNorm;

  return index;
}

type MatchResult = {
  enrollmentId: string | null;
  sequenceId: string | null;
  contactEmail: string | null;
  contactName: string | null;
  companyName: string | null;
  matchedHow: ReplyMatchedHow;
  strong: boolean;
};

function matchMessage(
  index: SentThreadIndex,
  gmailThreadId: string,
  headers: {
    from: string | null;
    inReplyTo: string | null;
    references: string | null;
    messageId: string | null;
  },
  mailboxFrom: string,
): MatchResult {
  const byThread = index.byGmailThread.get(gmailThreadId);
  if (byThread) {
    return {
      enrollmentId: byThread.enrollmentId,
      sequenceId: byThread.sequenceId,
      contactEmail: byThread.contactEmail,
      contactName: byThread.contactName,
      companyName: byThread.companyName,
      matchedHow: "gmail_thread",
      strong: true,
    };
  }

  const replyRefs = [
    normalizeMsgId(headers.inReplyTo),
    ...(headers.references
      ?.split(/\s+/)
      .map((r) => normalizeMsgId(r))
      .filter(Boolean) ?? []),
  ].filter((x): x is string => Boolean(x));

  for (const ref of replyRefs) {
    const hit = index.byRfcMessageId.get(ref);
    if (hit) {
      return {
        enrollmentId: hit.enrollmentId,
        sequenceId: hit.sequenceId,
        contactEmail: hit.contactEmail,
        contactName: hit.contactName,
        companyName: hit.companyName,
        matchedHow: "in_reply_to",
        strong: true,
      };
    }
  }

  const from = extractEmail(headers.from);
  if (from && from !== mailboxFrom.toLowerCase()) {
    const candidates = index.byContactEmail.get(from);
    if (candidates?.length === 1) {
      const c = candidates[0];
      return {
        enrollmentId: c.enrollmentId,
        sequenceId: c.sequenceId,
        contactEmail: from,
        contactName: c.contactName,
        companyName: c.companyName,
        matchedHow: "from_email",
        strong: false,
      };
    }
  }

  return {
    enrollmentId: null,
    sequenceId: null,
    contactEmail: from,
    contactName: null,
    companyName: null,
    matchedHow: "unmatched",
    strong: false,
  };
}

function classifyDirection(
  index: SentThreadIndex,
  msg: GmailMessage,
  fromEmail: string | null,
  mailboxFrom: string,
): ReplyMessageDirection {
  if (msg.id && index.ourGmailMessageIds.has(msg.id)) return "outbound_ours";
  const headers = msg.payload?.headers;
  const rfc = normalizeMsgId(headerValue(headers, "Message-ID"));
  if (rfc && index.ourRfcIds.has(rfc)) return "outbound_ours";
  if (fromEmail && fromEmail === mailboxFrom.toLowerCase()) {
    return "outbound_ours";
  }
  return "inbound";
}

// ── Persist ────────────────────────────────────────────────────────

async function upsertThreadAndMessages(
  client: SupabaseClient,
  opts: {
    mailboxId: string;
    gmailThreadId: string;
    match: MatchResult;
    messages: GmailMessage[];
    index: SentThreadIndex;
    mailboxFrom: string;
  },
): Promise<{
  threadId: string;
  messagesUpserted: number;
  hasNewInbound: boolean;
  strongMatch: boolean;
  /** Enrollment actually stored on the thread after match merge. */
  enrollmentId: string | null;
  matchedHow: ReplyMatchedHow;
}> {
  const { mailboxId, gmailThreadId, match, messages, index, mailboxFrom } =
    opts;

  let messagesUpserted = 0;
  let hasNewInbound = false;
  let firstInbound: string | null = null;
  let lastInbound: string | null = null;
  let subject: string | null = null;
  let snippet: string | null = null;
  let inboundCount = 0;

  // Existing thread?
  const { data: existing, error: exErr } = await client
    .from("outreach_reply_threads")
    .select("*")
    .eq("mailbox_id", mailboxId)
    .eq("gmail_thread_id", gmailThreadId)
    .maybeSingle();
  if (exErr) throw new Error(exErr.message);

  const now = new Date().toISOString();
  const existingMsgs = new Set<string>();
  if (existing) {
    const { data: prev } = await client
      .from("outreach_reply_messages")
      .select("gmail_message_id")
      .eq("thread_id", existing.id);
    for (const p of prev ?? []) {
      existingMsgs.add(p.gmail_message_id as string);
    }
  }

  // Prefer stronger match over weaker existing
  const rank: Record<ReplyMatchedHow, number> = {
    gmail_thread: 4,
    in_reply_to: 3,
    linkedin_profile: 3,
    from_email: 2,
    unmatched: 1,
  };
  const prevHow = (existing?.matched_how as ReplyMatchedHow) || "unmatched";
  const useMatch =
    !existing || rank[match.matchedHow] >= rank[prevHow] ? match : {
      enrollmentId: (existing.enrollment_id as string | null) ?? match.enrollmentId,
      sequenceId: (existing.sequence_id as string | null) ?? match.sequenceId,
      contactEmail:
        (existing.contact_email as string | null) ?? match.contactEmail,
      contactName:
        (existing.contact_name as string | null) ?? match.contactName,
      companyName:
        (existing.company_name as string | null) ?? match.companyName,
      matchedHow: prevHow,
      strong: rank[prevHow] >= 3,
    };

  // Pre-scan for subject / inbound times
  for (const msg of messages) {
    const headers = msg.payload?.headers;
    const from = extractEmail(headerValue(headers, "From"));
    const direction = classifyDirection(index, msg, from, mailboxFrom);
    const internalDate = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : null;
    if (!subject) {
      subject = headerValue(headers, "Subject");
    }
    if (direction === "inbound") {
      inboundCount++;
      if (internalDate) {
        if (!firstInbound || internalDate < firstInbound) {
          firstInbound = internalDate;
        }
        if (!lastInbound || internalDate > lastInbound) {
          lastInbound = internalDate;
          snippet = msg.snippet ?? snippet;
        }
      }
      if (msg.id && !existingMsgs.has(msg.id)) {
        hasNewInbound = true;
      }
    }
  }

  // Only persist threads that have at least one inbound (or already exist)
  if (!existing && inboundCount === 0) {
    return {
      threadId: "",
      messagesUpserted: 0,
      hasNewInbound: false,
      strongMatch: false,
      enrollmentId: null,
      matchedHow: "unmatched",
    };
  }

  // Skip pure unmatched with no link unless we already have it
  if (!existing && useMatch.matchedHow === "unmatched") {
    return {
      threadId: "",
      messagesUpserted: 0,
      hasNewInbound: false,
      strongMatch: false,
      enrollmentId: null,
      matchedHow: "unmatched",
    };
  }

  let threadId: string;
  if (existing) {
    threadId = existing.id as string;
    const patch: Record<string, unknown> = {
      updated_at: now,
      subject: subject ?? existing.subject,
      snippet: snippet ?? existing.snippet,
      message_count: messages.length,
      first_inbound_at: firstInbound ?? existing.first_inbound_at,
      last_inbound_at: lastInbound ?? existing.last_inbound_at,
    };
    if (rank[useMatch.matchedHow] > rank[prevHow]) {
      patch.matched_how = useMatch.matchedHow;
      patch.enrollment_id = useMatch.enrollmentId;
      patch.sequence_id = useMatch.sequenceId;
      patch.contact_email = useMatch.contactEmail;
      patch.contact_name = useMatch.contactName;
      patch.company_name = useMatch.companyName;
    } else {
      if (!existing.enrollment_id && useMatch.enrollmentId) {
        patch.enrollment_id = useMatch.enrollmentId;
        patch.sequence_id = useMatch.sequenceId;
        patch.matched_how = useMatch.matchedHow;
      }
      if (!existing.contact_email && useMatch.contactEmail) {
        patch.contact_email = useMatch.contactEmail;
      }
      if (!existing.company_name && useMatch.companyName) {
        patch.company_name = useMatch.companyName;
      }
    }
    // Re-open if new inbound and was done? Keep done unless status is snoozed expired — leave human state.
    // If status is done and new inbound, bump to new so it reappears.
    if (hasNewInbound && (existing.status === "done" || existing.status === "snoozed")) {
      patch.status = "new";
      patch.snoozed_until = null;
    } else if (hasNewInbound && existing.status === "open") {
      // keep open
    } else if (hasNewInbound && existing.status === "new") {
      // keep new
    }

    const { error: upErr } = await client
      .from("outreach_reply_threads")
      .update(patch)
      .eq("id", threadId);
    if (upErr) throw new Error(upErr.message);
  } else {
    const { data: inserted, error: insErr } = await client
      .from("outreach_reply_threads")
      .insert({
        mailbox_id: mailboxId,
        enrollment_id: useMatch.enrollmentId,
        sequence_id: useMatch.sequenceId,
        gmail_thread_id: gmailThreadId,
        contact_email: useMatch.contactEmail,
        contact_name: useMatch.contactName,
        company_name: useMatch.companyName,
        subject,
        snippet,
        status: "new",
        matched_how: useMatch.matchedHow,
        message_count: messages.length,
        first_inbound_at: firstInbound,
        last_inbound_at: lastInbound,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    threadId = inserted.id as string;
  }

  for (const msg of messages) {
    if (!msg.id) continue;
    if (existingMsgs.has(msg.id)) continue;

    const headers = msg.payload?.headers;
    const from = extractEmail(headerValue(headers, "From"));
    const direction = classifyDirection(index, msg, from, mailboxFrom);
    const bodies = extractBodies(msg);
    const internalDate = msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : null;

    const { error: msgErr } = await client.from("outreach_reply_messages").upsert(
      {
        thread_id: threadId,
        gmail_message_id: msg.id,
        direction,
        from_email: from,
        to_emails: parseAddressList(headerValue(headers, "To")),
        subject: headerValue(headers, "Subject"),
        body_text: truncate(bodies.text, BODY_TEXT_MAX),
        body_html: truncate(bodies.html, BODY_HTML_MAX),
        snippet: msg.snippet ?? null,
        rfc_message_id: normalizeMsgId(headerValue(headers, "Message-ID")),
        in_reply_to: normalizeMsgId(headerValue(headers, "In-Reply-To")),
        internal_date: internalDate,
      },
      { onConflict: "thread_id,gmail_message_id" },
    );
    if (msgErr) throw new Error(msgErr.message);
    messagesUpserted++;
  }

  // useMatch is the enrollment/how we persist (existing stronger match wins).
  return {
    threadId,
    messagesUpserted,
    hasNewInbound,
    strongMatch:
      useMatch.matchedHow === "gmail_thread" ||
      useMatch.matchedHow === "in_reply_to",
    enrollmentId: useMatch.enrollmentId,
    matchedHow: useMatch.matchedHow,
  };
}

async function processGmailThread(
  client: SupabaseClient,
  accessToken: string,
  mailbox: OutreachMailboxSecrets,
  index: SentThreadIndex,
  gmailThreadId: string,
  counters: { threadsTouched: number; messagesUpserted: number; enrollmentsMarkedReplied: number },
): Promise<void> {
  const thread = await fetchGmailThread(accessToken, gmailThreadId);
  const messages = thread.messages ?? [];
  if (!messages.length) return;

  // Match using any message headers (prefer inbound for from_email)
  let best: MatchResult = {
    enrollmentId: null,
    sequenceId: null,
    contactEmail: null,
    contactName: null,
    companyName: null,
    matchedHow: "unmatched",
    strong: false,
  };
  const rank: Record<ReplyMatchedHow, number> = {
    gmail_thread: 4,
    in_reply_to: 3,
    linkedin_profile: 3,
    from_email: 2,
    unmatched: 1,
  };
  for (const msg of messages) {
    const headers = msg.payload?.headers;
    const m = matchMessage(
      index,
      gmailThreadId,
      {
        from: headerValue(headers, "From"),
        inReplyTo: headerValue(headers, "In-Reply-To"),
        references: headerValue(headers, "References"),
        messageId: headerValue(headers, "Message-ID"),
      },
      mailbox.fromEmail,
    );
    if (rank[m.matchedHow] > rank[best.matchedHow]) best = m;
  }

  const result = await upsertThreadAndMessages(client, {
    mailboxId: mailbox.id,
    gmailThreadId,
    match: best,
    messages,
    index,
    mailboxFrom: mailbox.fromEmail,
  });

  if (!result.threadId) return;
  counters.threadsTouched++;
  counters.messagesUpserted += result.messagesUpserted;

  // Use the enrollment actually stored on the thread (may differ from `best`
  // when an existing stronger match was kept).
  if (
    result.hasNewInbound &&
    result.strongMatch &&
    result.enrollmentId
  ) {
    // Classify bounce/DSN vs human reply before stopping the cadence.
    let bounce = false;
    let bounceReason: string | null = null;
    for (const msg of messages) {
      const headers = msg.payload?.headers;
      const from = extractEmail(headerValue(headers, "From"));
      const subject = headerValue(headers, "Subject");
      const direction = classifyDirection(
        index,
        msg,
        from,
        mailbox.fromEmail,
      );
      if (direction !== "inbound") continue;
      if (
        isBounceInbound({
          fromEmail: from,
          subject,
          snippet: msg.snippet ?? null,
        })
      ) {
        bounce = true;
        bounceReason = (subject || msg.snippet || "Hard bounce").slice(0, 200);
        break;
      }
    }

    if (bounce) {
      const marked = await markEnrollmentBounced(client, result.enrollmentId, {
        source: "gmail_sync",
        reason: bounceReason,
      });
      if (marked.updated) counters.enrollmentsMarkedReplied++;
    } else {
      const marked = await markEnrollmentReplied(client, result.enrollmentId, {
        source: "gmail_sync",
      });
      if (marked.updated) counters.enrollmentsMarkedReplied++;
    }
  }
}

// ── Public sync API ────────────────────────────────────────────────

export async function syncMailboxInbox(
  client: SupabaseClient,
  mailboxId: string,
): Promise<InboxSyncResult> {
  const box = await getMailboxWithSecrets(client, mailboxId);
  if (!box) {
    return {
      mailboxId,
      fromEmail: "",
      ok: false,
      mode: "skipped",
      threadsTouched: 0,
      messagesUpserted: 0,
      enrollmentsMarkedReplied: 0,
      error: "Mailbox not found",
    };
  }

  if (box.authMethod !== "oauth" && box.provider !== "google_oauth") {
    return {
      mailboxId,
      fromEmail: box.fromEmail,
      ok: false,
      mode: "skipped",
      threadsTouched: 0,
      messagesUpserted: 0,
      enrollmentsMarkedReplied: 0,
      error: "Reply sync requires Google OAuth (not SMTP)",
    };
  }

  if (
    box.oauthGrantedScopes &&
    !scopesIncludeGmailReadonly(box.oauthGrantedScopes) &&
    !box.inboxSyncReady
  ) {
    // still try — token might have scope even if not recorded
  }

  let accessToken: string;
  try {
    accessToken = await ensureFreshAccessToken(client, box);
  } catch (err) {
    return {
      mailboxId,
      fromEmail: box.fromEmail,
      ok: false,
      mode: "skipped",
      threadsTouched: 0,
      messagesUpserted: 0,
      enrollmentsMarkedReplied: 0,
      error: err instanceof Error ? err.message : "Token refresh failed",
    };
  }

  const counters = {
    threadsTouched: 0,
    messagesUpserted: 0,
    enrollmentsMarkedReplied: 0,
  };

  try {
    // Probe readonly
    const profile = await fetchGmailProfile(accessToken);
    await client
      .from("outreach_mailboxes")
      .update({
        gmail_readonly_ok: true,
        updated_at: new Date().toISOString(),
      })
      .eq("id", mailboxId);

    const index = await buildSentThreadIndex(client, mailboxId, box.fromEmail);
    const knownThreadIds = [...index.byGmailThread.keys()];

    let mode: "bootstrap" | "history" = "bootstrap";
    const historyId = box.gmailHistoryId;

    if (historyId) {
      mode = "history";
      try {
        const historyMsgIds = new Set<string>();
        let pageToken: string | undefined;
        let latestHistoryId = historyId;
        // Paginate history once (cap pages)
        for (let page = 0; page < 10; page++) {
          const params = new URLSearchParams({
            startHistoryId: historyId,
            historyTypes: "messageAdded",
            maxResults: "100",
          });
          if (pageToken) params.set("pageToken", pageToken);
          const hist = await gmailGetJson<{
            history?: Array<{
              messagesAdded?: Array<{
                message?: { id?: string; threadId?: string };
              }>;
            }>;
            historyId?: string;
            nextPageToken?: string;
          }>(accessToken, `users/me/history?${params.toString()}`);

          if (hist.historyId) latestHistoryId = hist.historyId;
          for (const h of hist.history ?? []) {
            for (const added of h.messagesAdded ?? []) {
              if (added.message?.id) historyMsgIds.add(added.message.id);
            }
          }
          pageToken = hist.nextPageToken;
          if (!pageToken) break;
        }

        const threadIds = new Set<string>();
        // Resolve message → thread; prefer known threads
        for (const mid of historyMsgIds) {
          try {
            const msg = await fetchGmailMessage(accessToken, mid);
            if (msg.threadId && index.byGmailThread.has(msg.threadId)) {
              threadIds.add(msg.threadId);
            } else if (msg.threadId) {
              // Check In-Reply-To match without full index miss
              const headers = msg.payload?.headers;
              const m = matchMessage(
                index,
                msg.threadId,
                {
                  from: headerValue(headers, "From"),
                  inReplyTo: headerValue(headers, "In-Reply-To"),
                  references: headerValue(headers, "References"),
                  messageId: headerValue(headers, "Message-ID"),
                },
                box.fromEmail,
              );
              if (m.matchedHow !== "unmatched") {
                threadIds.add(msg.threadId);
              }
            }
          } catch {
            // skip individual message errors
          }
        }

        for (const tid of threadIds) {
          await processGmailThread(
            client,
            accessToken,
            box,
            index,
            tid,
            counters,
          );
        }

        await client
          .from("outreach_mailboxes")
          .update({
            gmail_history_id: latestHistoryId || profile.historyId || historyId,
            updated_at: new Date().toISOString(),
          })
          .eq("id", mailboxId);

        return {
          mailboxId,
          fromEmail: box.fromEmail,
          ok: true,
          mode,
          ...counters,
        };
      } catch (histErr) {
        const msg =
          histErr instanceof Error ? histErr.message : String(histErr);
        // historyId expired / invalid → fall back to bootstrap
        if (!/history|404|410|startHistoryId/i.test(msg)) {
          throw histErr;
        }
        mode = "bootstrap";
      }
    }

    // Bootstrap: pull all known sequence threads
    const toFetch = knownThreadIds.slice(0, BOOTSTRAP_THREAD_LIMIT);
    for (const tid of toFetch) {
      try {
        await processGmailThread(
          client,
          accessToken,
          box,
          index,
          tid,
          counters,
        );
      } catch (err) {
        console.warn(
          `[inbox] thread ${tid} sync failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    const newHistoryId = profile.historyId ?? null;
    if (newHistoryId) {
      await client
        .from("outreach_mailboxes")
        .update({
          gmail_history_id: newHistoryId,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mailboxId);
    }

    return {
      mailboxId,
      fromEmail: box.fromEmail,
      ok: true,
      mode: "bootstrap",
      ...counters,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    // Mark readonly missing if scope error
    if (/insufficient|scope|403|PERMISSION/i.test(message)) {
      await client
        .from("outreach_mailboxes")
        .update({
          gmail_readonly_ok: false,
          updated_at: new Date().toISOString(),
        })
        .eq("id", mailboxId);
    }
    return {
      mailboxId,
      fromEmail: box.fromEmail,
      ok: false,
      mode: "skipped",
      threadsTouched: 0,
      messagesUpserted: 0,
      enrollmentsMarkedReplied: 0,
      error: message,
    };
  }
}

export async function syncAllMailboxesInbox(
  client: SupabaseClient,
): Promise<InboxSyncResult[]> {
  const boxes = await listMailboxes(client);
  const oauthBoxes = boxes.filter(
    (b) =>
      b.enabled &&
      b.connected &&
      (b.authMethod === "oauth" || b.provider === "google_oauth"),
  );
  const results: InboxSyncResult[] = [];
  for (const box of oauthBoxes) {
    results.push(await syncMailboxInbox(client, box.id));
  }
  return results;
}

// ── CRUD for UI ────────────────────────────────────────────────────

export async function listReplyThreads(
  client: SupabaseClient,
  opts?: {
    status?: ReplyThreadStatus | "active" | "all";
    channel?: ReplyChannel | "all";
    mailboxId?: string;
    limit?: number;
  },
): Promise<{ threads: ReplyThread[]; newCount: number }> {
  const limit = Math.min(200, Math.max(1, opts?.limit ?? 50));
  let q = client
    .from("outreach_reply_threads")
    .select("*")
    .order("last_inbound_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (opts?.mailboxId) q = q.eq("mailbox_id", opts.mailboxId);

  const channel = opts?.channel ?? "all";
  if (channel === "email" || channel === "linkedin") {
    q = q.eq("channel", channel);
  }

  const status = opts?.status ?? "active";
  if (status === "active") {
    q = q.in("status", ["new", "open", "snoozed"]);
  } else if (status !== "all") {
    q = q.eq("status", status);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const threads = (data ?? []).map((r) =>
    mapThread(r as Record<string, unknown>),
  );

  // Attach sequence names
  const seqIds = [
    ...new Set(threads.map((t) => t.sequenceId).filter(Boolean)),
  ] as string[];
  const nameById = new Map<string, string>();
  if (seqIds.length) {
    const { data: seqs } = await client
      .from("outreach_sequences")
      .select("id, name")
      .in("id", seqIds);
    for (const s of seqs ?? []) {
      nameById.set(s.id as string, s.name as string);
    }
  }
  for (const t of threads) {
    t.sequenceName = t.sequenceId ? nameById.get(t.sequenceId) ?? null : null;
  }

  let newCountQ = client
    .from("outreach_reply_threads")
    .select("id", { count: "exact", head: true })
    .eq("status", "new");
  if (channel === "email" || channel === "linkedin") {
    newCountQ = newCountQ.eq("channel", channel);
  }
  const { count, error: cErr } = await newCountQ;
  if (cErr) throw new Error(cErr.message);

  return { threads, newCount: count ?? 0 };
}

export async function getReplyThread(
  client: SupabaseClient,
  threadId: string,
): Promise<{
  thread: ReplyThread;
  messages: ReplyMessage[];
  mailbox: Pick<
    OutreachMailboxPublic,
    "id" | "fromEmail" | "label" | "inboxSyncReady"
  > | null;
} | null> {
  const { data, error } = await client
    .from("outreach_reply_threads")
    .select("*")
    .eq("id", threadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const thread = mapThread(data as Record<string, unknown>);
  if (thread.sequenceId) {
    const { data: seq } = await client
      .from("outreach_sequences")
      .select("name")
      .eq("id", thread.sequenceId)
      .maybeSingle();
    thread.sequenceName = (seq?.name as string | undefined) ?? null;
  }

  const { data: msgs, error: mErr } = await client
    .from("outreach_reply_messages")
    .select("*")
    .eq("thread_id", threadId)
    .order("internal_date", { ascending: true, nullsFirst: false });
  if (mErr) throw new Error(mErr.message);

  const { data: box } = await client
    .from("outreach_mailboxes")
    .select("id, from_email, label, gmail_readonly_ok, oauth_granted_scopes, auth_method, provider, oauth_refresh_token_encrypted")
    .eq("id", thread.mailboxId)
    .maybeSingle();

  let mailbox: Pick<
    OutreachMailboxPublic,
    "id" | "fromEmail" | "label" | "inboxSyncReady"
  > | null = null;
  if (box) {
    const scopes = (box.oauth_granted_scopes as string | null) ?? null;
    const readonly =
      box.gmail_readonly_ok === null || box.gmail_readonly_ok === undefined
        ? scopesIncludeGmailReadonly(scopes)
        : Boolean(box.gmail_readonly_ok);
    mailbox = {
      id: box.id as string,
      fromEmail: box.from_email as string,
      label: (box.label as string) || "Outreach",
      inboxSyncReady: Boolean(
        box.oauth_refresh_token_encrypted &&
          (box.auth_method === "oauth" || box.provider === "google_oauth") &&
          readonly,
      ),
    };
  }

  return {
    thread,
    messages: (msgs ?? []).map((m) =>
      mapMessage(m as Record<string, unknown>),
    ),
    mailbox,
  };
}

export async function updateReplyThread(
  client: SupabaseClient,
  threadId: string,
  patch: {
    status?: ReplyThreadStatus;
    snoozedUntil?: string | null;
  },
): Promise<ReplyThread> {
  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };
  if (patch.status) {
    update.status = patch.status;
    if (patch.status !== "snoozed") update.snoozed_until = null;
  }
  if (patch.snoozedUntil !== undefined) {
    update.snoozed_until = patch.snoozedUntil;
    // Only coerce status when the caller did not set one explicitly.
    if (patch.snoozedUntil && !patch.status) update.status = "snoozed";
  }

  const { data, error } = await client
    .from("outreach_reply_threads")
    .update(update)
    .eq("id", threadId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapThread(data as Record<string, unknown>);
}

/** Bulk triage — mark many threads done / open / etc. */
export async function bulkUpdateReplyThreads(
  client: SupabaseClient,
  threadIds: string[],
  patch: {
    status?: ReplyThreadStatus;
    snoozedUntil?: string | null;
  },
): Promise<{ updated: number; threads: ReplyThread[] }> {
  const ids = [...new Set(threadIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return { updated: 0, threads: [] };
  if (ids.length > 200) {
    throw new Error("Bulk update limited to 200 threads");
  }

  const now = new Date().toISOString();
  const update: Record<string, unknown> = { updated_at: now };
  if (patch.status) {
    update.status = patch.status;
    if (patch.status !== "snoozed") update.snoozed_until = null;
  }
  if (patch.snoozedUntil !== undefined) {
    update.snoozed_until = patch.snoozedUntil;
    if (patch.snoozedUntil && !patch.status) update.status = "snoozed";
  }

  const { data, error } = await client
    .from("outreach_reply_threads")
    .update(update)
    .in("id", ids)
    .select("*");
  if (error) throw new Error(error.message);
  const threads = (data ?? []).map((r) =>
    mapThread(r as Record<string, unknown>),
  );
  return { updated: threads.length, threads };
}

export async function markThreadEnrollmentReplied(
  client: SupabaseClient,
  threadId: string,
): Promise<{
  thread: ReplyThread;
  enrollment: Awaited<ReturnType<typeof markEnrollmentReplied>>;
}> {
  const detail = await getReplyThread(client, threadId);
  if (!detail) throw new Error("Thread not found");
  if (!detail.thread.enrollmentId) {
    throw new Error("Thread is not linked to a sequence enrollment");
  }
  const enrollment = await markEnrollmentReplied(
    client,
    detail.thread.enrollmentId,
    { source: "manual" },
  );
  const thread = await updateReplyThread(client, threadId, { status: "open" });
  return { thread, enrollment };
}

export function gmailThreadUrl(gmailThreadId: string): string {
  return `https://mail.google.com/mail/u/0/#inbox/${gmailThreadId}`;
}
