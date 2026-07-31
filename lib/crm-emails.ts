/**
 * Email history for a CRM company via Gmail search across all connected
 * mailboxes that have gmail.readonly (inboxSyncReady).
 *
 * Primitive: search every ready mailbox with the same domain/contact query.
 * No per-company mailbox config.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { getCompany, listContacts, normalizeDomain } from "@/lib/crm";
import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
  listMailboxes,
  type OutreachMailboxPublic,
} from "@/lib/outreach/mailbox";

export type CompanyEmailDirection = "outbound" | "inbound";

export type CompanyEmailItem = {
  id: string;
  direction: CompanyEmailDirection;
  at: string;
  fromEmail: string | null;
  toEmail: string | null;
  subject: string | null;
  snippet: string | null;
  bodyText: string | null;
  source: "gmail";
  /** Mailbox that held this message (trykodus, kodus.io, …) */
  mailboxEmail: string;
  mailboxId: string;
  sequenceName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  status: string | null;
  threadId: string | null;
  gmailThreadId: string | null;
};

export type MailboxSearchResult = {
  id: string;
  fromEmail: string;
  ok: boolean;
  messageCount: number;
  error?: string;
  skipped?: boolean;
  skipReason?: string;
};

export type CompanyEmailTimeline = {
  companyId: string;
  query: string | null;
  match: {
    domain: string | null;
    contactEmails: string[];
    companyName: string;
  };
  mailboxes: MailboxSearchResult[];
  items: CompanyEmailItem[];
  counts: {
    total: number;
    outbound: number;
    inbound: number;
    threads: number;
  };
};

const MAX_PER_MAILBOX = 40;
const BODY_TEXT_MAX = 40_000;

// ── small Gmail helpers (local; mirror inbox.ts) ───────────────────

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

function extractTextBody(msg: GmailMessage): string | null {
  const acc = { text: [] as string[], html: [] as string[] };
  walkParts(msg.payload, acc);
  if (!acc.text.length && !acc.html.length && msg.payload?.body?.data) {
    const mime = (msg.payload.mimeType || "").toLowerCase();
    const raw = decodeBodyData(msg.payload.body.data);
    if (mime.includes("html")) acc.html.push(raw);
    else acc.text.push(raw);
  }
  const text = acc.text.join("\n\n").trim();
  if (text) return text.slice(0, BODY_TEXT_MAX);
  // strip crude html
  const html = acc.html.join("\n").trim();
  if (!html) return null;
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, BODY_TEXT_MAX);
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

function preview(text: string | null | undefined, max = 220): string | null {
  if (!text) return null;
  const one = text.replace(/\s+/g, " ").trim();
  if (!one) return null;
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

async function gmailGetJson<T>(
  accessToken: string,
  path: string,
): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = (await res.json()) as T & {
    error?: { message?: string };
  };
  if (!res.ok) {
    throw new Error(
      data.error?.message || `Gmail API ${res.status} on ${path}`,
    );
  }
  return data;
}

/**
 * Build a Gmail search query for the company.
 * https://support.google.com/mail/answer/7190
 */
export function buildCompanyGmailQuery(opts: {
  domain: string | null;
  contactEmails: string[];
}): string | null {
  const parts: string[] = [];
  if (opts.domain) {
    const d = opts.domain.replace(/[(){}]/g, "");
    // Domain match on either side of the conversation
    parts.push(`(from:${d} OR to:${d} OR cc:${d})`);
  }
  for (const email of opts.contactEmails.slice(0, 12)) {
    const e = email.replace(/[(){}]/g, "").toLowerCase();
    if (!e.includes("@")) continue;
    parts.push(`(from:${e} OR to:${e} OR cc:${e})`);
  }
  if (parts.length === 0) return null;
  return parts.join(" OR ");
}

