"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Radar,
  ExternalLink,
  Check,
  MessageSquare,
  X,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type {
  SocialMention,
  SocialPlatform,
  Relevance,
  MentionStatus,
  MentionStats,
} from "@/lib/social-monitoring";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PLATFORM_BADGES: Record<
  SocialPlatform,
  { label: string; className: string }
> = {
  reddit: {
    label: "Reddit",
    className: "bg-orange-500/20 text-orange-300",
  },
  twitter: {
    label: "Twitter/X",
    className: "bg-sky-500/20 text-sky-300",
  },
  linkedin: {
    label: "LinkedIn",
    className: "bg-blue-600/20 text-blue-300",
  },
  hackernews: {
    label: "HN",
    className: "bg-orange-600/20 text-orange-200",
  },
};

const RELEVANCE_BADGES: Record<Relevance, { label: string; className: string }> =
  {
    high: {
      label: "High",
      className: "bg-emerald-500/20 text-emerald-300",
    },
    medium: {
      label: "Medium",
      className: "bg-amber-500/20 text-amber-300",
    },
    low: {
      label: "Low",
      className: "bg-neutral-500/20 text-neutral-400",
    },
  };

const INTENT_LABELS: Record<string, string> = {
  asking_help: "Asking for help",
  complaining: "Complaining",
  comparing_tools: "Comparing tools",
  discussing: "Discussion",
  sharing_experience: "Sharing experience",
  backlink_opportunity: "Backlink opportunity",
  competitor_listicle: "Listicle missing Kodus",
};

const STATUS_LABELS: Record<MentionStatus, { label: string; className: string }> = {
  new: { label: "New", className: "bg-violet-500/20 text-violet-300" },
  contacted: { label: "Contacted", className: "bg-sky-500/20 text-sky-300" },
  replied: { label: "Replied", className: "bg-emerald-500/20 text-emerald-300" },
  dismissed: { label: "Dismissed", className: "bg-neutral-500/20 text-neutral-400" },
};

