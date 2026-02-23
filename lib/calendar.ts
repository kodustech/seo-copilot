import type { SupabaseClient } from "@supabase/supabase-js";
import { CronExpressionParser } from "cron-parser";

import {
  fetchBlogPosts,
  fetchScheduledSocialPosts,
  fetchSocialAccounts,
} from "@/lib/copilot";
import { listJobsByEmail, type ScheduledJob } from "@/lib/scheduled-jobs";

const CALENDAR_TIMEZONE = "America/Sao_Paulo";

export type CalendarItemStatus = "planned" | "done" | "canceled";
export type CalendarItemSourceType = "idea" | "task" | "campaign";
export type CalendarPostType = "article" | "social";

export type CalendarItem = {
  id: string;
  user_email: string;
  title: string;
  notes: string | null;
  starts_at: string;
  status: CalendarItemStatus;
  source_type: CalendarItemSourceType;
  source_id: string | null;
  post_type: CalendarPostType | null;
  created_at: string;
};

export type CalendarEventSource =
  | "manual"
  | "job"
  | "published_post"
  | "scheduled_social_post";

export type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  source: CalendarEventSource;
  status: string | null;
  editable: boolean;
  itemId?: string;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export function parseMonthKey(monthParam: string | null | undefined): {
  monthKey: string;
  start: Date;
  end: Date;
} {
  const now = new Date();
  const match = monthParam?.match(/^(\d{4})-(\d{2})$/);

  const year = match ? Number(match[1]) : now.getUTCFullYear();
  const monthIndex = match ? Number(match[2]) - 1 : now.getUTCMonth();

  const safeYear = Number.isFinite(year) ? year : now.getUTCFullYear();
  const safeMonthIndex =
    Number.isFinite(monthIndex) && monthIndex >= 0 && monthIndex <= 11
      ? monthIndex
      : now.getUTCMonth();

  const start = new Date(Date.UTC(safeYear, safeMonthIndex, 1, 0, 0, 0));
  const end = new Date(Date.UTC(safeYear, safeMonthIndex + 1, 1, 0, 0, 0));

  return {
    monthKey: `${safeYear}-${String(safeMonthIndex + 1).padStart(2, "0")}`,
    start,
    end,
  };
}

export async function listManualCalendarItems(
  client: SupabaseClient,
  userEmail: string,
  range: { start: Date; end: Date },
): Promise<CalendarItem[]> {
  const { data, error } = await client
    .from("calendar_items")
    .select("*")
    .eq("user_email", userEmail)
    .gte("starts_at", range.start.toISOString())
    .lt("starts_at", range.end.toISOString())
    .order("starts_at", { ascending: true });

  if (error) {
    throw new Error(`Error listing calendar: ${error.message}`);
  }

  return (data ?? []) as CalendarItem[];
}

