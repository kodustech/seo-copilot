/**
 * Unipile client — LinkedIn (and multi-channel) messaging for Convert.
 * Env: UNIPILE_API_KEY, UNIPILE_DSN (host:port, e.g. api50.unipile.com:18044)
 */

import { getAppBaseUrl } from "@/lib/outreach/google-oauth";

export type UnipileAccount = {
  id: string;
  type: string;
  name: string | null;
  createdAt: string | null;
  sources: Array<{ id?: string; status?: string }>;
  /** LinkedIn public identifier / vanity when available */
  publicIdentifier: string | null;
  username: string | null;
  connectionStatus: string | null;
  raw: Record<string, unknown>;
};

function requireConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.UNIPILE_API_KEY?.trim();
  const dsn = process.env.UNIPILE_DSN?.trim();
  if (!apiKey) throw new Error("UNIPILE_API_KEY is not set");
  if (!dsn) throw new Error("UNIPILE_DSN is not set");
  const host = dsn.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return { apiKey, baseUrl: `https://${host}` };
}

export function isUnipileConfigured(): boolean {
  return Boolean(
    process.env.UNIPILE_API_KEY?.trim() && process.env.UNIPILE_DSN?.trim(),
  );
}

export async function unipileFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { apiKey, baseUrl } = requireConfig();
  const url = path.startsWith("http")
    ? path
    : `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("X-API-KEY", apiKey);
  headers.set("accept", "application/json");
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      data &&
      typeof data === "object" &&
      data !== null &&
      "message" in data &&
      typeof (data as { message: unknown }).message === "string"
        ? (data as { message: string }).message
        : data &&
            typeof data === "object" &&
            data !== null &&
            "title" in data &&
            typeof (data as { title: unknown }).title === "string"
          ? (data as { title: string }).title
          : `Unipile ${res.status}`;
    throw new Error(msg);
  }
  return data as T;
}

function mapAccount(raw: Record<string, unknown>): UnipileAccount {
  const connection = (raw.connection_params ?? {}) as Record<string, unknown>;
  const im = (connection.im ?? connection) as Record<string, unknown>;
  const sources = Array.isArray(raw.sources)
    ? (raw.sources as Array<{ id?: string; status?: string }>)
    : [];
  const statusFromSources = sources[0]?.status ?? null;
  return {
    id: String(raw.id ?? raw.account_id ?? ""),
    type: String(raw.type ?? raw.account_type ?? "UNKNOWN"),
    name:
      (typeof raw.name === "string" && raw.name) ||
      (typeof im.username === "string" && im.username) ||
      null,
    createdAt:
      typeof raw.created_at === "string"
        ? raw.created_at
        : typeof raw.createdAt === "string"
          ? raw.createdAt
          : null,
    sources,
    publicIdentifier:
      typeof im.publicIdentifier === "string" ? im.publicIdentifier : null,
    username: typeof im.username === "string" ? im.username : null,
    connectionStatus:
      typeof raw.connection_status === "string"
        ? raw.connection_status
        : statusFromSources,
    raw,
  };
}

export async function listUnipileAccounts(): Promise<UnipileAccount[]> {
  const data = await unipileFetch<{
    items?: Record<string, unknown>[];
    object?: string;
  }>("/api/v1/accounts");
  const items = data.items ?? [];
  return items.map((r) => mapAccount(r));
}

export async function listLinkedInAccounts(): Promise<UnipileAccount[]> {
  const all = await listUnipileAccounts();
  return all.filter((a) => a.type.toUpperCase().includes("LINKEDIN"));
}

export async function createHostedAuthLink(opts: {
  type?: "create" | "reconnect";
  reconnectAccountId?: string;
  userEmail: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  notifyUrl: string;
  expiresInMinutes?: number;
}): Promise<{ url: string }> {
  const { baseUrl } = requireConfig();
  const expires = new Date(
    Date.now() + (opts.expiresInMinutes ?? 60) * 60_000,
  ).toISOString();

  const body: Record<string, unknown> = {
    type: opts.type ?? "create",
    providers: ["LINKEDIN"],
    api_url: baseUrl,
    expiresOn: expires,
    success_redirect_url: opts.successRedirectUrl,
    failure_redirect_url: opts.failureRedirectUrl,
    notify_url: opts.notifyUrl,
    name: opts.userEmail,
  };
  if (opts.type === "reconnect" && opts.reconnectAccountId) {
    body.reconnect_account = opts.reconnectAccountId;
  }

  const data = await unipileFetch<{ url?: string; object?: string }>(
    "/api/v1/hosted/accounts/link",
    { method: "POST", body: JSON.stringify(body) },
  );
  if (!data.url) throw new Error("Unipile did not return a hosted auth URL");
  return { url: data.url };
}

export async function deleteUnipileAccount(accountId: string): Promise<void> {
  await unipileFetch(`/api/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}

