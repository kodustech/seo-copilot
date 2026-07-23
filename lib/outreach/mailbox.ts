import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import {
  decryptToken,
  encryptToken,
  refreshAccessToken,
} from "@/lib/outreach/google-oauth";

export type MailboxProvider = "smtp" | "gmail" | "google_oauth";
export type MailboxAuthMethod = "smtp" | "oauth";

/** Safe shape for API / UI — never includes secrets. */
export type OutreachMailboxPublic = {
  id: string;
  label: string;
  fromName: string | null;
  fromEmail: string;
  provider: MailboxProvider;
  authMethod: MailboxAuthMethod;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string | null;
  /** True if SMTP password or Google OAuth is stored. */
  connected: boolean;
  hasPassword: boolean;
  dailyCap: number;
  /** When true, sequence email auto steps send via mailbox. When false, queue for human. */
  emailAutoSend: boolean;
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
  smtpPass: string | null;
  oauthRefreshToken: string | null;
  oauthAccessToken: string | null;
  oauthTokenExpiresAt: string | null;
};

function mapPublic(r: Record<string, unknown>): OutreachMailboxPublic {
  const authMethod: MailboxAuthMethod =
    (r.auth_method as MailboxAuthMethod) ||
    (r.provider === "google_oauth" ? "oauth" : "smtp");
  const hasPassword = Boolean(r.smtp_pass_encrypted);
  const hasOauth = Boolean(r.oauth_refresh_token_encrypted);
  return {
    id: r.id as string,
    label: (r.label as string) || "Outreach",
    fromName: (r.from_name as string | null) ?? null,
    fromEmail: r.from_email as string,
    provider: (r.provider as MailboxProvider) || "smtp",
    authMethod,
    smtpHost: (r.smtp_host as string) || "smtp.gmail.com",
    smtpPort: Number(r.smtp_port ?? 587),
    smtpSecure: Boolean(r.smtp_secure),
    smtpUser: (r.smtp_user as string | null) ?? null,
    connected: hasPassword || hasOauth,
    hasPassword,
    dailyCap: Number(r.daily_cap ?? 40),
    emailAutoSend: r.email_auto_send === false ? false : true,
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

async function loadMailboxRow(
  client: SupabaseClient,
  id?: string | null,
): Promise<Record<string, unknown> | null> {
  let q = client.from("outreach_mailboxes").select("*");
  if (id) {
    q = q.eq("id", id);
  } else {
    q = q.eq("enabled", true).eq("is_default", true);
  }
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data as Record<string, unknown>;

  if (!id) {
    const { data: any, error: e2 } = await client
      .from("outreach_mailboxes")
      .select("*")
      .eq("enabled", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (e2) throw new Error(e2.message);
    return (any as Record<string, unknown>) ?? null;
  }
  return null;
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
  const row = await loadMailboxRow(client, null);
  return row ? mapPublic(row) : null;
}

/** Load mailbox + decrypted secrets (server-only). */
export async function getMailboxWithSecrets(
  client: SupabaseClient,
  id?: string | null,
): Promise<OutreachMailboxSecrets | null> {
  const row = await loadMailboxRow(client, id);
  if (!row) return null;

  const pub = mapPublic(row);
  const smtpEnc = row.smtp_pass_encrypted as string | null | undefined;
  const refreshEnc = row.oauth_refresh_token_encrypted as
    | string
    | null
    | undefined;
  const accessEnc = row.oauth_access_token_encrypted as
    | string
    | null
    | undefined;

  if (pub.authMethod === "oauth" || pub.provider === "google_oauth") {
    if (!refreshEnc) throw new Error("Mailbox has no Google connection");
    return {
      ...pub,
      smtpPass: null,
      oauthRefreshToken: decryptToken(refreshEnc),
      oauthAccessToken: accessEnc ? decryptToken(accessEnc) : null,
      oauthTokenExpiresAt:
        (row.oauth_token_expires_at as string | null) ?? null,
    };
  }

  if (!smtpEnc) throw new Error("Mailbox has no password stored");
  return {
    ...pub,
    smtpPass: decryptSecret(smtpEnc),
    oauthRefreshToken: null,
    oauthAccessToken: null,
    oauthTokenExpiresAt: null,
  };
}

/**
 * Ensure a valid access token for OAuth mailbox (refreshes if needed).
 */
export async function ensureFreshAccessToken(
  client: SupabaseClient,
  box: OutreachMailboxSecrets,
): Promise<string> {
  if (!box.oauthRefreshToken) {
    throw new Error("No Google refresh token — reconnect the mailbox");
  }
  const expiresAt = box.oauthTokenExpiresAt
    ? new Date(box.oauthTokenExpiresAt).getTime()
    : 0;
  const stillValid =
    box.oauthAccessToken && expiresAt > Date.now() + 60_000;
  if (stillValid && box.oauthAccessToken) return box.oauthAccessToken;

  const refreshed = await refreshAccessToken(box.oauthRefreshToken);
  await client
    .from("outreach_mailboxes")
    .update({
      oauth_access_token_encrypted: encryptToken(refreshed.accessToken),
      oauth_token_expires_at: refreshed.expiresAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", box.id);
  return refreshed.accessToken;
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
  smtpUser?: string;
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
  const smtpUser = (input.smtpUser ?? fromEmail).trim();
  if (!smtpUser) throw new Error("smtp_user is required");

  const provider: MailboxProvider =
    input.provider === "gmail"
      ? "gmail"
      : input.provider === "google_oauth"
        ? "google_oauth"
        : "smtp";
  if (provider === "google_oauth") {
    throw new Error("Use Connect with Google for OAuth mailboxes");
  }

  const host = input.smtpHost?.trim() || "smtp.gmail.com";
  const port = input.smtpPort ?? 587;
  const secure = input.smtpSecure ?? false;
  const dailyCap = Math.min(500, Math.max(1, input.dailyCap ?? 40));
  const label = (input.label?.trim() || "Outreach mailbox").slice(0, 80);
  const smtpHost = provider === "gmail" ? "smtp.gmail.com" : host;
  const smtpPort = provider === "gmail" ? 587 : port;

  if (input.id) {
    const patch: Record<string, unknown> = {
      label,
      from_name: input.fromName?.trim() || null,
      from_email: fromEmail,
      provider,
      auth_method: "smtp",
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
      auth_method: "smtp",
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

/** Upsert mailbox from Google OAuth tokens (Connect with Google). */
export async function upsertMailboxFromGoogleOAuth(
  client: SupabaseClient,
  input: {
    email: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date;
    fromName?: string | null;
    label?: string;
    dailyCap?: number;
    createdByEmail?: string | null;
  },
): Promise<OutreachMailboxPublic> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new Error("Invalid Google email");

  // Reconnecting the same inbox updates it; a different Google account adds
  // another mailbox instead of overwriting the workspace default.
  const { data: byEmail, error: byEmailError } = await client
    .from("outreach_mailboxes")
    .select("*")
    .eq("from_email", email)
    .maybeSingle();
  if (byEmailError) throw new Error(byEmailError.message);
  const existing = (byEmail as Record<string, unknown> | null) ?? null;
  const defaultMailbox = await getDefaultMailbox(client);
  const dailyCap = Math.min(500, Math.max(1, input.dailyCap ?? 40));
  const label = (input.label?.trim() || "Outreach").slice(0, 80);

  if (!input.refreshToken && !existing) {
    throw new Error(
      "Google did not return a refresh token. Disconnect the app in Google Account → Security → Third-party access, then Connect again.",
    );
  }

  const tokenPatch: Record<string, unknown> = {
    label,
    from_name: input.fromName?.trim() || null,
    from_email: email,
    provider: "google_oauth",
    auth_method: "oauth",
    smtp_host: "smtp.gmail.com",
    smtp_port: 587,
    smtp_secure: false,
    smtp_user: email,
    smtp_pass_encrypted: null,
    oauth_access_token_encrypted: encryptToken(input.accessToken),
    oauth_token_expires_at: input.expiresAt.toISOString(),
    daily_cap: dailyCap,
    is_default: existing ? Boolean(existing.is_default) : !defaultMailbox,
    enabled: true,
    last_test_ok: true,
    last_tested_at: new Date().toISOString(),
    last_test_error: null,
    updated_at: new Date().toISOString(),
  };
  if (input.refreshToken) {
    tokenPatch.oauth_refresh_token_encrypted = encryptToken(input.refreshToken);
  }

  if (existing) {
    const { data, error } = await client
      .from("outreach_mailboxes")
      .update(tokenPatch)
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) throw new Error(error.message);
    return mapPublic(data as Record<string, unknown>);
  }

  if (!input.refreshToken) {
    throw new Error(
      "Google did not return a refresh token. Revoke app access and try again with prompt=consent.",
    );
  }

  const { data, error } = await client
    .from("outreach_mailboxes")
    .insert({
      ...tokenPatch,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapPublic(data as Record<string, unknown>);
}

export async function isEmailAutoSendEnabled(
  client: SupabaseClient,
  mailboxId?: string | null,
): Promise<boolean> {
  const row = await loadMailboxRow(client, mailboxId);
  const box = row ? mapPublic(row) : null;
  if (!box) return true;
  return box.enabled && box.emailAutoSend !== false;
}

export async function updateMailboxMeta(
  client: SupabaseClient,
  id: string,
  patch: {
    label?: string;
    fromName?: string | null;
    dailyCap?: number;
    emailAutoSend?: boolean;
    enabled?: boolean;
  },
): Promise<OutreachMailboxPublic> {
  const body: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (patch.label != null) body.label = patch.label.trim().slice(0, 80);
  if (patch.fromName !== undefined) {
    body.from_name = patch.fromName?.trim() || null;
  }
  if (patch.dailyCap != null) {
    body.daily_cap = Math.min(500, Math.max(1, patch.dailyCap));
  }
  if (patch.emailAutoSend !== undefined) {
    body.email_auto_send = patch.emailAutoSend;
  }
  if (patch.enabled !== undefined) body.enabled = patch.enabled;

  const { data, error } = await client
    .from("outreach_mailboxes")
    .update(body)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return mapPublic(data as Record<string, unknown>);
}

export async function deleteMailbox(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("outreach_mailboxes")
    .delete()
    .eq("id", id);
  if (error) throw new Error(error.message);
}

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

  if (date !== today) sent = 0;
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
