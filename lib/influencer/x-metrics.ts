/**
 * Best-effort public metrics from the X (Twitter) API v2. Uses the app-only
 * bearer token. Returns null on any failure — no token, depleted credits (402),
 * rate limit (429), unknown user — so callers degrade gracefully instead of
 * throwing. A short cache keeps ticks and UI loads from hammering the API.
 */
const X_API_BASE = "https://api.twitter.com/2";
const X_BEARER = process.env.X_API_BEARER_TOKEN?.trim();
const CACHE_TTL_MS = 15 * 60 * 1000;

const cache = new Map<string, { at: number; value: number | null }>();

export async function getXFollowers(username: string): Promise<number | null> {
  if (!X_BEARER) return null;
  const handle = username.replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;

  const hit = cache.get(handle);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value: number | null = null;
  try {
    const res = await fetch(
      `${X_API_BASE}/users/by/username/${handle}?user.fields=public_metrics`,
      {
        headers: { Authorization: `Bearer ${X_BEARER}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        data?: { public_metrics?: { followers_count?: number } };
      };
      const n = body.data?.public_metrics?.followers_count;
      value = typeof n === "number" ? n : null;
    }
  } catch {
    value = null;
  }

  cache.set(handle, { at: Date.now(), value });
  return value;
}
