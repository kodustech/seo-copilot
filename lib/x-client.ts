// Thin wrapper over X API v2 using OAuth 2.0 App-Only (Bearer) with
// pay-per-use credits. Only read endpoints are used for the Reply Radar MVP.

const X_API_BASE = "https://api.x.com/2";

export type XUser = {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type XPostMetrics = {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
};

export type XPost = {
  id: string;
  text: string;
  createdAt: string;
  authorId: string;
  metrics: XPostMetrics;
  url: string;
};

export class XApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

function getBearerToken(): string {
  const token = process.env.X_API_BEARER_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "X_API_BEARER_TOKEN is not configured. Set it in the environment to use the Reply Radar.",
    );
  }
  return token;
}

async function xFetch<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const url = new URL(`${X_API_BASE}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getBearerToken()}`,
      "User-Agent": "seo-copilot-reply-radar/1.0",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    let code: string | undefined;
    try {
      const parsed = JSON.parse(bodyText);
      code = parsed?.errors?.[0]?.code ?? parsed?.type;
    } catch {
      // ignore
    }
    throw new XApiError(
      `X API error ${response.status}: ${bodyText || response.statusText}`,
      response.status,
      code,
    );
  }

  return (await response.json()) as T;
}

function buildPostUrl(username: string, postId: string): string {
  return `https://x.com/${username}/status/${postId}`;
}

type UserLookupResponse = {
  data?: {
    id: string;
    username: string;
    name: string;
    profile_image_url?: string;
  };
};

export async function resolveUsername(rawUsername: string): Promise<XUser> {
  const username = rawUsername.trim().replace(/^@/, "");
  if (!username) {
    throw new Error("Empty username");
  }

  const response = await xFetch<UserLookupResponse>(
    `/users/by/username/${encodeURIComponent(username)}`,
    { "user.fields": "profile_image_url" },
  );

  if (!response.data) {
    throw new XApiError(`User @${username} not found`, 404, "user_not_found");
  }

  return {
    id: response.data.id,
    username: response.data.username,
    displayName: response.data.name,
    avatarUrl: response.data.profile_image_url ?? null,
  };
}

type TimelineResponse = {
  data?: Array<{
    id: string;
    text: string;
    created_at: string;
    author_id: string;
    public_metrics?: {
      like_count?: number;
      retweet_count?: number;
      reply_count?: number;
      quote_count?: number;
      bookmark_count?: number;
      impression_count?: number;
    };
  }>;
  meta?: {
    result_count?: number;
    next_token?: string;
  };
};

export async function getUserTimeline({
  userId,
  username,
  sinceIso,
  maxResults = 10,
}: {
  userId: string;
  username: string;
  sinceIso?: string;
  maxResults?: number;
}): Promise<XPost[]> {
  const response = await xFetch<TimelineResponse>(
    `/users/${encodeURIComponent(userId)}/tweets`,
    {
      max_results: Math.min(Math.max(maxResults, 5), 100),
      "tweet.fields": "created_at,public_metrics,author_id",
      exclude: "retweets,replies",
      start_time: sinceIso,
    },
  );

  const items = response.data ?? [];

  return items.map((item): XPost => {
    const metrics = item.public_metrics ?? {};
    return {
      id: item.id,
      text: item.text,
      createdAt: item.created_at,
      authorId: item.author_id,
      metrics: {
        likes: metrics.like_count ?? 0,
        retweets: metrics.retweet_count ?? 0,
        replies: metrics.reply_count ?? 0,
        quotes: metrics.quote_count ?? 0,
        bookmarks: metrics.bookmark_count ?? 0,
        impressions: metrics.impression_count ?? 0,
      },
      url: buildPostUrl(username, item.id),
    };
  });
}

export function computeEngagementScore(metrics: XPostMetrics): number {
  // Likes are the cheapest signal; weight retweets/replies higher because
  // they require more intent and usually drive secondary distribution.
  return (
    metrics.likes +
    metrics.retweets * 2 +
    metrics.replies * 2 +
    metrics.quotes * 3 +
    metrics.bookmarks * 1.5
  );
}
