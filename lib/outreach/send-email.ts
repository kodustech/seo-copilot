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

export type SendOutreachEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  mailboxId?: string | null;
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
      });
      return {
        ok: true,
        messageId: sent.messageId,
        mailboxId: box.id,
        from: box.fromEmail,
      };
    }

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
      error: err instanceof Error ? err.message : "Send failed",
      code: "smtp",
    };
  }
}
