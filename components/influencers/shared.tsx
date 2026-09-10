"use client";

/* Hallmark · genre: modern-minimal · macrostructure: Workbench (app page: fleet roster + persona bench) · theme: app tokens (dark neutral, violet ≤ 5%) · enrichment: none · nav: app shell · footer: none */

import { useEffect, useMemo, useState } from "react";
import { Bot } from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Types the API returns
// ---------------------------------------------------------------------------

export type Platform =
  | "x"
  | "devto"
  | "blog"
  | "medium"
  | "reddit"
  | "hackernews"
  | "hackernoon";

export type Channel = {
  id: string;
  persona_id: string;
  platform: Platform;
  external_handle: string | null;
  publish_via: string;
  automation_level: "auto" | "approve_first" | "draft_only";
  max_posts_per_day: number;
  max_replies_per_day: number;
  credentials_ref: string | null;
  channel_config: Record<string, unknown>;
  onboarding: Record<string, boolean>;
  status: "pending_setup" | "active" | "paused";
};

export type Persona = {
  id: string;
  handle: string;
  display_name: string;
  bio: string;
  avatar_url: string | null;
  backstory: string;
  disclosure: string | null;
  beat: string;
  tone: string | null;
  writing_guidelines: string | null;
  forbidden_topics: string[];
  status: "active" | "paused";
  channels: Channel[];
  pending_drafts: number;
};

export type ActivityStatus =
  | "draft"
  | "approved"
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "discarded";

export type Activity = {
  id: string;
  persona_id: string;
  channel_id: string;
  kind: string;
  status: ActivityStatus;
  title: string | null;
  content: string;
  content_meta: Record<string, unknown>;
  source_ref: string | null;
  scheduled_at: string | null;
  published_at: string | null;
  external_url: string | null;
  error: string | null;
  created_at: string;
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  return token;
}

export function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

// ---------------------------------------------------------------------------
// Words. The database speaks in enums; the page does not.
// ---------------------------------------------------------------------------

export const PLATFORM_LABEL: Record<Platform, string> = {
  x: "X",
  devto: "dev.to",
  blog: "Blog",
  medium: "Medium",
  reddit: "Reddit",
  hackernews: "Hacker News",
  hackernoon: "Hacker Noon",
};

export function platformLabel(platform: string): string {
  return PLATFORM_LABEL[platform as Platform] ?? platform;
}

export const AUTOMATION_LABEL: Record<Channel["automation_level"], string> = {
  auto: "auto",
  approve_first: "review first",
  draft_only: "drafts only",
};

export const AUTOMATION_HINT: Record<Channel["automation_level"], string> = {
  auto: "publishes without review",
  approve_first: "a person approves each piece",
  draft_only: "the tool never publishes here",
};

export const CHANNEL_STATUS_LABEL: Record<Channel["status"], string> = {
  active: "active",
  paused: "paused",
  pending_setup: "not set up",
};

export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
  draft: "draft",
  approved: "approved",
  scheduled: "scheduled",
  publishing: "publishing",
  published: "published",
  failed: "failed",
  discarded: "discarded",
};

/** Whether a channel is wired to something that can publish (or, for a
 *  hand-posted channel, whether drafting is on). */
export function isChannelConnected(channel: Channel): boolean {
  if (channel.publish_via === "manual") return channel.status === "active";
  const cfg = channel.channel_config ?? {};
  return Boolean(
    (typeof channel.credentials_ref === "string" && channel.credentials_ref.length > 0) ||
      cfg.post_bridge_account_id != null ||
      typeof cfg.browserbase_context_id === "string",
  );
}

export function isHandPosted(channel: Channel): boolean {
  return channel.publish_via === "manual";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TIME_FMT = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const DAY_FULL_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
});

export function fmtDay(iso: string): string {
  return DAY_FMT.format(new Date(iso));
}
export function fmtTime(iso: string): string {
  return TIME_FMT.format(new Date(iso));
}
export function fmtDayFull(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return "Yesterday";
  return DAY_FULL_FMT.format(d);
}
export function fmtWhen(iso: string): string {
  return `${fmtDay(iso)} · ${fmtTime(iso)}`;
}
/** "in 2h" / "3d ago" — for a next-shift line, where the clock matters more
 *  than the calendar. */
export function fmtRelative(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(ms);
  const unit =
    abs < 60_000
      ? ["now", 1]
      : abs < 3_600_000
        ? [`${Math.round(abs / 60_000)}m`, 1]
        : abs < 86_400_000
          ? [`${Math.round(abs / 3_600_000)}h`, 1]
          : [`${Math.round(abs / 86_400_000)}d`, 1];
  const label = unit[0] as string;
  if (label === "now") return "now";
  return ms > 0 ? `in ${label}` : `${label} ago`;
}

