import { randomBytes } from "crypto";

import nodemailer from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ensureFreshAccessToken,
  getMailboxWithSecrets,
  recordTestResult,
  reserveDailySend,
  type OutreachMailboxSecrets,
} from "@/lib/outreach/mailbox";
import { sendViaGmailApi } from "@/lib/outreach/google-oauth";

function buildTransport(box: OutreachMailboxSecrets) {
  if (!box.smtpPass) throw new Error("SMTP password missing");
  return nodemailer.createTransport({
    host: box.smtpHost,
    port: box.smtpPort,
    secure: box.smtpSecure,
    auth: {
      user: box.smtpUser || box.fromEmail,
      pass: box.smtpPass,
    },
  });
}

export async function testMailboxConnection(
  client: SupabaseClient,
  mailboxId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const box = await getMailboxWithSecrets(client, mailboxId);
    if (!box) return { ok: false, error: "Mailbox not found" };

    if (box.authMethod === "oauth" || box.provider === "google_oauth") {
      const access = await ensureFreshAccessToken(client, box);
      // lightweight profile check
      const res = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        { headers: { Authorization: `Bearer ${access}` } },
      );
      if (!res.ok) {
        throw new Error("Google token invalid — reconnect the mailbox");
      }
      await recordTestResult(client, mailboxId, { ok: true });
      return { ok: true };
    }

    const transport = buildTransport(box);
    await transport.verify();
    await recordTestResult(client, mailboxId, { ok: true });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    try {
      await recordTestResult(client, mailboxId, { ok: false, error: message });
    } catch {
      /* ignore */
    }
    return { ok: false, error: message };
  }
}

/** Threading context so follow-ups stay in one conversation. */
export type EmailThreadContext = {
  /** Previous message RFC Message-ID (In-Reply-To) */
  inReplyTo?: string | null;
  /** Full References chain (space-separated Message-IDs) */
  references?: string | null;
  /** Gmail-only: keep in same thread */
  gmailThreadId?: string | null;
};

export type SendOutreachEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  mailboxId?: string | null;
  skipCap?: boolean;
  /** Reply-in-thread headers / Gmail threadId */
  thread?: EmailThreadContext | null;
};

export type SendOutreachEmailResult =
  | {
      ok: true;
      messageId: string;
      mailboxId: string;
      from: string;
      /** RFC 5322 Message-ID (for In-Reply-To on next send) */
      rfcMessageId: string;
      gmailThreadId: string | null;
    }
  | { ok: false; error: string; code?: "no_mailbox" | "cap" | "smtp" };

function domainFromEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at > 0 ? email.slice(at + 1).toLowerCase() : "kodus.local";
}

/** Generate a unique RFC Message-ID we control. */
export function generateRfcMessageId(fromEmail: string): string {
  const id = randomBytes(12).toString("hex");
  const domain = domainFromEmail(fromEmail);
  return `<kodus.${id}@${domain}>`;
}

function normalizeMsgId(id: string): string {
  const t = id.trim();
  if (!t) return t;
  return t.startsWith("<") ? t : `<${t}>`;
}

export async function sendOutreachEmail(
  client: SupabaseClient,
  input: SendOutreachEmailInput,
): Promise<SendOutreachEmailResult> {
  const to = input.to.trim();
  if (!to.includes("@")) {
    return { ok: false, error: "Invalid recipient email", code: "smtp" };
  }

  let box: OutreachMailboxSecrets | null;
  try {
    box = await getMailboxWithSecrets(client, input.mailboxId);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Mailbox load failed",
      code: "no_mailbox",
    };
  }
  if (!box || !box.enabled) {
    return {
      ok: false,
      error:
        "No outreach mailbox configured. Connect Gmail in Settings → Outreach email.",
      code: "no_mailbox",
    };
  }

  if (!input.skipCap) {
    const cap = await reserveDailySend(client, box.id);
    if (!cap.ok) {
      return { ok: false, error: cap.reason, code: "cap" };
    }
  }

  const from = box.fromName
    ? `${box.fromName} <${box.fromEmail}>`
    : box.fromEmail;

  const rfcMessageId = generateRfcMessageId(box.fromEmail);
  const inReplyTo = input.thread?.inReplyTo?.trim()
    ? normalizeMsgId(input.thread.inReplyTo)
    : null;
  let references = input.thread?.references?.trim() || null;
  if (inReplyTo) {
    const prev = (references ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map(normalizeMsgId);
    if (!prev.includes(inReplyTo)) prev.push(inReplyTo);
    references = prev.join(" ");
  }

  try {
    if (box.authMethod === "oauth" || box.provider === "google_oauth") {
      const access = await ensureFreshAccessToken(client, box);
      const sent = await sendViaGmailApi({
        accessToken: access,
        from,
        to,
        subject: input.subject || "(no subject)",
        text: input.text,
        html: input.html,
        thread: {
          messageId: rfcMessageId,
          inReplyTo,
          references,
        },
        gmailThreadId: input.thread?.gmailThreadId,
      });
      return {
        ok: true,
        messageId: sent.messageId,
        mailboxId: box.id,
        from: box.fromEmail,
        rfcMessageId: sent.rfcMessageId ?? rfcMessageId,
        gmailThreadId: sent.gmailThreadId,
      };
    }

    const transport = buildTransport(box);
    const info = await transport.sendMail({
      from,
      to,
      subject: input.subject || "(no subject)",
      text: input.text,
      html: input.html ?? undefined,
      messageId: rfcMessageId.replace(/^<|>$/g, ""),
      inReplyTo: inReplyTo ?? undefined,
      references: references ?? undefined,
      headers: {
        "X-Kodus-Outreach": "sequence",
        ...(inReplyTo ? { "In-Reply-To": inReplyTo } : {}),
        ...(references ? { References: references } : {}),
      },
    });
    const smtpMid = info.messageId
      ? normalizeMsgId(String(info.messageId))
      : rfcMessageId;
    return {
      ok: true,
      messageId: smtpMid,
      mailboxId: box.id,
      from: box.fromEmail,
      rfcMessageId: smtpMid,
      gmailThreadId: null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Send failed",
      code: "smtp",
    };
  }
}
