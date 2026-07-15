import type { SupabaseClient } from "@supabase/supabase-js";

export async function getCached<T>(
  client: SupabaseClient,
  cacheKey: string,
): Promise<T | null> {
  const { data, error } = await client
    .from("enrichment_cache")
    .select("value, expires_at")
    .eq("cache_key", cacheKey)
    .maybeSingle();
  if (error || !data) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) {
    void client.from("enrichment_cache").delete().eq("cache_key", cacheKey);
    return null;
  }
  return data.value as T;
}

export async function setCache(
  client: SupabaseClient,
  cacheKey: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await client.from("enrichment_cache").upsert(
    {
      cache_key: cacheKey,
      value,
      expires_at: expiresAt,
    },
    { onConflict: "cache_key" },
  );
}

export function domainCacheKey(domain: string, field: string): string {
  return `domain:${domain.toLowerCase()}:${field}`;
}
