import nodemailer from "nodemailer";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  getMailboxWithSecrets,
  recordTestResult,
  reserveDailySend,
  type OutreachMailboxSecrets,
} from "@/lib/outreach/mailbox";

function buildTransport(box: OutreachMailboxSecrets) {
  return nodemailer.createTransport({
    host: box.smtpHost,
    port: box.smtpPort,
    secure: box.smtpSecure,
    auth: {
      user: box.smtpUser,
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

export type SendOutreachEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  mailboxId?: string | null;
  /** Skip daily cap (e.g. test email). */
  skipCap?: boolean;
};

export type SendOutreachEmailResult =
  | {
      ok: true;
      messageId: string;
      mailboxId: string;
      from: string;
    }
  | { ok: false; error: string; code?: "no_mailbox" | "cap" | "smtp" };

/**
 * Send one outreach email via the product-configured mailbox (Settings).
 */
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
        "No outreach mailbox configured. Add one in Settings → Outreach email.",
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

  try {
    const transport = buildTransport(box);
    const info = await transport.sendMail({
      from,
      to,
      subject: input.subject || "(no subject)",
      text: input.text,
      html: input.html ?? undefined,
      headers: {
        "X-Kodus-Outreach": "sequence",
      },
    });
    return {
      ok: true,
      messageId: String(info.messageId ?? ""),
      mailboxId: box.id,
      from: box.fromEmail,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "SMTP send failed",
      code: "smtp",
    };
  }
}