export type UnipileWebhookPayload = {
  account_id?: string;
  account_type?: string;
  account_info?: {
    type?: string;
    feature?: string;
    user_id?: string;
  };
  event?: string;
  chat_id?: string;
  timestamp?: string;
  message_id?: string;
  message?: string;
  sender?: {
    attendee_id?: string;
    attendee_name?: string;
    attendee_provider_id?: string;
    attendee_profile_url?: string;
  };
  attendees?: Array<{
    attendee_id?: string;
    attendee_name?: string;
    attendee_provider_id?: string;
    attendee_profile_url?: string;
  }>;
};

/** Normalize LinkedIn profile URL / public id for matching. */
export function normalizeLinkedInIdentity(
  urlOrId: string | null | undefined,
): string | null {
  if (!urlOrId?.trim()) return null;
  const raw = urlOrId.trim();
  // ACoAA… provider ids
  if (/^ACoAA/i.test(raw)) return raw.toLowerCase();
  try {
    const u = new URL(
      raw.startsWith("http") ? raw : `https://www.linkedin.com/in/${raw}`,
    );
    const parts = u.pathname.split("/").filter(Boolean);
    // /in/slug or /in/ACoAA…/
    const inIdx = parts.findIndex((p) => p === "in" || p === "pub");
    if (inIdx >= 0 && parts[inIdx + 1]) {
      return decodeURIComponent(parts[inIdx + 1]).toLowerCase().replace(/\/$/, "");
    }
  } catch {
    /* fall through */
  }
  // bare slug
  const slug = raw
    .replace(/^https?:\/\/(www\.)?linkedin\.com\/in\//i, "")
    .split(/[/?#]/)[0]
    ?.toLowerCase();
  return slug || null;
}

export function identitiesFromWebhook(
  payload: UnipileWebhookPayload,
): string[] {
  const out = new Set<string>();
  const ourId = payload.account_info?.user_id?.toLowerCase() ?? null;
  const candidates = [
    payload.sender,
    ...(payload.attendees ?? []),
  ].filter(Boolean) as NonNullable<UnipileWebhookPayload["sender"]>[];

  for (const a of candidates) {
    const providerId = a.attendee_provider_id?.toLowerCase();
    if (providerId && providerId !== ourId) out.add(providerId);
    const fromUrl = normalizeLinkedInIdentity(a.attendee_profile_url);
    if (fromUrl && fromUrl !== ourId) out.add(fromUrl);
  }
  return [...out];
}

/** True when the webhook message was sent by the connected LinkedIn account. */
export function isOutboundUnipileMessage(
  payload: UnipileWebhookPayload,
): boolean {
  const ourId = payload.account_info?.user_id;
  const senderId = payload.sender?.attendee_provider_id;
  if (!ourId || !senderId) return false;
  return ourId === senderId;
}

export function unipileSettingsUrls(req?: Request): {
  success: string;
  failure: string;
  notify: string;
  webhook: string;
} {
  const base = getAppBaseUrl(req);
  return {
    success: `${base}/settings?unipile=connected`,
    failure: `${base}/settings?unipile=failed`,
    notify: `${base}/api/unipile/account-notify`,
    webhook: `${base}/api/unipile/webhook`,
  };
}

export async function ensureMessageWebhook(
  req?: Request,
): Promise<{ id: string; created: boolean } | null> {
  if (!isUnipileConfigured()) return null;
  const { webhook } = unipileSettingsUrls(req);
  const secret = process.env.UNIPILE_WEBHOOK_SECRET?.trim() || undefined;

  type Wh = {
    id?: string;
    request_url?: string;
    source?: string;
    events?: string[];
  };
  const list = await unipileFetch<{ items?: Wh[] }>("/api/v1/webhooks");
  const existing = (list.items ?? []).find(
    (w) =>
      w.request_url === webhook ||
      (typeof w.request_url === "string" &&
        w.request_url.includes("/api/unipile/webhook")),
  );
  if (existing?.id) {
    return { id: existing.id, created: false };
  }

  const body: Record<string, unknown> = {
    request_url: webhook,
    source: "messaging",
    events: ["message_received"],
    name: "seo-copilot-linkedin-replies",
    format: "json",
    enabled: true,
  };
  if (secret) {
    body.headers = [{ key: "X-Unipile-Secret", value: secret }];
  }

  const created = await unipileFetch<{
    id?: string;
    webhook_id?: string;
  }>("/api/v1/webhooks", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return {
    id: created.webhook_id ?? created.id ?? "unknown",
    created: true,
  };
}