type FilterPlatform = SocialPlatform | "all";
type FilterRelevance = Relevance | "all";
type FilterStatus = MentionStatus | "all";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SocialMonitoringPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [mentions, setMentions] = useState<SocialMention[]>([]);
  const [stats, setStats] = useState<MentionStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [platformFilter, setPlatformFilter] = useState<FilterPlatform>("all");
  const [relevanceFilter, setRelevanceFilter] = useState<FilterRelevance>("all");
  const [statusFilter, setStatusFilter] = useState<FilterStatus>("new");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Auth
  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  // Fetch
  const fetchMentions = async () => {
    if (!token) return;
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      if (platformFilter !== "all") params.set("platform", platformFilter);
      if (relevanceFilter !== "all") params.set("relevance", relevanceFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("limit", "100");

      const res = await fetch(`/api/social/mentions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) throw new Error("Failed to fetch mentions");

      const data = await res.json();
      setMentions(data.mentions ?? []);
      setStats(data.stats ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMentions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, platformFilter, relevanceFilter, statusFilter]);

  // Actions
  const updateStatus = async (id: string, status: MentionStatus) => {
    if (!token) return;

    try {
      const res = await fetch(`/api/social/mentions/${id}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      });

      if (!res.ok) throw new Error("Failed to update");

      setMentions((prev) =>
        prev.map((m) => (m.id === id ? { ...m, status } : m)),
      );
      // Update stats locally
      if (stats) {
        const oldStatus = mentions.find((m) => m.id === id)?.status;
        if (oldStatus) {
          setStats({
            ...stats,
            byStatus: {
              ...stats.byStatus,
              [oldStatus]: (stats.byStatus[oldStatus] || 1) - 1,
              [status]: (stats.byStatus[status] || 0) + 1,
            },
          });
        }
      }
    } catch {
      // Refetch on error
      fetchMentions();
    }
  };

  const syncNow = async () => {
    if (!token || syncing) return;
    setSyncing(true);
    setError(null);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 290_000); // 4m50s

      const res = await fetch("/api/social/mentions/sync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Sync failed (${res.status})`);
      }

      const result = await res.json();
      console.log("[sync] Result:", result);

      // Reload mentions after sync completes
      await fetchMentions();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError("Sync is taking too long. It may still be running — try Refresh in a minute.");
      } else {
        setError(err instanceof Error ? err.message : "Sync failed");
      }
    } finally {
      setSyncing(false);
    }
  };

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const newCount = stats?.byStatus["new"] || 0;

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {/* Header */}
      <div className="mb-8 flex items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <Radar className="h-6 w-6 text-violet-400" />
            Social Monitor
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            {stats
              ? `${newCount} new ${newCount === 1 ? "opportunity" : "opportunities"} — ${stats.byPlatform["reddit"] || 0} Reddit · ${stats.byPlatform["twitter"] || 0} Twitter · ${stats.byPlatform["linkedin"] || 0} LinkedIn · ${stats.byPlatform["hackernews"] || 0} HN`
              : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncNow}
            disabled={syncing || loading}
            className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-50"
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {syncing ? "Syncing..." : "Sync Now"}
          </button>
          <button
            onClick={fetchMentions}
            disabled={loading || syncing}
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-neutral-200 transition hover:bg-white/10 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="mb-6 space-y-3">
        {/* Platform */}
        <div className="flex flex-wrap gap-2">
          {(["all", "reddit", "twitter", "linkedin", "hackernews"] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPlatformFilter(p)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                platformFilter === p
                  ? p === "all"
                    ? "bg-white/15 text-white"
                    : PLATFORM_BADGES[p].className
                  : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {p === "all"
                ? `All (${stats?.total || 0})`
                : `${PLATFORM_BADGES[p].label} (${stats?.byPlatform[p] || 0})`}
            </button>
          ))}
        </div>

        {/* Relevance + Status */}
        <div className="flex flex-wrap gap-2">
          {(["all", "high", "medium"] as const).map((r) => (
            <button
              key={`rel-${r}`}
              onClick={() => setRelevanceFilter(r)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                relevanceFilter === r
                  ? r === "all"
                    ? "bg-white/15 text-white"
                    : RELEVANCE_BADGES[r].className
                  : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
              }`}
            >
              {r === "all" ? "Any relevance" : RELEVANCE_BADGES[r].label}
            </button>
          ))}

          <span className="mx-1 self-center text-neutral-700">|</span>

          {(["all", "new", "contacted", "replied", "dismissed"] as const).map(
            (s) => (
              <button
                key={`st-${s}`}
                onClick={() => setStatusFilter(s)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  statusFilter === s
                    ? s === "all"
                      ? "bg-white/15 text-white"
                      : STATUS_LABELS[s].className
                    : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {s === "all" ? "Any status" : STATUS_LABELS[s].label}
              </button>
            ),
          )}
        </div>
      </div>

      {/* Content */}
      {loading && mentions.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-neutral-600" />
        </div>
      ) : error ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <p className="text-sm text-red-400">{error}</p>
          <button
            onClick={fetchMentions}
            className="rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-violet-500"
          >
            Try again
          </button>
        </div>
      ) : mentions.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <Radar className="h-12 w-12 text-neutral-800" />
          <p className="text-neutral-500">No mentions found with current filters.</p>
          <p className="text-xs text-neutral-600">
            Click "Sync Now" to collect mentions from Reddit, LinkedIn, Twitter, and Hacker News.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {mentions.map((mention) => (
            <MentionCard
              key={mention.id}
              mention={mention}
              expanded={expanded.has(mention.id)}
              onToggleExpand={() => toggleExpand(mention.id)}
              onUpdateStatus={(status) => updateStatus(mention.id, status)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

function MentionCard({
  mention,
  expanded,
  onToggleExpand,
  onUpdateStatus,
}: {
  mention: SocialMention;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdateStatus: (status: MentionStatus) => void;
}) {
  const platformBadge = PLATFORM_BADGES[mention.platform];
  const relevanceBadge = RELEVANCE_BADGES[mention.relevance];
  const statusBadge = STATUS_LABELS[mention.status];
  const intentLabel = INTENT_LABELS[mention.intent] ?? mention.intent;

  return (
    <div className="rounded-xl border border-white/[0.06] bg-neutral-900/60 transition hover:border-white/10">
      <div className="cursor-pointer px-5 py-4" onClick={onToggleExpand}>
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold leading-snug text-white">
              {mention.title}
            </h3>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${platformBadge.className}`}
              >
                {platformBadge.label}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${relevanceBadge.className}`}
              >
                {relevanceBadge.label}
              </span>
              <span className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] font-medium text-neutral-400">
                {intentLabel}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${statusBadge.className}`}
              >
                {statusBadge.label}
              </span>
              {mention.author && (
                <span className="text-[10px] text-neutral-600">
                  by {mention.author}
                </span>
              )}
              {mention.published_at && (
                <span className="text-[10px] text-neutral-600">
                  {new Date(mention.published_at).toLocaleDateString("pt-BR")}
                </span>
              )}
            </div>
          </div>
          <a
            href={mention.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="rounded-lg p-1.5 text-neutral-600 transition hover:bg-white/10 hover:text-white"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-white/[0.04] px-5 py-4">
          {/* Content */}
          <p className="text-sm leading-relaxed text-neutral-400">
            {mention.content}
          </p>

          {/* Suggested approach */}
          <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3">
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-violet-400">
              Suggested approach
            </p>
            <p className="text-sm leading-relaxed text-neutral-300">
              {mention.suggested_approach}
            </p>
          </div>

          {/* Keywords */}
          {mention.keywords_matched.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {mention.keywords_matched.map((kw) => (
                <span
                  key={kw}
                  className="rounded bg-white/[0.04] px-2 py-0.5 text-[10px] text-neutral-500"
                >
                  {kw}
                </span>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 pt-1">
            {mention.status !== "contacted" && (
              <button
                onClick={() => onUpdateStatus("contacted")}
                className="flex items-center gap-1.5 rounded-lg border border-sky-500/20 bg-sky-500/10 px-3 py-1.5 text-xs font-medium text-sky-300 transition hover:bg-sky-500/20"
              >
                <MessageSquare className="h-3 w-3" />
                Mark contacted
              </button>
            )}
            {mention.status !== "replied" && (
              <button
                onClick={() => onUpdateStatus("replied")}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 transition hover:bg-emerald-500/20"
              >
                <Check className="h-3 w-3" />
                Mark replied
              </button>
            )}
            {mention.status !== "dismissed" && (
              <button
                onClick={() => onUpdateStatus("dismissed")}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-white/10"
              >
                <X className="h-3 w-3" />
                Dismiss
              </button>
            )}
            {mention.status !== "new" && (
              <button
                onClick={() => onUpdateStatus("new")}
                className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-neutral-400 transition hover:bg-white/10"
              >
                Reset to new
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