async function searchMailboxMessages(
  client: SupabaseClient,
  box: OutreachMailboxPublic,
  query: string,
): Promise<{ items: CompanyEmailItem[]; error?: string }> {
  if (!box.inboxSyncReady) {
    return {
      items: [],
      error: "Connect Gmail with read access (reconnect mailbox)",
    };
  }

  let secrets;
  try {
    secrets = await getMailboxWithSecrets(client, box.id);
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : "Mailbox secrets missing",
    };
  }
  if (!secrets) {
    return { items: [], error: "Mailbox not found" };
  }

  let accessToken: string;
  try {
    accessToken = await ensureFreshAccessToken(client, secrets);
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : "Token refresh failed",
    };
  }

  const ourEmail = box.fromEmail.toLowerCase();
  const q = encodeURIComponent(query);
  let list: { messages?: Array<{ id?: string; threadId?: string }> };
  try {
    list = await gmailGetJson(
      accessToken,
      `users/me/messages?q=${q}&maxResults=${MAX_PER_MAILBOX}`,
    );
  } catch (err) {
    return {
      items: [],
      error: err instanceof Error ? err.message : "Gmail list failed",
    };
  }

  const ids = (list.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  const items: CompanyEmailItem[] = [];
  // Parallel with modest concurrency
  const concurrency = 5;
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (id) => {
        try {
          return await gmailGetJson<GmailMessage>(
            accessToken,
            `users/me/messages/${encodeURIComponent(id)}?format=full`,
          );
        } catch {
          return null;
        }
      }),
    );

    for (const msg of results) {
      if (!msg?.id) continue;
      const headers = msg.payload?.headers;
      const fromRaw = headerValue(headers, "From");
      const toRaw = headerValue(headers, "To");
      const subject = headerValue(headers, "Subject");
      const fromEmail = extractEmail(fromRaw);
      const toList = parseAddressList(toRaw);
      const toEmail = toList[0] ?? null;
      const direction: CompanyEmailDirection =
        fromEmail && fromEmail === ourEmail ? "outbound" : "inbound";
      const atMs = msg.internalDate
        ? Number(msg.internalDate)
        : Date.now();
      const at = new Date(Number.isFinite(atMs) ? atMs : Date.now()).toISOString();
      const bodyText = extractTextBody(msg);
      const snippet = msg.snippet?.trim() || preview(bodyText);

      items.push({
        id: `gmail:${box.id}:${msg.id}`,
        direction,
        at,
        fromEmail,
        toEmail,
        subject,
        snippet,
        bodyText,
        source: "gmail",
        mailboxEmail: box.fromEmail,
        mailboxId: box.id,
        sequenceName: null,
        contactEmail: direction === "inbound" ? fromEmail : toEmail,
        contactName: null,
        status: null,
        threadId: null,
        gmailThreadId: msg.threadId ?? null,
      });
    }
  }

  return { items };
}

/**
 * Search all Gmail-ready mailboxes for messages related to this CRM company.
 */
export async function getCompanyEmailTimeline(
  client: SupabaseClient,
  companyId: string,
): Promise<CompanyEmailTimeline | null> {
  const company = await getCompany(client, companyId);
  if (!company) return null;

  const contacts = await listContacts(client, companyId);
  const domain = normalizeDomain(company.domain);
  const contactEmails = [
    ...new Set(
      contacts
        .map((c) => c.email?.trim().toLowerCase())
        .filter((e): e is string => Boolean(e)),
    ),
  ];

  const query = buildCompanyGmailQuery({ domain, contactEmails });
  const allBoxes = (await listMailboxes(client)).filter((b) => b.enabled);
  const mailboxes: MailboxSearchResult[] = [];
  const items: CompanyEmailItem[] = [];

  if (!query) {
    return {
      companyId,
      query: null,
      match: {
        domain,
        contactEmails,
        companyName: company.name,
      },
      mailboxes: allBoxes.map((b) => ({
        id: b.id,
        fromEmail: b.fromEmail,
        ok: false,
        messageCount: 0,
        skipped: true,
        skipReason: "Add a domain or contact emails on this account first",
      })),
      items: [],
      counts: { total: 0, outbound: 0, inbound: 0, threads: 0 },
    };
  }

  // Search every enabled mailbox; non-readonly ones report skip reason.
  for (const box of allBoxes) {
    if (!box.inboxSyncReady) {
      mailboxes.push({
        id: box.id,
        fromEmail: box.fromEmail,
        ok: false,
        messageCount: 0,
        skipped: true,
        skipReason:
          "Gmail read not connected — reconnect with Google and grant mail.readonly",
      });
      continue;
    }

    const result = await searchMailboxMessages(client, box, query);
    if (result.error) {
      mailboxes.push({
        id: box.id,
        fromEmail: box.fromEmail,
        ok: false,
        messageCount: 0,
        error: result.error,
      });
      continue;
    }
    mailboxes.push({
      id: box.id,
      fromEmail: box.fromEmail,
      ok: true,
      messageCount: result.items.length,
    });
    items.push(...result.items);
  }

  // Dedup same rfc-ish identity across mailboxes: same gmail message can't
  // appear twice in one mailbox; across mailboxes keep both (different boxes).
  items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const threadSet = new Set(
    items.map((i) => i.gmailThreadId).filter(Boolean) as string[],
  );
  const outbound = items.filter((i) => i.direction === "outbound").length;
  const inbound = items.filter((i) => i.direction === "inbound").length;

  return {
    companyId,
    query,
    match: {
      domain,
      contactEmails,
      companyName: company.name,
    },
    mailboxes,
    items,
    counts: {
      total: items.length,
      outbound,
      inbound,
      threads: threadSet.size,
    },
  };
}
