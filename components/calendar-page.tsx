"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ListTodo,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

type CalendarPostType = "article" | "social";
type CalendarEventSource =
  | "job"
  | "published_post"
  | "scheduled_social_post";
type CalendarEventStatus =
  | "scheduled"
  | "published"
  | string
  | null;

type CalendarEvent = {
  id: string;
  title: string;
  startsAt: string;
  source: CalendarEventSource;
  status: CalendarEventStatus;
  editable: boolean;
  itemId?: string;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

type EventsResponse = {
  month: string;
  range: { start: string; end: string };
  events: CalendarEvent[];
  counts: {
    jobs: number;
    posts: number;
    socialScheduled: number;
  };
  error?: string;
};

function useAuthToken() {
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

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function toMonthKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function toDayKey(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseEventDayKey(startsAt: string) {
  return toDayKey(new Date(startsAt));
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function shiftMonth(base: Date, delta: number) {
  return new Date(base.getFullYear(), base.getMonth() + delta, 1);
}

function getMonthGridDays(monthDate: Date): Date[] {
  const first = startOfMonth(monthDate);
  const firstWeekday = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - firstWeekday);

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function sourceDotClass(source: CalendarEventSource) {
  if (source === "job") return "bg-sky-400";
  if (source === "scheduled_social_post") return "bg-pink-400";
  return "bg-emerald-400";
}

function sourceBadgeClass(source: CalendarEventSource) {
  if (source === "job") {
    return "border-sky-500/30 bg-sky-500/15 text-sky-300";
  }
  if (source === "scheduled_social_post") {
    return "border-pink-500/30 bg-pink-500/15 text-pink-300";
  }
  return "border-emerald-500/30 bg-emerald-500/15 text-emerald-300";
}

function sourceLabel(source: CalendarEventSource) {
  if (source === "job") return "Job";
  if (source === "scheduled_social_post") return "Social scheduled";
  return "Published";
}

function statusLabel(status: CalendarEventStatus) {
  if (status === "scheduled") return "Scheduled";
  if (status === "published") return "Published";
  return "Scheduled";
}

function statusBadgeClass(status: CalendarEventStatus) {
  if (status === "published") {
    return "border-emerald-500/30 bg-emerald-500/15 text-emerald-300";
  }
  if (status === "scheduled") {
    return "border-pink-500/30 bg-pink-500/15 text-pink-300";
  }
  return "border-white/15 bg-white/5 text-neutral-300";
}

function postTypeLabel(postType: CalendarPostType) {
  if (postType === "article") return "Article";
  return "Social";
}

function postTypeBadgeClass(postType: CalendarPostType) {
  if (postType === "article") {
    return "border-amber-500/30 bg-amber-500/15 text-amber-300";
  }
  return "border-pink-500/30 bg-pink-500/15 text-pink-300";
}

function eventPostType(event: CalendarEvent): CalendarPostType | null {
  const raw = event.metadata?.postType;
  if (raw === "article" || raw === "social") return raw;
  return null;
}

export function CalendarPage() {
  const token = useAuthToken();

  const [monthDate, setMonthDate] = useState<Date>(() => startOfMonth(new Date()));
  const [selectedDay, setSelectedDay] = useState<string>(() => toDayKey(new Date()));
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [counts, setCounts] = useState<EventsResponse["counts"]>({
    jobs: 0,
    posts: 0,
    socialScheduled: 0,
  });

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadEvents = useCallback(async () => {
    if (!token) return;

    setLoading(true);
    setLoadError(null);

    try {
      const month = toMonthKey(monthDate);
      const response = await fetch(`/api/calendar/events?month=${month}`, {
        headers: authHeaders(token),
      });
      const data = (await response.json()) as EventsResponse;

      if (!response.ok) {
        throw new Error(data.error || "Error loading calendar.");
      }

      setEvents(data.events ?? []);
      setCounts(data.counts ?? { jobs: 0, posts: 0, socialScheduled: 0 });
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Error loading calendar.",
      );
    } finally {
      setLoading(false);
    }
  }, [monthDate, token]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  useEffect(() => {
    const date = new Date(`${selectedDay}T00:00:00`);
    if (
      date.getMonth() !== monthDate.getMonth() ||
      date.getFullYear() !== monthDate.getFullYear()
    ) {
      setSelectedDay(toDayKey(startOfMonth(monthDate)));
    }
  }, [monthDate, selectedDay]);

  const days = useMemo(() => getMonthGridDays(monthDate), [monthDate]);

  const eventsByDay = useMemo(() => {
    const grouped = new Map<string, CalendarEvent[]>();

    for (const event of events) {
      const key = parseEventDayKey(event.startsAt);
      const list = grouped.get(key) ?? [];
      list.push(event);
      grouped.set(key, list);
    }

    for (const [key, list] of grouped.entries()) {
      grouped.set(
        key,
        list.sort(
          (a, b) =>
            new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
        ),
      );
    }

    return grouped;
  }, [events]);

  const selectedDayEvents = useMemo(
    () => eventsByDay.get(selectedDay) ?? [],
    [eventsByDay, selectedDay],
  );

  const monthLabel = useMemo(
    () =>
      monthDate.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      }),
    [monthDate],
  );

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
      <header className="space-y-2">
        <h1 className="text-balance text-3xl font-semibold text-white">
          Growth Calendar
        </h1>
        <p className="max-w-2xl text-pretty text-sm text-neutral-400">
          Track recurring jobs, scheduled social posts, and published posts in
          one place to simplify weekly prioritization.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="border-white/10 bg-neutral-900">
          <CardContent className="py-4">
            <p className="text-xs text-neutral-500">Job runs</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-sky-300">
              {counts.jobs}
            </p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-neutral-900">
          <CardContent className="py-4">
            <p className="text-xs text-neutral-500">Published posts</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-emerald-300">
              {counts.posts}
            </p>
          </CardContent>
        </Card>
        <Card className="border-white/10 bg-neutral-900">
          <CardContent className="py-4">
            <p className="text-xs text-neutral-500">Social scheduled</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-pink-300">
              {counts.socialScheduled}
            </p>
          </CardContent>
        </Card>
      </div>

      {loadError && <p className="text-sm text-red-400">{loadError}</p>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
        <Card className="border-white/10 bg-neutral-900">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium text-neutral-200">
              Monthly view
            </CardTitle>
            <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label="Previous month"
                className="size-8 text-neutral-300 hover:bg-white/10"
                onClick={() => setMonthDate((current) => shiftMonth(current, -1))}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="min-w-44 text-center text-sm font-medium capitalize text-neutral-200 tabular-nums">
                {monthLabel}
              </span>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Next month"
                className="size-8 text-neutral-300 hover:bg-white/10"
                onClick={() => setMonthDate((current) => shiftMonth(current, 1))}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>

          <CardContent>
            {loading ? (
              <div className="space-y-2">
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAYS.map((weekday) => (
                    <div
                      key={weekday}
                      className="rounded-md py-1 text-center text-xs font-medium text-neutral-500"
                    >
                      {weekday}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-2">
                  {Array.from({ length: 42 }).map((_, index) => (
                    <Skeleton
                      key={index}
                      className="h-28 rounded-lg bg-neutral-800"
                    />
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-7 gap-2">
                  {WEEKDAYS.map((weekday) => (
                    <div
                      key={weekday}
                      className="rounded-md py-1 text-center text-xs font-medium text-neutral-500"
                    >
                      {weekday}
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-7 gap-2">
                  {days.map((day) => {
                    const dayKey = toDayKey(day);
                    const dayEvents = eventsByDay.get(dayKey) ?? [];
                    const inMonth = day.getMonth() === monthDate.getMonth();
                    const isSelected = dayKey === selectedDay;

                    return (
                      <button
                        key={dayKey}
                        type="button"
                        onClick={() => setSelectedDay(dayKey)}
                        className={cn(
                          "min-h-28 rounded-lg border p-2 text-left transition",
                          inMonth
                            ? "border-white/10 bg-white/[0.02] hover:bg-white/[0.04]"
                            : "border-white/[0.04] bg-white/[0.01] opacity-60",
                          isSelected &&
                            "border-violet-500/50 bg-violet-500/10 ring-1 ring-violet-500/30",
                        )}
                      >
                        <div className="flex items-center justify-between">
                          <span
                            className={cn(
                              "inline-flex size-6 items-center justify-center rounded-full text-xs font-medium tabular-nums",
                              inMonth ? "text-neutral-300" : "text-neutral-500",
                            )}
                          >
                            {day.getDate()}
                          </span>
                          {dayEvents.length > 0 && (
                            <span className="text-[10px] text-neutral-500 tabular-nums">
                              {dayEvents.length}
                            </span>
                          )}
                        </div>

                        <div className="mt-2 space-y-1">
                          {dayEvents.slice(0, 2).map((event) => (
                            <div key={event.id} className="flex items-center gap-1.5">
                              <span
                                className={cn(
                                  "inline-block size-1.5 rounded-full",
                                  sourceDotClass(event.source),
                                )}
                              />
                              <p className="truncate text-[11px] text-neutral-300">
                                {event.title}
                              </p>
                            </div>
                          ))}
                          {dayEvents.length > 2 && (
                            <p className="text-[10px] text-neutral-500 tabular-nums">
                              +{dayEvents.length - 2} items
                            </p>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
          <Card className="border-white/10 bg-neutral-900">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm font-medium text-neutral-200">
                <ListTodo className="h-4 w-4" />
                Day agenda ({selectedDay})
              </CardTitle>
            </CardHeader>

            <CardContent>
              {selectedDayEvents.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <p className="text-xs text-neutral-500">No items on this day.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedDayEvents.map((event) => {
                    const eventTime = new Date(event.startsAt).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    });
                    const postType = eventPostType(event);

                    return (
                      <div
                        key={event.id}
                        className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
                      >
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <p className="text-pretty text-sm font-medium text-neutral-200">
                            {event.title}
                          </p>
                          <div className="flex items-center gap-1">
                            <Badge className={cn("text-[10px]", sourceBadgeClass(event.source))}>
                              {sourceLabel(event.source)}
                            </Badge>
                            {postType && (
                              <Badge className={cn("text-[10px]", postTypeBadgeClass(postType))}>
                                {postTypeLabel(postType)}
                              </Badge>
                            )}
                          </div>
                        </div>

                        <div className="mb-2 flex flex-wrap items-center gap-1">
                          <Badge className={cn("text-[10px]", statusBadgeClass(event.status))}>
                            {statusLabel(event.status)}
                          </Badge>
                          <span className="text-[11px] tabular-nums text-neutral-500">
                            {eventTime}
                          </span>
                        </div>

                        {event.notes && (
                          <p className="text-pretty text-xs leading-relaxed text-neutral-400">
                            {event.notes}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