export async function createManualCalendarItem(
  client: SupabaseClient,
  payload: {
    user_email: string;
    title: string;
    starts_at: string;
    notes?: string | null;
    status?: CalendarItemStatus;
    source_type?: CalendarItemSourceType;
    source_id?: string | null;
    post_type?: CalendarPostType | null;
  },
): Promise<CalendarItem> {
  const { data, error } = await client
    .from("calendar_items")
    .insert({
      user_email: payload.user_email,
      title: payload.title,
      starts_at: payload.starts_at,
      notes: payload.notes ?? null,
      status: payload.status ?? "planned",
      source_type: payload.source_type ?? "idea",
      source_id: payload.source_id ?? null,
      post_type: payload.post_type ?? null,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error creating calendar item: ${error.message}`);
  }

  return data as CalendarItem;
}

export async function updateManualCalendarItem(
  client: SupabaseClient,
  userEmail: string,
  id: string,
  patch: Partial<
    Pick<
      CalendarItem,
      | "title"
      | "notes"
      | "starts_at"
      | "status"
      | "source_type"
      | "source_id"
      | "post_type"
    >
  >,
): Promise<CalendarItem> {
  const { data, error } = await client
    .from("calendar_items")
    .update(patch)
    .eq("id", id)
    .eq("user_email", userEmail)
    .select("*")
    .single();

  if (error) {
    throw new Error(`Error updating calendar item: ${error.message}`);
  }

  return data as CalendarItem;
}

export async function deleteManualCalendarItem(
  client: SupabaseClient,
  userEmail: string,
  id: string,
): Promise<void> {
  const { error } = await client
    .from("calendar_items")
    .delete()
    .eq("id", id)
    .eq("user_email", userEmail);

  if (error) {
    throw new Error(`Error removing calendar item: ${error.message}`);
  }
}

export function mapManualItemsToEvents(items: CalendarItem[]): CalendarEvent[] {
  return items.map((item) => ({
    id: `manual:${item.id}`,
    itemId: item.id,
    title: item.title,
    startsAt: item.starts_at,
    source: "manual",
    status: item.status,
    editable: true,
    notes: item.notes,
    metadata: {
      sourceType: item.source_type,
      sourceId: item.source_id,
      postType: item.post_type,
    },
  }));
}

function listJobOccurrencesInRange(
  job: ScheduledJob,
  range: { start: Date; end: Date },
  maxOccurrences = 40,
): CalendarEvent[] {
  if (!job.enabled) return [];

  try {
    const expression = CronExpressionParser.parse(job.cron_expression, {
      currentDate: new Date(range.start.getTime() - 60_000),
      tz: CALENDAR_TIMEZONE,
    });

    const events: CalendarEvent[] = [];

    for (let i = 0; i < maxOccurrences; i += 1) {
      let next: Date;
      try {
        next = expression.next().toDate();
      } catch {
        break;
      }

      if (next >= range.end) break;
      if (next < range.start) continue;

      events.push({
        id: `job:${job.id}:${next.toISOString()}`,
        title: job.name,
        startsAt: next.toISOString(),
        source: "job",
        status: "scheduled",
        editable: false,
        metadata: {
          jobId: job.id,
          cron: job.cron_expression,
          webhookUrl: job.webhook_url,
        },
      });
    }

    return events;
  } catch {
    return [];
  }
}

export async function buildJobEventsForRange(
  client: SupabaseClient,
  userEmail: string,
  range: { start: Date; end: Date },
): Promise<CalendarEvent[]> {
  const jobs = await listJobsByEmail(client, userEmail);
  return jobs.flatMap((job) => listJobOccurrencesInRange(job, range));
}

export async function buildPublishedPostEventsForRange(range: {
  start: Date;
  end: Date;
}): Promise<CalendarEvent[]> {
  const posts = await fetchBlogPosts(100);

  return posts
    .filter((post) => {
      if (!post.publishedAt) return false;
      const published = new Date(post.publishedAt);
      return published >= range.start && published < range.end;
    })
    .map((post) => ({
      id: `post:${post.id}`,
      title: post.title,
      startsAt: post.publishedAt as string,
      source: "published_post" as const,
      status: "published",
      editable: false,
      metadata: {
        postId: post.id,
        link: post.link,
      },
    }));
}

function truncateCaption(value: string, maxLength = 88): string {
  const clean = value.trim().replace(/\s+/g, " ");
  if (!clean) return "Scheduled social post";
  if (clean.length <= maxLength) return clean;
  return `${clean.slice(0, maxLength - 1).trimEnd()}…`;
}

function formatAccountLabel(platform: string, username: string) {
  const safePlatform = platform.trim() || "Social";
  const safeUsername = username.trim().replace(/^@+/, "") || "unknown";
  return `${safePlatform} @${safeUsername}`;
}

function mapAccountIdsToLabels(
  ids: number[],
  accountsMap: Map<number, string>,
): string[] {
  return ids.map((id) => accountsMap.get(id) ?? `Account #${id}`);
}

export async function buildScheduledSocialEventsForRange(
  range: { start: Date; end: Date },
  options?: { excludePostBridgeIds?: Set<string> },
): Promise<CalendarEvent[]> {
  const [posts, accounts] = await Promise.all([
    fetchScheduledSocialPosts(),
    fetchSocialAccounts(),
  ]);
  const excluded = options?.excludePostBridgeIds ?? new Set<string>();
  const accountsMap = new Map<number, string>(
    accounts.map((account) => [
      account.id,
      formatAccountLabel(account.platform, account.username),
    ]),
  );

  return posts
    .filter((post) => {
      if (!post.scheduledAt) return false;
      if (excluded.has(post.id)) return false;
      const scheduled = new Date(post.scheduledAt);
      return scheduled >= range.start && scheduled < range.end;
    })
    .map((post) => ({
      id: `postbridge:${post.id}`,
      title: truncateCaption(post.caption),
      startsAt: post.scheduledAt as string,
      source: "scheduled_social_post" as const,
      status: post.status ?? "scheduled",
      editable: false,
      metadata: {
        postBridgePostId: post.id,
        socialAccounts: post.socialAccountIds,
        socialAccountLabels: mapAccountIdsToLabels(post.socialAccountIds, accountsMap),
        postType: "social",
      },
      notes:
        post.socialAccountIds.length > 0
          ? `Post-Bridge accounts: ${mapAccountIdsToLabels(
              post.socialAccountIds,
              accountsMap,
            ).join(", ")}`
          : "Post-Bridge scheduled post",
    }));
}

export function sortCalendarEvents(events: CalendarEvent[]): CalendarEvent[] {
  return [...events].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
}
