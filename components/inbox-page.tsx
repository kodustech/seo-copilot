"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import {
  Check,
  CheckCheck,
  ExternalLink,
  Linkedin,
  Loader2,
  Mail,
  RefreshCw,
  Reply,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

type ThreadStatus = "new" | "open" | "done" | "snoozed";

type ReplyThread = {
  id: string;
  channel?: "email" | "linkedin";
  mailboxId: string | null;
  unipileAccountId?: string | null;
  enrollmentId: string | null;
  sequenceId: string | null;
  gmailThreadId: string;
  contactEmail: string | null;
  contactName: string | null;
  contactLinkedin?: string | null;
  companyName: string | null;
  subject: string | null;
  snippet: string | null;
  status: ThreadStatus;
  snoozedUntil: string | null;
  matchedHow: string;
  messageCount: number;
  firstInboundAt: string | null;
  lastInboundAt: string | null;
  sequenceName?: string | null;
};

type ReplyMessage = {
  id: string;
  direction: "inbound" | "outbound_ours";
  fromEmail: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  snippet: string | null;
  internalDate: string | null;
};

type MailboxInfo = {
  id: string;
  fromEmail: string;
  label: string;
  inboxSyncReady: boolean;
};

type FilterTab = "active" | "new" | "done" | "all";
type ChannelFilter = "all" | "email" | "linkedin";

function useAuthToken() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);
  return token;
}

function statusBadge(status: ThreadStatus) {
  switch (status) {
    case "new":
      return (
        <Badge className="bg-sky-500/15 text-sky-300 hover:bg-sky-500/15">
          New
        </Badge>
      );
    case "open":
      return <Badge variant="secondary">Open</Badge>;
    case "done":
      return (
        <Badge className="bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/15">
          Done
        </Badge>
      );
    case "snoozed":
      return <Badge variant="outline">Snoozed</Badge>;
  }
}

function matchLabel(how: string) {
  switch (how) {
    case "gmail_thread":
      return "Thread match";
    case "in_reply_to":
      return "Header match";
    case "from_email":
      return "From match";
    case "linkedin_profile":
      return "LinkedIn match";
    default:
      return "Unmatched";
  }
}

/**
 * Undo HTML entity encoding on a plain-text body.
 *
 * Gmail returns entity-encoded text even for text/plain parts, and this pane
 * renders it as text — so a real reply arrived on screen reading
 * "I&#39;m OOO 7/30-8/7", which is the first thing anyone notices and the
 * cheapest possible way to look broken.
 *
 * Uses a fixed table rather than a DOM parse: routing an untrusted inbound
 * email body through innerHTML to decode five entities is a bad trade, and
 * this text is never rendered as markup.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      // Leave anything out of range as written rather than emitting U+FFFD:
      // showing the raw entity is honest, a replacement glyph is not.
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function channelBadge(channel: "email" | "linkedin" | undefined) {
  if (channel === "linkedin") {
    return (
      <Badge className="gap-0.5 bg-[#0A66C2]/15 text-[#5B9BD5] hover:bg-[#0A66C2]/15">
        <Linkedin className="size-2.5" />
        LI
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-0.5 text-[10px]">
      <Mail className="size-2.5" />
      Email
    </Badge>
  );
}

function formatWhen(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      });
    }
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/** Full stamp for message bubbles (list stays short). */
function formatMessageWhen(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function messageDayKey(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  } catch {
    return "";
  }
}

function formatDayDivider(iso: string | null) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startMsg = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const diffDays = Math.round(
      (startToday.getTime() - startMsg.getTime()) / 86_400_000,
    );
    if (diffDays === 0) return "Today";
    if (diffDays === 1) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    });
  } catch {
    return "";
  }
}

