import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";

export type MailboxProvider = "smtp" | "gmail";

/** Safe shape for API / UI — never includes password. */
export type OutreachMailboxPublic = {
  id: string;
  label: string;
  fromName: string | null;
  fromEmail: string;
  provider: MailboxProvider;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  hasPassword: boolean;
  dailyCap: number;
  isDefault: boolean;
  enabled: boolean;
  sentToday: number;
  sentTodayDate: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
  lastTestError: string | null;
  lastSentAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OutreachMailboxSecrets = OutreachMailboxPublic & {
  smtpPass: string;
};

function mapPublic(r: Record<string, unknown>): OutreachMailboxPublic {
  return {
    id: r.id as string,
    label: (r.label as string) || "Outreach",
    fromName: (r.from_name as string | null) ?? null,
    fromEmail: r.from_email as string,
    provider: (r.provider as MailboxProvider) || "smtp",
    smtpHost: (r.smtp_host as string) || "smtp.gmail.com",
    smtpPort: Number(r.smtp_port ?? 587),
    smtpSecure: Boolean(r.smtp_secure),
    smtpUser: r.smtp_user as string,
    hasPassword: Boolean(r.smtp_pass_encrypted),
    dailyCap: Number(r.daily_cap ?? 40),
    isDefault: Boolean(r.is_default),
    enabled: Boolean(r.enabled ?? true),
    sentToday: Number(r.sent_today ?? 0),
    sentTodayDate: (r.sent_today_date as string | null) ?? null,
    lastTestedAt: (r.last_tested_at as string | null) ?? null,
    lastTestOk:
      r.last_test_ok === null || r.last_test_ok === undefined
        ? null
        : Boolean(r.last_test_ok),
    lastTestError: (r.last_test_error as string | null) ?? null,
    lastSentAt: (r.last_sent_at as string | null) ?? null,
    createdByEmail: (r.created_by_email as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

export async function listMailboxes(
  client: SupabaseClient,
): Promise<OutreachMailboxPublic[]> {
  const { data, error } = await client
    .from("outreach_mailboxes")
    .select("*")
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => mapPublic(r as Record<string, unknown>));
}

export async function getDefaultMailbox(
  client: SupabaseClient,
): Promise<OutreachMailboxPublic | null> {
  const { data, error } = await client
    .from("outreach_mailboxes")
    .select("*")
    .eq("enabled", true)
    .eq("is_default", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return mapPublic(data as Record<string, unknown>);

  const { data: any, error: e2 } = await client
    .from("outreach_mailboxes")
    .select("*")
    .eq("enabled", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e2) throw new Error(e2.message);
  return any ? mapPublic(any as Record<string, unknown>) : null;
}

/** Load mailbox + decrypted password (server-only). */
export async function getMailboxWithSecrets(
  client: SupabaseClient,
  id?: string | null,
): Promise<OutreachMailboxSecrets | null> {
  let q = client.from("outreach_mailboxes").select("*");
  if (id) {
    q = q.eq("id", id);
  } else {
    q = q.eq("enabled", true).eq("is_default", true);
  }
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);

  let row = data;
  if (!row && !id) {
    const { data: any } = await client
      .from("outreach_mailboxes")
      .select("*")
      .eq("enabled", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    row = any;
  }
  if (!row) return null;

  const pub = mapPublic(row as Record<string, unknown>);
  const enc = (row as { smtp_pass_encrypted?: string }).smtp_pass_encrypted;
  if (!enc) throw new Error("Mailbox has no password stored");
  return { ...pub, smtpPass: decryptSecret(enc) };
}

export type UpsertMailboxInput = {
  id?: string;
  label?: string;
  fromName?: string | null;
  fromEmail: string;
  provider?: MailboxProvider;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser: string;
  /** Required on create; optional on update (keeps existing if omitted). */
  smtpPass?: string | null;
  dailyCap?: number;
  isDefault?: boolean;
  enabled?: boolean;
  createdByEmail?: string | null;
};

export async function upsertMailbox(
  client: SupabaseClient,
  input: UpsertMailboxInput,
): Promise<OutreachMailboxPublic> {
  const fromEmail = input.fromEmail.trim().toLowerCase();
  if (!fromEmail.includes("@")) throw new Error("from_email is invalid");
  const smtpUser = input.smtpUser.trim();
  if (!smtpUser) throw new Error("smtp_user is required");

  const provider: MailboxProvider =
    input.provider === "gmail" ? "gmail" : "smtp";
  const host =
    input.smtpHost?.trim() ||
    (provider === "gmail" ? "smtp.gmail.com" : "smtp.gmail.com");
  const port = input.smtpPort ?? 587;
  const secure = input.smtpSecure ?? false;
  const dailyCap = Math.min(500, Math.max(1, input.dailyCap ?? 40));
  const label = (input.label?.trim() || "Outreach mailbox").slice(0, 80);

  // Gmail preset
  const smtpHost = provider === "gmail" ? "smtp.gmail.com" : host;
  const smtpPort = provider === "gmail" ? 587 : port;

  if (input.id) {
    const patch: Record<string, unknown> = {
      label,
      from_name: input.fromName?.trim() || null,
      from_email: fromEmail,
      provider,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_secure: provider === "gmail" ? false : secure,
      smtp_user: smtpUser,
      daily_cap: dailyCap,
      enabled: input.enabled !== false,
      updated_at: new Date().toISOString(),
    };
    if (input.smtpPass && input.smtpPass.trim()) {
      patch.smtp_pass_encrypted = encryptSecret(input.smtpPass.trim());
    }
    if (input.isDefault) {
      await client
        .from("outreach_mailboxes")
        .update({ is_default: false })
        .neq("id", input.id);
      patch.is_default = true;
    }

    const { data, error } = await client
      .from("outreach_mailboxes")
      .update(patch)
      .eq("id", input.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapPublic(data as Record<string, unknown>);
  }

  if (!input.smtpPass?.trim()) {
    throw new Error("Password / app password is required");
  }

  if (input.isDefault !== false) {
    await client
      .from("outreach_mailboxes")
      .update({ is_default: false })
      .eq("is_default", true);
  }

  const { data, error } = await client
    .from("outreach_mailboxes")
    .insert({
      label,
      from_name: input.fromName?.trim() || null,
      from_email: fromEmail,
      provider,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_secure: provider === "gmail" ? false : secure,
      smtp_user: smtpUser,
      smtp_pass_encrypted: encryptSecret(input.smtpPass.trim()),
      daily_cap: dailyCap,
      is_default: input.isDefault !== false,
      enabled: input.enabled !== false,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapPublic(data as Record<string, unknown>);
}

export async function deleteMailbox(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client.from("outreach_mailboxes").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Reset daily counter if date rolled over; return remaining capacity. */
export async function reserveDailySend(
  client: SupabaseClient,
  mailboxId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await client
    .from("outreach_mailboxes")
    .select("*")
    .eq("id", mailboxId)
    .single();
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  const cap = Number(row.daily_cap ?? 40);
  let sent = Number(row.sent_today ?? 0);
  const date = row.sent_today_date as string | null;

  if (date !== today) {
    sent = 0;
  }
  if (sent >= cap) {
    return {
      ok: false,
      reason: `Daily cap reached (${cap}). Raise the cap in Settings or wait until tomorrow.`,
    };
  }

  const { error: uerr } = await client
    .from("outreach_mailboxes")
    .update({
      sent_today: sent + 1,
      sent_today_date: today,
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", mailboxId);
  if (uerr) throw new Error(uerr.message);
  return { ok: true };
}

export async function recordTestResult(
  client: SupabaseClient,
  id: string,
  result: { ok: boolean; error?: string },
): Promise<void> {
  await client
    .from("outreach_mailboxes")
    .update({
      last_tested_at: new Date().toISOString(),
      last_test_ok: result.ok,
      last_test_error: result.ok ? null : (result.error ?? "Test failed"),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
}
