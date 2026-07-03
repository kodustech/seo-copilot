import type { SupabaseClient } from "@supabase/supabase-js";

import { getUserOverview, type Severity } from "@/lib/user-center";

// ---------------------------------------------------------------------------
// Persistent per-user notifications. Generated (cron / on-demand) from the
// attention feed in user-center, deduped by (user_email, dedupe_key) so a
// standing condition yields one notification until the user acts on it.
// ---------------------------------------------------------------------------

export type Notification = {
  id: string;
  userEmail: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string | null;
  source: string | null;
  sourceId: string | null;
  link: string | null;
  dedupeKey: string;
  readAt: string | null;
  createdAt: string;
};

type Row = {
  id: string;
  user_email: string;
  kind: string;
  severity: Severity;
  title: string;
  body: string | null;
  source: string | null;
  source_id: string | null;
  link: string | null;
  dedupe_key: string;
  read_at: string | null;
  created_at: string;
};

function rowToNotification(r: Row): Notification {
  return {
    id: r.id,
    userEmail: r.user_email,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    body: r.body,
    source: r.source,
    sourceId: r.source_id,
    link: r.link,
    dedupeKey: r.dedupe_key,
    readAt: r.read_at,
    createdAt: r.created_at,
  };
}

export async function listNotifications(
  client: SupabaseClient,
  userEmail: string,
  opts: { unreadOnly?: boolean; limit?: number } = {},
): Promise<{ notifications: Notification[]; unread: number }> {
  let query = client
    .from("user_notifications")
    .select("*")
    .eq("user_email", userEmail)
    .order("created_at", { ascending: false })
    .limit(opts.limit ?? 100);
  if (opts.unreadOnly) query = query.is("read_at", null);

  const [{ data, error }, unread] = await Promise.all([
    query,
    unreadCount(client, userEmail),
  ]);
  if (error) throw new Error(`Failed to list notifications: ${error.message}`);
  return {
    notifications: (data ?? []).map((r) => rowToNotification(r as Row)),
    unread,
  };
}

export async function unreadCount(
  client: SupabaseClient,
  userEmail: string,
): Promise<number> {
  const { count, error } = await client
    .from("user_notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_email", userEmail)
    .is("read_at", null);
  if (error) return 0;
  return count ?? 0;
}

export async function markRead(
  client: SupabaseClient,
  id: string,
  read = true,
): Promise<void> {
  const { error } = await client
    .from("user_notifications")
    .update({ read_at: read ? new Date().toISOString() : null })
    .eq("id", id);
  if (error) throw new Error(`Failed to mark read: ${error.message}`);
}

export async function markAllRead(
  client: SupabaseClient,
  userEmail: string,
): Promise<void> {
  const { error } = await client
    .from("user_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_email", userEmail)
    .is("read_at", null);
  if (error) throw new Error(`Failed to mark all read: ${error.message}`);
}

export async function deleteNotification(
  client: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("user_notifications")
    .delete()
    .eq("id", id);
  if (error) throw new Error(`Failed to delete notification: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Generator — call with a service-role client (bypasses RLS to insert for any
// user). Idempotent: existing dedupe_keys are ignored.
// ---------------------------------------------------------------------------

export async function generateNotificationsForUser(
  client: SupabaseClient,
  userEmail: string,
): Promise<{ created: number }> {
  const overview = await getUserOverview(client, userEmail);
  if (overview.attention.length === 0) return { created: 0 };

  const rows = overview.attention.map((a) => ({
    user_email: userEmail,
    kind: a.kind,
    severity: a.severity,
    title: a.title,
    body: a.body,
    source: a.source,
    source_id: a.sourceId,
    link: a.link,
    dedupe_key: a.dedupeKey,
  }));

  // ignoreDuplicates so re-runs don't create dupes (unique on user+dedupe_key).
  const { data, error } = await client
    .from("user_notifications")
    .upsert(rows, {
      onConflict: "user_email,dedupe_key",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw new Error(`Failed to generate notifications: ${error.message}`);
  return { created: data?.length ?? 0 };
}

// Generate for every platform user (used by the cron). Uses auth.admin to
// enumerate users, so pass a service-role client.
export async function generateNotificationsForAllUsers(
  serviceClient: SupabaseClient,
): Promise<{ users: number; created: number }> {
  const { data, error } = await serviceClient.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (error) throw new Error(error.message);

  const emails = (data?.users ?? [])
    .map((u) => u.email)
    .filter((e): e is string => Boolean(e));

  let created = 0;
  for (const email of emails) {
    try {
      const res = await generateNotificationsForUser(serviceClient, email);
      created += res.created;
    } catch (err) {
      console.error(`[notifications] generate for ${email} failed:`, err);
    }
  }
  return { users: emails.length, created };
}