function MessageThread({
  messages,
  channel,
  prospectLabel,
}: {
  messages: ReplyMessage[];
  channel?: "email" | "linkedin";
  prospectLabel: string;
}) {
  const nodes: ReactNode[] = [];
  let lastDay = "";

  for (const m of messages) {
    const ours = m.direction === "outbound_ours";
    const day = messageDayKey(m.internalDate);
    if (day && day !== lastDay) {
      lastDay = day;
      nodes.push(
        <div key={`day-${day}`} className="my-3 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">
            {formatDayDivider(m.internalDate)}
          </span>
          <div className="h-px flex-1 bg-border" />
        </div>,
      );
    }

    const raw = m.bodyText?.trim() || m.snippet?.trim() || "";
    const body = raw ? decodeEntities(raw) : "(empty body)";
    const who = ours ? "You" : prospectLabel;

    nodes.push(
      <div
        key={m.id}
        className={cn("flex w-full", ours ? "justify-end" : "justify-start")}
      >
        <article
          className={cn(
            "flex max-w-[min(100%,32rem)] flex-col gap-1",
            ours ? "items-end" : "items-start",
          )}
        >
          <div
            className={cn(
              "flex items-center gap-1.5 px-1 text-[11px]",
              ours ? "flex-row-reverse" : "",
            )}
          >
            <span
              className={cn(
                "font-semibold",
                ours ? "text-foreground" : "text-sky-300",
              )}
            >
              {who}
            </span>
            <span className="text-muted-foreground/80">·</span>
            <time
              dateTime={m.internalDate ?? undefined}
              className="tabular-nums text-muted-foreground"
            >
              {formatMessageWhen(m.internalDate)}
            </time>
          </div>
          <div
            className={cn(
              "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
              ours
                ? "rounded-br-md bg-primary text-primary-foreground"
                : "rounded-bl-md border border-sky-500/25 bg-sky-500/10 text-foreground",
            )}
          >
            {!ours && m.subject && channel === "email" && (
              <p className="mb-1.5 text-[11px] font-medium opacity-70">
                {m.subject}
              </p>
            )}
            <p className="whitespace-pre-wrap text-pretty">{body}</p>
          </div>
        </article>
      </div>,
    );
  }

  return <>{nodes}</>;
}

