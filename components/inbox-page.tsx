"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Check,
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
  const [threads, setThreads] = useState<ReplyThread[]>([]);
  const [newCount, setNewCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
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

  const loadList = useCallback(async (): Promise<string | null> => {
    if (!token) return null;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/outreach/inbox?status=${encodeURIComponent(filter)}&limit=100`,
        { headers: headers() },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load inbox");
      const list = (data.threads ?? []) as ReplyThread[];
      setThreads(list);
      setNewCount(Number(data.newCount ?? 0));
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
  }, [token, filter, headers]);

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
      if (!results.length) {
        setSyncHints(
          "No Google OAuth mailbox connected. Connect Gmail in Settings → Outreach email.",
        );
      } else {
        const lines = results.map((r) =>
          r.ok
            ? `${r.fromEmail}: ${r.mode}, ${r.threadsTouched} threads, ${r.enrollmentsMarkedReplied} stopped`
            : `${r.fromEmail}: ${r.error || "failed"}`,
        );
        setSyncHints(lines.join(" · "));
        const needsReconnect = results.some(
          (r) => r.error && /scope|readonly|reconnect|insufficient/i.test(r.error),
        );
        if (needsReconnect) {
          setNotice(
            "Inbox sync needs gmail.readonly — reconnect Google in Settings.",
          );
        }
      }
      const nextSelectedId = await loadList();
      if (nextSelectedId) await loadDetail(nextSelectedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
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
            Sequence replies — Gmail sync + LinkedIn DMs (Unipile).
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
            Sync Gmail
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
                  Email replies land after Gmail sync. LinkedIn DMs land via
                  Unipile when someone messages a connected account.
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
                    + Sync Gmail
                  </li>
                  <li>
                    LinkedIn:{" "}
                    <Link
                      href="/settings"
                      className="text-foreground underline-offset-2 hover:underline"
                    >
                      Settings → LinkedIn (Unipile)
                    </Link>
                  </li>
                  <li>
                    Enrollments need matching email /{" "}
                    <span className="text-foreground">contact LinkedIn URL</span>
                  </li>
                </ul>
              </div>
            ) : (
              <ul className="divide-y">
                {threads.map((t) => {
                  const active = t.id === selectedId;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedId(t.id)}
                        className={cn(
                          "flex w-full flex-col gap-1 px-3 py-3 text-left transition-colors",
                          active
                            ? "bg-muted/60"
                            : "hover:bg-muted/30",
                          t.status === "new" && !active && "bg-sky-500/5",
                        )}
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
                        <div className="flex items-center gap-1.5">
                          {channelBadge(t.channel)}
                          {statusBadge(t.status)}
                          {t.sequenceName && (
                            <span className="truncate text-[11px] text-muted-foreground">
                              {t.sequenceName}
                            </span>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {t.subject || "(no subject)"}
                        </p>
                        {t.snippet && (
                          <p className="line-clamp-2 text-[11px] text-muted-foreground/80">
                            {t.snippet}
                          </p>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
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
                  <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                    <span>{matchLabel(selected.matchedHow)}</span>
                    {selected.sequenceName && selected.sequenceId && (
                      <Link
                        href="/sequences"
                        className="underline-offset-2 hover:underline"
                      >
                        Sequence: {selected.sequenceName}
                      </Link>
                    )}
                    {mailbox && (
                      <span>
                        via {mailbox.label} ({mailbox.fromEmail})
                      </span>
                    )}
                    {selected.channel === "linkedin" && (
                      <span>via LinkedIn (Unipile)</span>
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
                <div className="flex flex-wrap gap-1.5">
                  {selected.status !== "open" && selected.status !== "done" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={acting}
                      onClick={() => void patchStatus("open")}
                    >
                      Open
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
                  {selected.enrollmentId && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={acting}
                      onClick={() => void markReplied()}
                    >
                      Mark enrollment replied
                    </Button>
                  )}
                  {gmailUrl && (
                    <Button size="sm" variant="default" asChild>
                      <a href={gmailUrl} target="_blank" rel="noreferrer">
                        <ExternalLink className="size-3.5" />
                        Open in Gmail
                      </a>
                    </Button>
                  )}
                </div>
              </div>

              <ScrollArea className="min-h-0 flex-1">
                <div className="space-y-3 p-4">
                  {detailLoading ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="size-4 animate-spin" />
                      Loading thread…
                    </div>
                  ) : messages.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      No messages stored yet — try Sync Gmail.
                    </p>
                  ) : (
                    messages.map((m) => {
                      const ours = m.direction === "outbound_ours";
                      return (
                        <article
                          key={m.id}
                          className={cn(
                            "rounded-lg border px-3 py-2.5",
                            ours
                              ? "border-border/60 bg-muted/20"
                              : "border-sky-500/20 bg-sky-500/5",
                          )}
                        >
                          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-1.5 text-xs">
                              <Mail className="size-3 text-muted-foreground" />
                              <span className="font-medium">
                                {ours ? "You" : m.fromEmail || "Prospect"}
                              </span>
                              <Badge
                                variant="outline"
                                className="h-5 px-1.5 text-[10px]"
                              >
                                {ours ? "outbound" : "inbound"}
                              </Badge>
                            </div>
                            <span className="text-[11px] text-muted-foreground">
                              {formatWhen(m.internalDate)}
                            </span>
                          </div>
                          {m.subject && (
                            <p className="mb-1 text-[11px] text-muted-foreground">
                              {m.subject}
                            </p>
                          )}
                          <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground/90">
                            {m.bodyText?.trim() ||
                              m.snippet?.trim() ||
                              "(empty body)"}
                          </pre>
                        </article>
                      );
                    })
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
