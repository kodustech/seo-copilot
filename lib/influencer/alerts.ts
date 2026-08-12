import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Raise an operator alert (reuses the app's notification feed) when the worker
 * hits a problem worth a human looking at. Best-effort: an alert failing must
 * never break the run. Deduped by (user_email, dedupe_key).
 */
export async function alertOperator(
  client: SupabaseClient,
  input: {
    userEmail: string | null;
    title: string;
    body: string;
    dedupeKey: string;
    link?: string;
  },
): Promise<void> {
  if (!input.userEmail) return;
  const { error } = await client.from("user_notifications").upsert(
    {
      user_email: input.userEmail,
      kind: "influencer_alert",
      severity: "warning",
      title: input.title,
      body: input.body,
      source: "influencer",
      link: input.link ?? "/influencers",
      dedupe_key: input.dedupeKey,
    },
    { onConflict: "user_email,dedupe_key", ignoreDuplicates: true },
  );
  if (error) console.warn("[influencer] alert failed:", error.message);
}