export function InboxPage() {
  const token = useAuthToken();
  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const [filter, setFilter] = useState<FilterTab>("active");
  const [channelFilter, setChannelFilter] = useState<ChannelFilter>("all");
  const [threads, setThreads] = useState<ReplyThread[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [messages, setMessages] = useState<ReplyMessage[]>([]);
  const [gmailUrl, setGmailUrl] = useState<string | null>(null);
  const [mailbox, setMailbox] = useState<MailboxInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [syncHints, setSyncHints] = useState<string | null>(null);

  const selected = threads.find((t) => t.id === selectedId) ?? null;
  const allVisibleChecked =
    threads.length > 0 && threads.every((t) => checkedIds.has(t.id));
  const someChecked = checkedIds.size > 0;

  const loadList = useCallback(async (): Promise<string | null> => {
    if (!token) return null;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        status: filter,
        channel: channelFilter,
        limit: "100",
      });
      const res = await fetch(`/api/outreach/inbox?${params}`, {
        headers: headers(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load inbox");
      const list = (data.threads ?? []) as ReplyThread[];
      setThreads(list);
      setNewCount(Number(data.newCount ?? 0));
      setCheckedIds((prev) => {
        const next = new Set<string>();
        for (const id of prev) {
          if (list.some((t) => t.id === id)) next.add(id);
        }
        return next;
      });
      let nextSelected: string | null = null;
      setSelectedId((prev) => {
        nextSelected =
          prev && list.some((t) => t.id === prev)
            ? prev
            : (list[0]?.id ?? null);
        return nextSelected;
      });
      return nextSelected;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      return null;
    } finally {
      setLoading(false);
    }
  }, [token, filter, channelFilter, headers]);

  const loadDetail = useCallback(
    async (threadId: string) => {
      if (!token) return;
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/outreach/inbox/${threadId}`, {
          headers: headers(),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed to load thread");
        setMessages((data.messages ?? []) as ReplyMessage[]);
        setGmailUrl((data.gmailUrl as string | null) ?? null);
        setMailbox((data.mailbox as MailboxInfo | null) ?? null);
        if (data.thread) {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId ? { ...t, ...(data.thread as ReplyThread) } : t,
            ),
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load thread");
      } finally {
        setDetailLoading(false);
      }
    },
    [token, headers],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else {
      setMessages([]);
      setGmailUrl(null);
      setMailbox(null);
    }
  }, [selectedId, loadDetail]);

  const sync = async () => {
    if (!token) return;
    setSyncing(true);
    setNotice(null);
    setSyncHints(null);
    setError(null);
    try {
      const res = await fetch("/api/outreach/inbox/sync", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");
      const results = (data.results ?? []) as Array<{
        ok: boolean;
        fromEmail: string;
        mode: string;
        threadsTouched: number;
        messagesUpserted: number;
        enrollmentsMarkedReplied: number;
        error?: string;
      }>;
      const linkedin = data.linkedin as
        | {
            ok: boolean;
            chatsScanned?: number;
            threadsTouched?: number;
            messagesUpserted?: number;
            enrollmentsMarkedReplied?: number;
            error?: string;
          }
        | null
        | undefined;

      const lines: string[] = [];
      if (!results.length) {
        lines.push("Gmail: no OAuth mailbox (Settings → Outreach email)");
      } else {
        for (const r of results) {
          lines.push(
            r.ok
              ? `Gmail ${r.fromEmail}: ${r.threadsTouched} threads, ${r.enrollmentsMarkedReplied} stopped`
              : `Gmail ${r.fromEmail}: ${r.error || "failed"}`,
          );
        }
        const needsReconnect = results.some(
          (r) =>
            r.error && /scope|readonly|reconnect|insufficient/i.test(r.error),
        );
        if (needsReconnect) {
          setNotice(
            "Inbox sync needs gmail.readonly — reconnect Google in Settings.",
          );
        }
      }
      if (linkedin) {
        if (linkedin.ok) {
          lines.push(
            `LinkedIn: ${linkedin.threadsTouched ?? 0} chats, ${linkedin.messagesUpserted ?? 0} msgs, ${linkedin.enrollmentsMarkedReplied ?? 0} stopped`,
          );
        } else {
          lines.push(`LinkedIn: ${linkedin.error || "failed"}`);
        }
      }
      setSyncHints(lines.join(" · "));
      const nextSelectedId = await loadList();
      if (nextSelectedId) await loadDetail(nextSelectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  };

  const toggleChecked = (id: string, on: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleAllVisible = (on: boolean) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      for (const t of threads) {
        if (on) next.add(t.id);
        else next.delete(t.id);
      }
      return next;
    });
  };

  const bulkMarkDone = async () => {
    if (!token || checkedIds.size === 0) return;
    setActing(true);
    setError(null);
    try {
      const ids = [...checkedIds];
      const res = await fetch("/api/outreach/inbox", {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ threadIds: ids, status: "done" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Bulk update failed");
      setNotice(`Marked ${data.updated ?? ids.length} as done`);
      setCheckedIds(new Set());
      if (filter === "active" || filter === "new") {
        setThreads((prev) => {
          const rest = prev.filter((t) => !ids.includes(t.id));
          setSelectedId((sel) =>
            sel && ids.includes(sel) ? (rest[0]?.id ?? null) : sel,
          );
          return rest;
        });
      } else {
        await loadList();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk update failed");
    } finally {
      setActing(false);
    }
  };

  const patchStatus = async (status: ThreadStatus, snoozedUntil?: string | null) => {
    if (!token || !selectedId) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch(`/api/outreach/inbox/${selectedId}`, {
        method: "PATCH",
        headers: headers(),
        body: JSON.stringify({ status, snoozedUntil }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Update failed");
      const updated = data.thread as ReplyThread;
      setThreads((prev) =>
        prev.map((t) => (t.id === updated.id ? { ...t, ...updated } : t)),
      );
      if (filter === "active" && status === "done") {
        setThreads((prev) => prev.filter((t) => t.id !== updated.id));
        setSelectedId((prev) => {
          const rest = threads.filter((t) => t.id !== updated.id);
          return rest[0]?.id ?? null;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setActing(false);
    }
  };

  const markReplied = async () => {
    if (!token || !selectedId) return;
    setActing(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/inbox/${selectedId}/mark-replied`,
        { method: "POST", headers: headers() },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Mark replied failed");
      setNotice("Enrollment marked as replied; pending steps cancelled.");
      if (data.thread) {
        setThreads((prev) =>
          prev.map((t) =>
            t.id === selectedId ? { ...t, ...(data.thread as ReplyThread) } : t,
          ),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Mark replied failed");
    } finally {
      setActing(false);
    }
  };

  const snoozeTomorrow = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    void patchStatus("snoozed", d.toISOString());
  };

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Sign in to view replies.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Reply className="size-4 text-muted-foreground" />
            <h1 className="text-base font-semibold tracking-tight">Replies</h1>
            {newCount > 0 && (
              <Badge variant="secondary" className="tabular-nums">
                {newCount} new
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sequence replies only — Gmail + LinkedIn when the contact is enrolled.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            {(
              [
                ["active", "Active"],
                ["new", "New"],
                ["done", "Done"],
                ["all", "All"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  filter === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="flex rounded-lg border bg-muted/30 p-0.5">
            {(
              [
                ["all", "All"],
                ["email", "Email"],
                ["linkedin", "LinkedIn"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setChannelFilter(key)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  channelFilter === key
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {key === "email" && <Mail className="size-3" />}
                {key === "linkedin" && <Linkedin className="size-3" />}
                {label}
              </button>
            ))}
          </div>
          {someChecked && (
            <Button
              size="sm"
              variant="secondary"
              disabled={acting}
              onClick={() => void bulkMarkDone()}
            >
              {acting ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <CheckCheck className="size-3.5" />
              )}
              Mark done ({checkedIds.size})
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => void sync()}
            disabled={syncing}
          >
            {syncing ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Sync
          </Button>
        </div>
      </header>

      {(error || notice || syncHints) && (
        <div className="space-y-1 border-b px-4 py-2 text-xs">
          {error && <p className="text-rose-400">{error}</p>}
          {notice && <p className="text-amber-300/90">{notice}</p>}
          {syncHints && (
            <p className="text-muted-foreground">{syncHints}</p>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,360px)_1fr]">
        {/* List */}
        <div className="min-h-0 border-r">
          <ScrollArea className="h-full">
            {loading ? (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : threads.length === 0 ? (
              <div className="space-y-3 p-6 text-sm text-muted-foreground">
                <p className="font-medium text-foreground">No replies yet</p>
                <p>
                  Only sequence replies show here — not personal LinkedIn
                  chat. Email via Gmail sync; LinkedIn when the prospect is
                  enrolled and messages a connected Unipile account.
                </p>
                <ul className="list-inside list-disc space-y-1 text-xs">
                  <li>
                    Gmail:{" "}
                    <Link
                      href="/settings"
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      Settings → Outreach email
                    </Link>{" "}
                    + Sync
                  </li>
                  <li>
                    LinkedIn:{" "}
                    <Link
                      href="/settings"
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      Settings → LinkedIn (Unipile)
                    </Link>{" "}
                    + Sync (backfills enrolled contacts only)
                  </li>
                  <li>
                    Needs matching email /{" "}
                    <span className="text-foreground">contact LinkedIn URL</span>{" "}
                    on the enrollment
                  </li>
                </ul>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 rounded border-border"
                    checked={allVisibleChecked}
                    onChange={(e) => toggleAllVisible(e.target.checked)}
                    aria-label="Select all visible threads"
                  />
                  <span>
                    {someChecked
                      ? `${checkedIds.size} selected`
                      : `${threads.length} ${threads.length === 1 ? "thread" : "threads"}`}
                  </span>
                </div>
                <ul className="divide-y">
                  {threads.map((t) => {
                    const active = t.id === selectedId;
                    const checked = checkedIds.has(t.id);
                    return (
                      <li key={t.id}>
                        <div
                          className={cn(
                            "flex gap-2 px-3 py-3 transition-colors",
                            active
                              ? "bg-muted/60"
                              : "hover:bg-muted/30",
                            t.status === "new" && !active && "bg-sky-500/5",
                          )}
                        >
                          <input
                            type="checkbox"
                            className="mt-1 size-3.5 shrink-0 rounded border-border"
                            checked={checked}
                            onChange={(e) =>
                              toggleChecked(t.id, e.target.checked)
                            }
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Select ${t.companyName || t.contactName || "thread"}`}
                          />
                          <button
                            type="button"
                            onClick={() => setSelectedId(t.id)}
                            className="flex min-w-0 flex-1 flex-col gap-1 text-left"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="truncate text-sm font-medium">
                                {t.companyName ||
                                  t.contactName ||
                                  t.contactEmail ||
                                  "Unknown"}
                              </span>
                              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                                {formatWhen(t.lastInboundAt)}
                              </span>
                            </div>
                            {/* min-w-0 on both the row and the label is what
                                makes `truncate` work here. A flex item defaults
                                to min-width:auto, so it cannot shrink below its
                                content — overflow:hidden has nothing to clip,
                                and a long sequence name pushes the whole row
                                past the column and under the detail pane. */}
                            <div className="flex min-w-0 items-center gap-1.5">
                              {channelBadge(t.channel)}
                              {statusBadge(t.status)}
                              {t.sequenceName && (
                                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                                  {t.sequenceName}
                                </span>
                              )}
                            </div>
                            <p className="truncate text-xs text-muted-foreground">
                              {t.subject || "(no subject)"}
                            </p>
                            {t.snippet && (
                              <p className="line-clamp-2 text-[11px] text-muted-foreground/80">
                                {decodeEntities(t.snippet)}
                              </p>
                            )}
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </ScrollArea>
        </div>

        {/* Detail */}
        <div className="flex min-h-0 flex-col">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
              Select a thread
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-sm font-semibold">
                      {selected.subject || "(no subject)"}
                    </h2>
                    {channelBadge(selected.channel)}
                    {statusBadge(selected.status)}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {[
                      selected.contactName,
                      selected.contactEmail,
                      selected.companyName,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  {/* Separated by a middot and ordered by what you actually
                      want to know: which campaign, then which inbox, then how
                      we matched it. The match reason came first and ran
                      together with the rest, so the line opened on the least
                      useful fact — and "From match" is our own plumbing, worth
                      reading only when a thread looks mis-attached. */}
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-muted-foreground">
                    {selected.sequenceName && selected.sequenceId && (
                      <>
                        <Link
                          href="/sequences"
                          className="underline-offset-2 hover:underline"
                        >
                          {selected.sequenceName}
                        </Link>
                        <span aria-hidden>·</span>
                      </>
                    )}
                    {mailbox && (
                      <>
                        <span>{mailbox.fromEmail}</span>
                        <span aria-hidden>·</span>
                      </>
                    )}
                    <span title="How this reply was matched to the enrollment">
                      {matchLabel(selected.matchedHow)}
                    </span>
                    {(selected.channel === "linkedin" ||
                      selected.contactLinkedin) && <span aria-hidden>·</span>}
                    {selected.channel === "linkedin" && (
                      <span>LinkedIn</span>
                    )}
                    {selected.contactLinkedin && (
                      <a
                        href={
                          selected.contactLinkedin.startsWith("http")
                            ? selected.contactLinkedin
                            : `https://www.linkedin.com/in/${selected.contactLinkedin}`
                        }
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-0.5 text-[#5B9BD5] underline-offset-2 hover:underline"
                      >
                        Profile <ExternalLink className="size-2.5" />
                      </a>
                    )}
                  </div>
                </div>
                {/* One primary, the rest quiet.
                    Five buttons of equal weight ask you to read all five every
                    time; the one you reach for on a reply is almost always
                    "open it where I can answer". Done and Snooze are the two
                    that dispose of the thread, so they stay visible and plain;
                    Open and Mark replied are state repairs and drop to text. */}
                <div className="flex flex-wrap items-center gap-1.5">
                  {gmailUrl && (
                    <Button size="sm" variant="default" asChild>
                      <a href={gmailUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3.5" />
                        Reply in Gmail
                      </a>
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acting}
                    onClick={() => void patchStatus("done")}
                  >
                    <Check className="size-3.5" />
                    Done
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={acting}
                    onClick={snoozeTomorrow}
                  >
                    Snooze 1d
                  </Button>
                  {selected.status !== "open" && selected.status !== "done" && (
                    <button
                      type="button"
                      disabled={acting}
                      onClick={() => void patchStatus("open")}
                      className="rounded px-1.5 py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Reopen
                    </button>
                  )}
                  {selected.enrollmentId && (
                    <button
                      type="button"
                      disabled={acting}
                      onClick={() => void markReplied()}
                      title="Stop the sequence for this contact"
                      className="rounded px-1.5 py-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    >
                      Stop sequence
                    </button>
                  )}
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="flex flex-col gap-1 p-4">
                  {detailLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Loading thread…
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No messages stored yet — try Sync.
                    </p>
                  ) : (
                    <MessageThread
                      messages={messages}
                      channel={selected.channel}
                      prospectLabel={
                        selected.contactName ||
                        selected.contactEmail ||
                        "Prospect"
                      }
                    />
                  )}
                </div>
              </ScrollArea>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
