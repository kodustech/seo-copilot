"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck, Loader2, RefreshCw } from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import type { Notification } from "@/lib/notifications";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

function relative(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return "";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

const DOT: Record<string, string> = {
  error: "bg-red-400",
  warning: "bg-amber-400",
  info: "bg-sky-400",
};

export function NotificationBell() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) =>
      setToken(data.session?.access_token ?? null),
    );
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) =>
      setToken(s?.access_token ?? null),
    );
    return () => subscription.unsubscribe();
  }, [supabase]);

  const authFetch = useCallback(
    (url: string, init?: RequestInit) =>
      fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      }),
    [token],
  );

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await authFetch("/api/me/notifications");
      const json = await res.json();
      if (res.ok) {
        setItems(json.notifications ?? []);
        setUnread(json.unread ?? 0);
      }
    } finally {
      setLoading(false);
    }
  }, [token, authFetch]);

  // Poll unread count periodically + on token change.
  useEffect(() => {
    if (!token) return;
    void load();
    const t = setInterval(() => void load(), 120_000);
    return () => clearInterval(t);
  }, [token, load]);

  async function generate() {
    setLoading(true);
    await authFetch("/api/me/notifications", {
      method: "POST",
      body: JSON.stringify({ action: "generate" }),
    });
    await load();
  }

  async function markAll() {
    await authFetch("/api/me/notifications", {
      method: "POST",
      body: JSON.stringify({ action: "markAllRead" }),
    });
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setUnread(0);
  }

  async function markOne(id: string) {
    setItems((prev) =>
      prev.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
    );
    setUnread((u) => Math.max(0, u - 1));
    await authFetch(`/api/me/notifications/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ read: true }),
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="relative flex size-8 items-center justify-center rounded-md text-neutral-400 transition hover:bg-white/[0.04] hover:text-neutral-200"
          title="Notifications"
          aria-label="Notifications"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[9px] font-semibold text-white">
              {unread > 9 ? "9+" : unread}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 border-white/10 bg-neutral-950 p-0 text-neutral-100"
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-2">
          <span className="text-sm font-medium text-white">Notifications</span>
          <div className="flex items-center gap-1">
            <button
              onClick={generate}
              title="Refresh now"
              className="flex size-6 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            </button>
            {unread > 0 && (
              <button
                onClick={markAll}
                title="Mark all as read"
                className="flex size-6 items-center justify-center rounded text-neutral-500 hover:text-neutral-200"
              >
                <CheckCheck className="size-4" />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-neutral-500">
              {loading ? (
                <Loader2 className="mx-auto size-4 animate-spin" />
              ) : (
                "No notifications."
              )}
            </div>
          ) : (
            items.map((n) => (
              <div
                key={n.id}
                className={cn(
                  "group flex gap-2.5 border-b border-white/[0.04] px-3 py-2.5 transition",
                  !n.readAt && "bg-white/[0.02]",
                )}
              >
                <span
                  className={cn(
                    "mt-1.5 size-2 shrink-0 rounded-full",
                    n.readAt ? "bg-transparent" : (DOT[n.severity] ?? "bg-sky-400"),
                  )}
                />
                <div className="min-w-0 flex-1">
                  <Link
                    href={n.link ?? "#"}
                    onClick={() => {
                      if (!n.readAt) void markOne(n.id);
                      setOpen(false);
                    }}
                    className="block"
                  >
                    <p className="truncate text-sm text-neutral-100">{n.title}</p>
                    {n.body && (
                      <p className="truncate text-xs text-neutral-500">{n.body}</p>
                    )}
                    <p className="mt-0.5 text-[10px] text-neutral-600">
                      {relative(n.createdAt)}
                    </p>
                  </Link>
                </div>
                {!n.readAt && (
                  <button
                    onClick={() => markOne(n.id)}
                    title="Mark as read"
                    className="shrink-0 self-start text-neutral-600 opacity-0 transition group-hover:opacity-100 hover:text-neutral-200"
                  >
                    <Check className="size-3.5" />
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        <Link
          href="/central"
          onClick={() => setOpen(false)}
          className="block border-t border-white/[0.06] px-3 py-2 text-center text-xs text-neutral-400 hover:text-white"
        >
          Open Home
        </Link>
      </PopoverContent>
    </Popover>
  );
}
