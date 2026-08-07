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
  /** LinkedIn member provider id (ACoAA…) when available */
  providerUserId: string | null;
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

/**
 * A non-2xx from Unipile, with the status kept so callers can tell a 4xx
 * (our request is wrong, or the account lost access — stop) from a 5xx
 * (their side — a retry would be defensible). Nothing in this file retries.
 */
export class UnipileHttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = "UnipileHttpError";
    this.status = status;
    this.path = path;
  }

  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }
}

/**
 * Every call against the connected LinkedIn account, on one line. That
 * account is the sender identity for the whole founder-voice motion, so the
 * question "how much did we hit LinkedIn today, and with what" has to be
 * answerable from the logs after the fact.
 */
function logUnipileCall(entry: {
  method: string;
  path: string;
  status: number | "error";
  ms: number;
  note?: string;
}): void {
  const { method, path, status, ms, note } = entry;
  // Strip the api key if a caller ever passes a full URL with query auth.
  const safePath = path.replace(/([?&])(api_key|X-API-KEY)=[^&]*/gi, "$1$2=***");
  console.info(
    `[unipile] ${method} ${safePath} → ${status} (${ms}ms)${note ? ` ${note}` : ""}`,
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
  // FormData must keep the content-type fetch generates for it — the header
  // carries the multipart boundary, and forcing application/json here would
  // ship a body no parser on the other side can read. Unipile's send
  // endpoints are all multipart.
  if (
    init.body &&
    !headers.has("content-type") &&
    !(init.body instanceof FormData)
  ) {
    headers.set("content-type", "application/json");
  }
  const method = (init.method ?? "GET").toUpperCase();
  const startedAt = Date.now();
  const logPath = path.startsWith("http") ? new URL(url).pathname : path;

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (err) {
    logUnipileCall({
      method,
      path: logPath,
      status: "error",
      ms: Date.now() - startedAt,
      note: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  logUnipileCall({
    method,
    path: logPath,
    status: res.status,
    ms: Date.now() - startedAt,
  });
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
    throw new UnipileHttpError(msg, res.status, logPath);
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
    providerUserId: typeof im.id === "string" ? im.id : null,
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

export type UnipileChat = {
  id: string;
  accountId: string;
  accountType: string | null;
  timestamp: string | null;
  attendeeProviderId: string | null;
  unreadCount: number;
};

export type UnipileChatMessage = {
  id: string;
  chatId: string | null;
  text: string | null;
  timestamp: string | null;
  isSender: boolean;
  senderProviderId: string | null;
};

export type UnipileChatAttendee = {
  id: string;
  name: string | null;
  providerId: string | null;
  profileUrl: string | null;
  isSelf: boolean;
};

export type UnipileUserProfile = {
  providerId: string | null;
  publicIdentifier: string | null;
  firstName: string | null;
  lastName: string | null;
  profileUrl: string | null;
};

/** True for LinkedIn member provider ids (ACoAA…). */
export function isLinkedInProviderId(id: string | null | undefined): boolean {
  return Boolean(id && /^ACoAA/i.test(id.trim()));
}

export async function listUnipileChats(opts: {
  accountId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<{ items: UnipileChat[]; cursor: string | null }> {
  const params = new URLSearchParams({
    account_id: opts.accountId,
    limit: String(Math.min(100, Math.max(1, opts.limit ?? 40))),
  });
  if (opts.cursor) params.set("cursor", opts.cursor);
  const data = await unipileFetch<{
    items?: Record<string, unknown>[];
    cursor?: string | null;
  }>(`/api/v1/chats?${params.toString()}`);
  const items = (data.items ?? []).map((r) => ({
    id: String(r.id ?? ""),
    accountId: String(r.account_id ?? opts.accountId),
    accountType: typeof r.account_type === "string" ? r.account_type : null,
    timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
    attendeeProviderId:
      typeof r.attendee_provider_id === "string"
        ? r.attendee_provider_id
        : null,
    unreadCount: Number(r.unread_count ?? r.unread ?? 0) || 0,
  }));
  return {
    items: items.filter((c) => c.id),
    cursor: typeof data.cursor === "string" ? data.cursor : null,
  };
}

export async function listUnipileChatMessages(opts: {
  chatId: string;
  limit?: number;
}): Promise<UnipileChatMessage[]> {
  const params = new URLSearchParams({
    limit: String(Math.min(50, Math.max(1, opts.limit ?? 25))),
  });
  const data = await unipileFetch<{ items?: Record<string, unknown>[] }>(
    `/api/v1/chats/${encodeURIComponent(opts.chatId)}/messages?${params}`,
  );
  return (data.items ?? []).map((r) => {
    const sender =
      r.sender && typeof r.sender === "object"
        ? (r.sender as Record<string, unknown>)
        : null;
    const isSenderRaw = r.is_sender;
    const isSender =
      isSenderRaw === true ||
      isSenderRaw === 1 ||
      isSenderRaw === "1" ||
      isSenderRaw === "true";
    return {
      id: String(r.id ?? r.message_id ?? ""),
      chatId:
        typeof r.chat_id === "string"
          ? r.chat_id
          : opts.chatId,
      text:
        typeof r.text === "string"
          ? r.text
          : typeof r.body === "string"
            ? r.body
            : typeof r.message === "string"
              ? r.message
              : null,
      timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
      isSender,
      senderProviderId:
        typeof r.sender_id === "string"
          ? r.sender_id
          : typeof sender?.attendee_provider_id === "string"
            ? sender.attendee_provider_id
            : null,
    };
  }).filter((m) => m.id);
}

export async function listUnipileChatAttendees(opts: {
  accountId: string;
  chatId: string;
}): Promise<UnipileChatAttendee[]> {
  const params = new URLSearchParams({
    account_id: opts.accountId,
    chat_id: opts.chatId,
  });
  const data = await unipileFetch<{ items?: Record<string, unknown>[] }>(
    `/api/v1/chat_attendees?${params.toString()}`,
  );
  return (data.items ?? []).map((r) => ({
    id: String(r.id ?? ""),
    name: typeof r.name === "string" ? r.name : null,
    providerId: typeof r.provider_id === "string" ? r.provider_id : null,
    profileUrl: typeof r.profile_url === "string" ? r.profile_url : null,
    isSelf: r.is_self === true || r.is_self === 1 || r.is_self === "1",
  }));
}

/** Resolve LinkedIn public identifier (vanity slug) from provider id. */
export async function getUnipileUserProfile(opts: {
  accountId: string;
  identifier: string;
}): Promise<UnipileUserProfile | null> {
  try {
    const params = new URLSearchParams({ account_id: opts.accountId });
    const data = await unipileFetch<Record<string, unknown>>(
      `/api/v1/users/${encodeURIComponent(opts.identifier)}?${params}`,
    );
    const publicId =
      typeof data.public_identifier === "string"
        ? data.public_identifier
        : null;
    const providerId =
      typeof data.provider_id === "string" ? data.provider_id : opts.identifier;
    const first =
      typeof data.first_name === "string" ? data.first_name : null;
    const last = typeof data.last_name === "string" ? data.last_name : null;
    return {
      providerId,
      publicIdentifier: publicId,
      firstName: first,
      lastName: last,
      profileUrl: publicId
        ? `https://www.linkedin.com/in/${publicId}`
        : typeof data.profile_url === "string"
          ? data.profile_url
          : null,
    };
  } catch {
    return null;
  }
}

// ── Posts and comments (harvesting) ────────────────────────────────
//
// Read-only, but not free: these run against the same connected account that
// sends every founder-voice message. Losing that account costs far more than
// any list this builds, so the whole path is paced, capped, logged, and
// refuses to retry a rejection.

/** Milliseconds between two harvest calls. Conservative on purpose. */
function harvestMinIntervalMs(): number {
  const raw = Number(process.env.UNIPILE_HARVEST_MIN_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 1500;
}

/** Ceiling on harvest calls within the rolling window. */
function harvestMaxCalls(): number {
  const raw = Number(process.env.UNIPILE_HARVEST_MAX_CALLS_PER_WINDOW);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
}

/** Length of the rolling window, in minutes. */
function harvestWindowMs(): number {
  const raw = Number(process.env.UNIPILE_HARVEST_WINDOW_MINUTES);
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 60_000;
}

/**
 * Serialize harvest reads and space them out. A promise chain rather than a
 * token bucket: concurrent callers queue behind each other instead of all
 * firing once the window opens, which is the behaviour that gets an account
 * flagged.
 */
let harvestGate: Promise<void> = Promise.resolve();
/** Timestamps of recent calls — a rolling window, not a per-run counter. */
let harvestCalls: number[] = [];

function pruneHarvestCalls(now: number): void {
  const cutoff = now - harvestWindowMs();
  harvestCalls = harvestCalls.filter((t) => t > cutoff);
}

export function unipileHarvestBudget(): {
  used: number;
  max: number;
  windowMinutes: number;
} {
  pruneHarvestCalls(Date.now());
  return {
    used: harvestCalls.length,
    max: harvestMaxCalls(),
    windowMinutes: harvestWindowMs() / 60_000,
  };
}

async function harvestFetch<T>(path: string): Promise<T> {
  const now = Date.now();
  pruneHarvestCalls(now);
  const max = harvestMaxCalls();
  // A rolling window rather than a counter someone resets: two harvests
  // running at once cannot talk each other out of the limit, which is the
  // whole point of having one.
  if (harvestCalls.length >= max) {
    throw new Error(
      `Unipile harvest limit reached (${max} calls in ${harvestWindowMs() / 60_000}min). Raise UNIPILE_HARVEST_MAX_CALLS_PER_WINDOW or wait.`,
    );
  }
  harvestCalls.push(now);

  const wait = harvestMinIntervalMs();
  const previous = harvestGate;
  let release: () => void = () => {};
  harvestGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await unipileFetch<T>(path);
  } finally {
    // Hold the next caller off for the interval even when this one threw —
    // a 429 is exactly when backing off matters most.
    setTimeout(release, wait);
  }
}

/**
 * The numeric activity id inside a LinkedIn post URL.
 *
 *   .../posts/miguel-verissimo_aiagents-activity-7462609441322926081-QQwC
 *                                       └──────── this ────────┘
 *
 * Unipile does not take URLs — only the id, or the urn:li:activity /
 * urn:li:ugcPost / urn:li:share forms. Returns null rather than guessing:
 * a post we cannot identify is skipped, not approximated.
 */
export function extractLinkedInActivityId(
  urlOrId: string | null | undefined,
): string | null {
  const raw = urlOrId?.trim();
  if (!raw) return null;

  // Bare id.
  if (/^\d{15,25}$/.test(raw)) return raw;

  // urn:li:activity:123 / urn:li:ugcPost:123 / urn:li:share:123
  const urn = raw.match(/urn:li:(?:activity|ugcPost|share|comment):(\d{15,25})/i);
  if (urn) return urn[1];

  // The URL form. Both /posts/ and /feed/update/ carry it.
  const activity = raw.match(/activity[-:](\d{15,25})/i);
  if (activity) return activity[1];

  return null;
}

export type UnipilePost = {
  /** Unipile's own object id. NOT what the comments endpoint wants. */
  id: string | null;
  /**
   * The LinkedIn-side id. The comments endpoint requires this one
   * specifically — passing `id` returns nothing.
   */
  socialId: string | null;
  activityId: string | null;
  authorName: string | null;
  authorProfileUrl: string | null;
  text: string | null;
  postedAt: string | null;
  commentCount: number | null;
  reactionCount: number | null;
  raw: Record<string, unknown>;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function getUnipilePost(opts: {
  activityId: string;
  accountId: string;
}): Promise<UnipilePost> {
  const params = new URLSearchParams({ account_id: opts.accountId });
  const data = await harvestFetch<Record<string, unknown>>(
    `/api/v1/posts/${encodeURIComponent(opts.activityId)}?${params.toString()}`,
  );
  const author = (data.author ?? {}) as Record<string, unknown>;
  return {
    id: str(data.id),
    socialId: str(data.social_id) ?? str(data.share_url) ?? null,
    activityId: opts.activityId,
    authorName: str(author.name) ?? str(data.author_name),
    authorProfileUrl:
      str(author.public_profile_url) ??
      str(author.profile_url) ??
      (str(author.public_identifier)
        ? `https://www.linkedin.com/in/${str(author.public_identifier)}`
        : null),
    text: str(data.text) ?? str(data.commentary),
    postedAt: str(data.parsed_datetime) ?? str(data.posted_at) ?? str(data.date),
    commentCount: num(data.comment_counter ?? data.comment_count),
    reactionCount: num(data.reaction_counter ?? data.reaction_count),
    raw: data,
  };
}

export type UnipilePostComment = {
  id: string;
  /** Author's LinkedIn member id (ACoAA…), for sends. */
  providerId: string | null;
  /** Unipile messaging id, when the response carries one. */
  messagingId: string | null;
  name: string | null;
  headline: string | null;
  publicIdentifier: string | null;
  profileUrl: string | null;
  profilePictureUrl: string | null;
  /** DISTANCE_1 | DISTANCE_2 | DISTANCE_3 | OUT_OF_NETWORK */
  networkDistance: string | null;
  text: string | null;
  commentedAt: string | null;
  reactionCount: number | null;
  replyCount: number | null;
  /** True when this came back as a reply to another comment. */
  isReply: boolean;
};

function mapComment(
  r: Record<string, unknown>,
  isReply: boolean,
): UnipilePostComment | null {
  const id = str(r.id) ?? str(r.comment_id);
  if (!id) return null;
  const author = (r.author ?? {}) as Record<string, unknown>;
  const publicIdentifier =
    str(author.public_identifier) ?? str(r.author_public_identifier);
  const profileUrl =
    str(author.public_profile_url) ??
    str(author.profile_url) ??
    str(r.author_profile_url) ??
    (publicIdentifier
      ? `https://www.linkedin.com/in/${publicIdentifier}`
      : null);

  return {
    id,
    providerId: str(author.id) ?? str(r.author_id) ?? str(r.author_provider_id),
    messagingId:
      str(author.messaging_id) ??
      str(r.messaging_id) ??
      str(author.attendee_provider_id),
    name: str(author.name) ?? str(r.author_name),
    headline: str(author.headline) ?? str(r.author_headline),
    publicIdentifier,
    profileUrl,
    profilePictureUrl:
      str(author.profile_picture_url) ?? str(r.profile_picture_url),
    networkDistance:
      str(author.network_distance) ??
      str(r.network_distance) ??
      str(author.distance),
    text: str(r.text) ?? str(r.comment) ?? str(r.body),
    // parsed_datetime first: LinkedIn's `date` is often a relative string
    // ("2mo", "3w"), which is useless as a trigger date and unstorable as a
    // timestamp. The ISO field is the one worth having.
    commentedAt:
      str(r.parsed_datetime) ?? str(r.created_at) ?? str(r.timestamp) ?? str(r.date),
    reactionCount: num(r.reaction_counter ?? r.reaction_count),
    replyCount: num(r.reply_counter ?? r.reply_count),
    isReply,
  };
}

/**
 * Comments on a post, paginated.
 *
 * The same endpoint serves replies: passing a comment id returns that
 * comment's replies rather than the post's top-level comments. With
 * includeReplies we walk into every comment that reports replies, still
 * inside the same maxComments ceiling — replies are where the "I have this
 * exact problem" answers usually live.
 */
export async function listUnipilePostComments(opts: {
  socialId: string;
  accountId: string;
  maxComments?: number;
  includeReplies?: boolean;
}): Promise<UnipilePostComment[]> {
  const max = Math.max(1, Math.min(500, opts.maxComments ?? 50));
  const out: UnipilePostComment[] = [];
  const seen = new Set<string>();

  const fetchPage = async (
    cursor: string | null,
    commentId: string | null,
  ): Promise<{ items: Record<string, unknown>[]; cursor: string | null }> => {
    const params = new URLSearchParams({ account_id: opts.accountId });
    if (cursor) params.set("cursor", cursor);
    if (commentId) params.set("comment_id", commentId);
    const data = await harvestFetch<{
      items?: Record<string, unknown>[];
      cursor?: string | null;
    }>(
      `/api/v1/posts/${encodeURIComponent(opts.socialId)}/comments?${params.toString()}`,
    );
    return {
      items: data.items ?? [],
      cursor: typeof data.cursor === "string" && data.cursor ? data.cursor : null,
    };
  };

  // Top-level comments.
  let cursor: string | null = null;
  const withReplies: UnipilePostComment[] = [];
  do {
    const page = await fetchPage(cursor, null);
    let fresh = 0;
    for (const raw of page.items) {
      const c = mapComment(raw, false);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      fresh += 1;
      out.push(c);
      if ((c.replyCount ?? 0) > 0) withReplies.push(c);
      if (out.length >= max) break;
    }
    // A cursor that keeps returning nothing new would otherwise spin against
    // the account forever. One unproductive page is where it stops.
    if (fresh === 0) break;
    cursor = page.cursor;
  } while (cursor && out.length < max);

  if (!opts.includeReplies) return out.slice(0, max);

  for (const parent of withReplies) {
    if (out.length >= max) break;
    let replyCursor: string | null = null;
    do {
      const page = await fetchPage(replyCursor, parent.id);
      let fresh = 0;
      for (const raw of page.items) {
        const c = mapComment(raw, true);
        if (!c || seen.has(c.id)) continue;
        seen.add(c.id);
        fresh += 1;
        out.push(c);
        if (out.length >= max) break;
      }
      if (fresh === 0) break;
      replyCursor = page.cursor;
    } while (replyCursor && out.length < max);
  }

  return out.slice(0, max);
}

/** The LinkedIn account harvests run through, unless the caller names one. */
export async function defaultLinkedInAccountId(): Promise<string | null> {
  const configured = process.env.UNIPILE_LINKEDIN_ACCOUNT_ID?.trim();
  if (configured) return configured;
  const accounts = await listLinkedInAccounts();
  return accounts[0]?.id ?? null;
}

// ── Sending ────────────────────────────────────────────────────────
//
// Everything above this line reads. These three write, and LinkedIn is the
// one channel here where the platform — not our schema — is the strict
// party: invitations and cold DMs from a young or quiet account are what
// gets a profile restricted. Callers are expected to come through the
// sequence queue, which paces them.

/** Send into an existing conversation. */
export async function sendUnipileChatMessage(opts: {
  chatId: string;
  text: string;
  /** Refuses the send if the chat belongs to another connected account. */
  accountId?: string | null;
}): Promise<{ messageId: string | null }> {
  const form = new FormData();
  form.set("text", opts.text);
  if (opts.accountId) form.set("account_id", opts.accountId);
  const data = await unipileFetch<Record<string, unknown>>(
    `/api/v1/chats/${encodeURIComponent(opts.chatId)}/messages`,
    { method: "POST", body: form },
  );
  return {
    messageId:
      typeof data.message_id === "string"
        ? data.message_id
        : typeof data.id === "string"
          ? data.id
          : null,
  };
}

/** Open a new conversation with one or more members. */
export async function startUnipileChat(opts: {
  accountId: string;
  /** LinkedIn member provider ids (ACoAA…), not vanity slugs. */
  attendeeProviderIds: string[];
  text: string;
}): Promise<{ chatId: string | null; messageId: string | null }> {
  if (!opts.attendeeProviderIds.length) {
    throw new Error("No recipient — attendeeProviderIds is empty");
  }
  const form = new FormData();
  form.set("account_id", opts.accountId);
  for (const id of opts.attendeeProviderIds) {
    // Repeated key, not a JSON array: the endpoint takes attendees_ids as a
    // multipart repeated field.
    form.append("attendees_ids", id);
  }
  form.set("text", opts.text);
  const data = await unipileFetch<Record<string, unknown>>("/api/v1/chats", {
    method: "POST",
    body: form,
  });
  return {
    chatId: typeof data.chat_id === "string" ? data.chat_id : null,
    messageId: typeof data.message_id === "string" ? data.message_id : null,
  };
}

/** Connection request, with an optional note. JSON, unlike the chat sends. */
export async function sendLinkedInInvitation(opts: {
  accountId: string;
  providerId: string;
  message?: string | null;
}): Promise<{ invitationId: string | null }> {
  const body: Record<string, string> = {
    account_id: opts.accountId,
    provider_id: opts.providerId,
  };
  if (opts.message?.trim()) body.message = opts.message.trim();
  const data = await unipileFetch<Record<string, unknown>>(
    "/api/v1/users/invite",
    { method: "POST", body: JSON.stringify(body) },
  );
  return {
    invitationId:
      typeof data.invitation_id === "string"
        ? data.invitation_id
        : typeof data.id === "string"
          ? data.id
          : null,
  };
}

/**
 * Existing 1:1 chat with a member, or null.
 *
 * Worth the paging: replying in the thread we already have keeps the
 * conversation in one place, where starting a second chat with the same
 * person reads as a stranger opening a duplicate.
 */
export async function findUnipileChatByAttendee(opts: {
  accountId: string;
  providerId: string;
  /** Pages of 100. Older chats past this are treated as "no chat". */
  maxPages?: number;
}): Promise<string | null> {
  const target = opts.providerId.trim().toLowerCase();
  if (!target) return null;
  let cursor: string | null = null;
  const maxPages = Math.max(1, opts.maxPages ?? 5);
  for (let page = 0; page < maxPages; page++) {
    const res: { items: UnipileChat[]; cursor: string | null } =
      await listUnipileChats({
        accountId: opts.accountId,
        limit: 100,
        cursor,
      });
    const hit = res.items.find(
      (c) => c.attendeeProviderId?.trim().toLowerCase() === target,
    );
    if (hit) return hit.id;
    if (!res.cursor) break;
    cursor = res.cursor;
  }
  return null;
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