// ---------------------------------------------------------------------------
// Class recipes shared with the Bets page, so the two read as one app.
// ---------------------------------------------------------------------------

export const cls = {
  page: "mx-auto w-full max-w-screen-2xl space-y-6 px-6 py-5",
  panel: "rounded-lg border border-white/[0.06] bg-neutral-900/40",
  label: "text-[11px] font-medium uppercase tracking-wider text-neutral-500",
  primary:
    "inline-flex h-8 items-center gap-1.5 rounded-md bg-violet-600 px-3 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300",
  outline:
    "inline-flex h-8 items-center gap-1.5 rounded-md border border-white/[0.08] px-3 text-xs text-neutral-300 hover:bg-white/[0.05] hover:text-neutral-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300",
  ghost:
    "inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300",
  iconBtn:
    "inline-flex size-8 items-center justify-center rounded-md border border-white/[0.08] text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300",
  input: "h-8 border-white/[0.08] bg-transparent text-xs placeholder:text-neutral-600",
  textarea: "border-white/[0.08] bg-transparent text-sm placeholder:text-neutral-600",
  select: "h-8 border-white/[0.08] bg-transparent text-xs",
  menu: "border-white/10 bg-neutral-900 text-sm",
  error: "rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200",
  errorText: "text-xs text-red-300",
  link: "text-violet-300 hover:underline",
  chip: "inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-1.5 py-0.5 text-[11px] text-neutral-300",
};

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

export function SectionLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2 flex items-baseline gap-2">
      <p className={cls.label}>{children}</p>
      {hint ? <p className="text-[11px] text-neutral-600">{hint}</p> : null}
    </div>
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad" | "info" | "muted";

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-neutral-400",
  good: "bg-emerald-400",
  warn: "bg-amber-400",
  bad: "bg-red-400",
  info: "bg-sky-400",
  muted: "bg-neutral-600",
};

const TEXT_TONE: Record<Tone, string> = {
  neutral: "text-neutral-300",
  good: "text-emerald-300",
  warn: "text-amber-300",
  bad: "text-red-300",
  info: "text-sky-300",
  muted: "text-neutral-500",
};

export function Dot({ tone, className }: { tone: Tone; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONE[tone], className)} />;
}

/** A status as a dot and a word, not a coloured pill. */
export function Status({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", TEXT_TONE[tone], className)}>
      <Dot tone={tone} />
      {children}
    </span>
  );
}

export function activityTone(status: ActivityStatus): Tone {
  switch (status) {
    case "published":
      return "good";
    case "failed":
      return "bad";
    case "publishing":
      return "warn";
    case "approved":
    case "scheduled":
      return "info";
    case "discarded":
      return "muted";
    default:
      return "neutral";
  }
}

export function channelTone(channel: Channel): Tone {
  if (channel.status === "paused") return "muted";
  if (channel.status === "pending_setup") return "warn";
  return isChannelConnected(channel) ? "good" : "warn";
}

export function channelStateLabel(channel: Channel): string {
  if (channel.status === "paused") return "paused";
  if (channel.status === "pending_setup") return isHandPosted(channel) ? "drafting off" : "not connected";
  if (isHandPosted(channel)) return "drafting, posted by hand";
  return isChannelConnected(channel) ? "connected" : "no credential";
}

export function Avatar({ persona, size }: { persona: Persona; size: number }) {
  if (persona.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={persona.avatar_url}
        alt={persona.display_name}
        width={size}
        height={size}
        className="shrink-0 rounded-full object-cover ring-1 ring-white/10"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-white/[0.06] ring-1 ring-white/10"
      style={{ width: size, height: size }}
    >
      <Bot className="h-1/2 w-1/2 text-neutral-500" />
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-white/10 px-6 py-12 text-center text-sm text-neutral-500">
      {children}
    </div>
  );
}

/** A segmented control: the app's tab voice for two to four choices. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: React.ReactNode }[];
  className?: string;
}) {
  return (
    <div className={cn("flex rounded-md border border-white/[0.08] p-0.5 text-xs", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded px-2.5 py-1 whitespace-nowrap focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300",
            value === o.value ? "bg-white/[0.08] text-neutral-100" : "text-neutral-400 hover:text-neutral-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An inline "N chars / limit" reading. Only where a limit exists. */
export function Counter({ n, max }: { n: number; max: number }) {
  const over = n > max;
  return (
    <span className={cn("text-[11px] tabular-nums", over ? "text-red-300" : "text-neutral-500")}>
      {n}/{max}
    </span>
  );
}
