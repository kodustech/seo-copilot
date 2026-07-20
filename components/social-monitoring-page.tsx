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
  Send,
  CheckSquare,
  Square,
  ChevronLeft,
  ChevronRight,
  Download,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import type {
  SocialMention,
  SocialPlatform,
  Relevance,
  MentionStatus,
  MentionStats,
  Intent,
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
  web: {
    label: "Web",
    className: "bg-emerald-500/20 text-emerald-300",
  },
  github: {
    label: "GitHub",
    className: "bg-neutral-500/20 text-neutral-200",
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
type FilterIntent = Intent | "all";

const INTENT_OPTIONS: FilterIntent[] = [
  "all",
  "backlink_opportunity",
  "competitor_listicle",
  "asking_help",
  "complaining",
  "comparing_tools",
  "sharing_experience",
  "discussing",
];

const PAGE_SIZE = 50;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadCsv(filename: string, rows: Record<string, unknown>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const csv = [
    headers.map(csvCell).join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(",")),
  ].join("\n");
  const blob = new Blob([`\uFEFF${csv}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function outreachTargetTypeFor(mention: SocialMention) {
  if (mention.intent === "competitor_listicle") return "listicle";
  if (mention.intent === "backlink_opportunity") return "link_reclamation";
  if (mention.platform === "github") return "awesome_list";
  return "article";
}

function outreachPriorityFor(mention: SocialMention) {
  return mention.relevance === "high" ? "high" : "medium";
}

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
  const [intentFilter, setIntentFilter] = useState<FilterIntent>("all");
  const [dateFromFilter, setDateFromFilter] = useState<string>("");
  const [dateToFilter, setDateToFilter] = useState<string>("");
  const [page, setPage] = useState<number>(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchSubmitting, setBatchSubmitting] = useState<boolean>(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Authority Score map: domain → ascore (null = unknown / Semrush not configured)
  const [domainAuthority, setDomainAuthority] = useState<
    Record<string, number | null>
  >({});
  const [hideLowDr, setHideLowDr] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("social.hideLowDr") === "1";
  });

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("social.hideLowDr", hideLowDr ? "1" : "0");
    }
  }, [hideLowDr]);

  // Helper: domain from a mention URL (without www).
  function mentionDomain(url: string): string | null {
    try {
      return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return null;
    }
  }

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
      if (intentFilter !== "all") params.set("intent", intentFilter);
      if (dateFromFilter) params.set("dateFrom", dateFromFilter);
      if (dateToFilter) {
        // Treat the date-input value as "end of that day" so the inclusive
        // upper bound covers everything published on the selected calendar
        // day, not just the midnight start.
        params.set("dateTo", `${dateToFilter}T23:59:59.999Z`);
      }
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(page * PAGE_SIZE));

      const res = await fetch(`/api/social/mentions?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        // Read the API's error body so the UI surfaces the real cause
        // (e.g. RLS denial, invalid filter, Supabase outage) instead of a
        // generic "Failed to fetch".
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error ||
            `Failed to fetch mentions (${res.status} ${res.statusText})`,
        );
      }

      const data = await res.json();
      setMentions(data.mentions ?? []);
      setStats(data.stats ?? null);
      // Drop selection between fetches — a checkbox referring to a hidden id
      // would silently apply batch actions to off-screen rows.
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  // Reset to page 0 whenever the filter set changes — paginating into a stale
  // offset would either show an empty page or skip results.
  useEffect(() => {
    setPage(0);
  }, [
    platformFilter,
    relevanceFilter,
    statusFilter,
    intentFilter,
    dateFromFilter,
    dateToFilter,
  ]);

  useEffect(() => {
    fetchMentions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    token,
    platformFilter,
    relevanceFilter,
    statusFilter,
    intentFilter,
    dateFromFilter,
    dateToFilter,
    page,
  ]);

  // Batch action: mark all selected mentions with a new status in one request.
  const batchUpdateStatus = async (status: MentionStatus) => {
    if (!token || selectedIds.size === 0 || batchSubmitting) return;
    setBatchSubmitting(true);
    setError(null);

    const ids = Array.from(selectedIds);

    try {
      const res = await fetch("/api/social/mentions/batch", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ids, status }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(
          body?.error || `Batch update failed (${res.status})`,
        );
      }

      // Optimistic local update — avoid a full refetch for snappy feel.
      setMentions((prev) =>
        prev.map((m) => (selectedIds.has(m.id) ? { ...m, status } : m)),
      );
      setSelectedIds(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Batch update failed");
      // On failure, refetch so the UI matches reality (some rows may have
      // updated before the error).
      fetchMentions();
    } finally {
      setBatchSubmitting(false);
    }
  };

  // Authority Score fetch — only for web mentions, batched, with client-side
  // memoization on top of the server cache so we don't refetch as the list
  // gets filtered.
  useEffect(() => {
    if (!token) return;
    const webDomains = new Set<string>();
    for (const m of mentions) {
      if (m.platform !== "web") continue;
      const d = mentionDomain(m.url);
      if (d && !(d in domainAuthority)) webDomains.add(d);
    }
    if (webDomains.size === 0) return;

    const domains = Array.from(webDomains);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/social/domain-authority", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ domains }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          scores?: Record<string, number | null>;
        };
        if (cancelled || !data.scores) return;
        setDomainAuthority((prev) => ({ ...prev, ...data.scores }));
      } catch {
        // Silent — DR enrichment is best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentions, token]);

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

  const [sentMentions, setSentMentions] = useState<Set<string>>(new Set());
  const [sendingMention, setSendingMention] = useState<string | null>(null);

  const sendToCrm = async (mention: SocialMention) => {
    if (!token || sendingMention) return;
    setSendingMention(mention.id);
    setError(null);

    let domain: string;
    try {
      domain = new URL(mention.url).hostname.replace(/^www\./, "");
    } catch {
      setSendingMention(null);
      setError("Invalid mention URL — cannot derive domain");
      return;
    }

    // Map social-monitor intent → outreach target type
    const targetType =
      mention.intent === "competitor_listicle"
        ? "listicle"
        : mention.intent === "backlink_opportunity"
          ? "link_reclamation"
          : "article";

    const opr = domainAuthority[domain] ?? null;
    const noteParts = [
      mention.suggested_approach
        ? `Suggested approach: ${mention.suggested_approach}`
        : null,
      mention.title ? `Title: ${mention.title}` : null,
      opr !== null ? `Open PageRank: ${opr.toFixed(1)}/10` : null,
      mention.keywords_matched.length > 0
        ? `Keywords: ${mention.keywords_matched.join(", ")}`
        : null,
    ].filter(Boolean);

    try {
      const res = await fetch("/api/outreach/prospects", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          domain,
          url: mention.url,
          targetType,
          contactName: mention.author,
          contactUrl: mention.author_profile_url,
          status: "researching",
          priority: mention.relevance === "high" ? "high" : "medium",
          notes: noteParts.length > 0 ? noteParts.join("\n\n") : null,
          source: `social_monitor:${mention.platform}`,
          sourceMentionId: mention.id,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error || `Failed to send (${res.status})`);
      }

      setSentMentions((prev) => new Set(prev).add(mention.id));
      // Hand-off → mark contacted so we don't push twice and the badge updates
      await updateStatus(mention.id, "contacted");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send to CRM");
    } finally {
      setSendingMention(null);
    }
  };

  const exportSelectedMentions = () => {
    const selected = mentions.filter((mention) => selectedIds.has(mention.id));
    if (selected.length === 0) return;

    const exportedAt = new Date().toISOString();
    const rows = selected.map((mention) => {
      const domain = mentionDomain(mention.url);
      const openPageRank =
        mention.platform === "web" && domain
          ? domainAuthority[domain] ?? null
          : null;
      const targetType = outreachTargetTypeFor(mention);
      const priority = outreachPriorityFor(mention);
      const keywords = mention.keywords_matched.join(", ");
      const notes = [
        mention.suggested_approach
          ? `Suggested approach: ${mention.suggested_approach}`
          : null,
        mention.title ? `Title: ${mention.title}` : null,
        openPageRank !== null
          ? `Open PageRank: ${openPageRank.toFixed(1)}/10`
          : null,
        keywords ? `Keywords: ${keywords}` : null,
      ]
        .filter(Boolean)
        .join("\n\n");

      return {
        exported_at: exportedAt,
        id: mention.id,
        platform: mention.platform,
        platform_label: PLATFORM_BADGES[mention.platform].label,
        url: mention.url,
        domain,
        title: mention.title,
        content: mention.content,
        author: mention.author,
        author_profile_url: mention.author_profile_url,
        published_at: mention.published_at,
        relevance: mention.relevance,
        relevance_label: RELEVANCE_BADGES[mention.relevance].label,
        intent: mention.intent,
        intent_label: INTENT_LABELS[mention.intent] ?? mention.intent,
        status: mention.status,
        status_label: STATUS_LABELS[mention.status].label,
        keywords_matched: keywords,
        suggested_approach: mention.suggested_approach,
        open_pagerank_0_10: openPageRank,
        outreach_target_type: targetType,
        outreach_priority: priority,
        outreach_status_suggestion: "researching",
        outreach_source: `social_monitor:${mention.platform}`,
        source_mention_id: mention.id,
        crm_notes: notes,
        created_at: mention.created_at,
        updated_at: mention.updated_at,
      };
    });

    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`social-monitor-prospects-${stamp}.csv`, rows);
  };

  const syncNow = async () => {
    if (!token || syncing) return;
    setSyncing(true);
    setError(null);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 290_000); // 4m50s

      // When a single platform tab is active, sync only that platform — saves
      // Exa credits + LLM time vs re-running the full collectAll. "All" tab
      // syncs everything (legacy behavior).
      const params = new URLSearchParams();
      if (platformFilter !== "all") params.set("platforms", platformFilter);
      const url = params.toString()
        ? `/api/social/mentions/sync?${params}`
        : "/api/social/mentions/sync";

      const res = await fetch(url, {
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

  // PR-aware filter + sort: web mentions with known PageRank rise to the top
  // of the list (highest first), and PR<2 are hidden when the toggle is on.
  // Scale is Open PageRank 0–10 (free alternative to Semrush DA).
  const LOW_DR_THRESHOLD = 2;
  const visibleMentions = useMemo(() => {
    const drFor = (m: SocialMention): number | null => {
      if (m.platform !== "web") return null;
      const d = mentionDomain(m.url);
      return d ? domainAuthority[d] ?? null : null;
    };

    let list = mentions;
    if (hideLowDr) {
      list = list.filter((m) => {
        if (m.platform !== "web") return true;
        const dr = drFor(m);
        // Keep unknown DR (null) so users still see fresh mentions before
        // the Semrush enrichment lands. Only hide when we have a low score.
        return dr === null || dr >= LOW_DR_THRESHOLD;
      });
    }

    // Stable sort: web mentions with DR first (descending), then everything
    // else in original order.
    return [...list].sort((a, b) => {
      const da = drFor(a);
      const db = drFor(b);
      if (da === null && db === null) return 0;
      if (da === null) return 1;
      if (db === null) return -1;
      return db - da;
    });
  }, [mentions, domainAuthority, hideLowDr]);

  // Batch selection helpers
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    visibleMentions.length > 0 &&
    visibleMentions.every((m) => selectedIds.has(m.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(visibleMentions.map((m) => m.id)));
    }
  };

  // Pagination: if the API returns a full page worth, assume there's at least
  // one more page. The data layer doesn't return a total count.
  const hasNextPage = mentions.length >= PAGE_SIZE;
  const hasPrevPage = page > 0;

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
              ? `${newCount} new ${newCount === 1 ? "opportunity" : "opportunities"} — ${stats.byPlatform["reddit"] || 0} Reddit · ${stats.byPlatform["twitter"] || 0} Twitter · ${stats.byPlatform["linkedin"] || 0} LinkedIn · ${stats.byPlatform["hackernews"] || 0} HN · ${stats.byPlatform["web"] || 0} Web · ${stats.byPlatform["github"] || 0} GitHub`
              : "Loading..."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={syncNow}
            disabled={syncing || loading}
            className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-300 transition hover:bg-violet-500/20 disabled:opacity-50"
            title={
              platformFilter === "all"
                ? "Sync every source — uses Exa credits for Reddit/Twitter/LinkedIn/Web"
                : `Sync only ${PLATFORM_BADGES[platformFilter as SocialPlatform].label} to save credits`
            }
          >
            {syncing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            {syncing
              ? "Syncing..."
              : platformFilter === "all"
                ? "Sync all"
                : `Sync ${PLATFORM_BADGES[platformFilter as SocialPlatform].label}`}
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
          {(["all", "reddit", "twitter", "linkedin", "hackernews", "web", "github"] as const).map((p) => (
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

          {(platformFilter === "web" || platformFilter === "all") && (
            <>
              <span className="mx-1 self-center text-neutral-700">|</span>
              <button
                onClick={() => setHideLowDr((v) => !v)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  hideLowDr
                    ? "bg-amber-500/20 text-amber-300"
                    : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
                }`}
                title="Hide web mentions with Open PageRank below 2 (likely scams or low-authority blogs)"
              >
                {hideLowDr ? "Hiding PR<2" : "Hide low-PR"}
              </button>
            </>
          )}
        </div>

        {/* Intent — surfaces backlink_opportunity / competitor_listicle first,
            which are the actionable buckets. Counts come from getMentionStats
            so they reflect the full table, not the current page. */}
        <div className="flex flex-wrap gap-2">
          {INTENT_OPTIONS.map((i) => {
            const count =
              i === "all"
                ? stats?.total ?? 0
                : stats?.byIntent[i] ?? 0;
            const active = intentFilter === i;
            const label =
              i === "all" ? "Any intent" : INTENT_LABELS[i] ?? i;
            return (
              <button
                key={`intent-${i}`}
                onClick={() => setIntentFilter(i)}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                  active
                    ? "bg-violet-500/20 text-violet-200"
                    : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
                }`}
              >
                {label} ({count})
              </button>
            );
          })}
        </div>

        {/* Date range — bounds on published_at. Empty input = no bound on
            that side, so users can do "since X" or "until Y" without
            filling both. */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500">
          <span>Published</span>
          <input
            type="date"
            value={dateFromFilter}
            onChange={(e) => setDateFromFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-neutral-200 focus:border-violet-500/50 focus:outline-none"
            aria-label="Filter mentions published on or after"
          />
          <span>→</span>
          <input
            type="date"
            value={dateToFilter}
            onChange={(e) => setDateToFilter(e.target.value)}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-xs text-neutral-200 focus:border-violet-500/50 focus:outline-none"
            aria-label="Filter mentions published on or before"
          />
          {(dateFromFilter || dateToFilter) && (
            <button
              onClick={() => {
                setDateFromFilter("");
                setDateToFilter("");
              }}
              className="text-xs text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Batch action bar — only renders when there's at least one selected
          row. Sticky so it stays in reach while the user scrolls a long list. */}
      {selectedIds.size > 0 && (
        <div className="sticky top-2 z-10 mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-950/80 px-4 py-2 text-xs backdrop-blur">
          <span className="font-medium text-violet-200">
            {selectedIds.size} selected
          </span>
          <span className="text-neutral-500">·</span>
          <button
            onClick={() => batchUpdateStatus("contacted")}
            disabled={batchSubmitting}
            className="rounded-md bg-sky-500/20 px-2 py-1 font-medium text-sky-300 transition hover:bg-sky-500/30 disabled:opacity-50"
          >
            Mark contacted
          </button>
          <button
            onClick={() => batchUpdateStatus("replied")}
            disabled={batchSubmitting}
            className="rounded-md bg-emerald-500/20 px-2 py-1 font-medium text-emerald-300 transition hover:bg-emerald-500/30 disabled:opacity-50"
          >
            Mark replied
          </button>
          <button
            onClick={() => batchUpdateStatus("dismissed")}
            disabled={batchSubmitting}
            className="rounded-md bg-neutral-500/20 px-2 py-1 font-medium text-neutral-300 transition hover:bg-neutral-500/30 disabled:opacity-50"
          >
            Dismiss
          </button>
          <button
            onClick={() => batchUpdateStatus("new")}
            disabled={batchSubmitting}
            className="rounded-md bg-violet-500/20 px-2 py-1 font-medium text-violet-300 transition hover:bg-violet-500/30 disabled:opacity-50"
          >
            Reset to new
          </button>
          <span className="text-neutral-500">·</span>
          <button
            onClick={exportSelectedMentions}
            disabled={batchSubmitting}
            className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-2 py-1 font-medium text-neutral-100 transition hover:bg-white/15 disabled:opacity-50"
            title="Export selected rows with prospecting fields"
          >
            <Download className="h-3 w-3" />
            Export CSV
          </button>
          <span className="text-neutral-500">·</span>
          <button
            onClick={() => setSelectedIds(new Set())}
            className="rounded-md px-2 py-1 text-neutral-400 transition hover:text-neutral-200"
          >
            Clear
          </button>
          {batchSubmitting && (
            <Loader2 className="ml-1 h-3 w-3 animate-spin text-violet-300" />
          )}
        </div>
      )}

      {/* Select-all bar — only renders when there are mentions to select.
          Lives outside the conditional batch bar so the user can opt in. */}
      {visibleMentions.length > 0 && (
        <div className="mb-3 flex items-center justify-between text-xs text-neutral-500">
          <button
            onClick={toggleSelectAll}
            className="flex items-center gap-1.5 transition hover:text-neutral-300"
          >
            {allVisibleSelected ? (
              <CheckSquare className="h-3.5 w-3.5" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            {allVisibleSelected
              ? `Deselect ${visibleMentions.length}`
              : `Select all ${visibleMentions.length} on page`}
          </button>
          <span>
            Page {page + 1}
            {hasNextPage ? "" : " (last)"}
          </span>
        </div>
      )}

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
      ) : visibleMentions.length === 0 ? (
        <div className="flex flex-col items-center gap-4 py-20 text-center">
          <Radar className="h-12 w-12 text-neutral-800" />
          <p className="text-neutral-500">
            {hideLowDr && mentions.length > 0
              ? "All web mentions are below DR 20. Disable the low-DR filter to see them."
              : "No mentions found with current filters."}
          </p>
          <p className="text-xs text-neutral-600">
            Click &quot;Sync Now&quot; to collect mentions from Reddit, LinkedIn, Twitter, Hacker News, Web (listicles), and GitHub awesome-lists.
          </p>
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {visibleMentions.map((mention) => {
              const d = mentionDomain(mention.url);
              const dr =
                mention.platform === "web" && d
                  ? domainAuthority[d] ?? null
                  : null;
              const isSelected = selectedIds.has(mention.id);
              return (
                <div key={mention.id} className="flex items-start gap-2">
                  <button
                    onClick={() => toggleSelect(mention.id)}
                    className="mt-4 flex-shrink-0 text-neutral-500 transition hover:text-violet-300"
                    aria-label={
                      isSelected ? "Deselect mention" : "Select mention"
                    }
                  >
                    {isSelected ? (
                      <CheckSquare className="h-4 w-4 text-violet-400" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                  <div className="flex-1">
                    <MentionCard
                      mention={mention}
                      expanded={expanded.has(mention.id)}
                      onToggleExpand={() => toggleExpand(mention.id)}
                      onUpdateStatus={(status) =>
                        updateStatus(mention.id, status)
                      }
                      onSendToCrm={() => sendToCrm(mention)}
                      sending={sendingMention === mention.id}
                      alreadySent={sentMentions.has(mention.id)}
                      domainAuthority={dr}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {(hasPrevPage || hasNextPage) && (
            <div className="mt-6 flex items-center justify-between gap-2 text-xs text-neutral-400">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={!hasPrevPage || loading}
                className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Previous
              </button>
              <span className="text-neutral-500">
                Page {page + 1} · showing {visibleMentions.length}
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNextPage || loading}
                className="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-3 py-1.5 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </>
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
  onSendToCrm,
  sending,
  alreadySent,
  domainAuthority,
}: {
  mention: SocialMention;
  expanded: boolean;
  onToggleExpand: () => void;
  onUpdateStatus: (status: MentionStatus) => void;
  onSendToCrm: () => void;
  sending: boolean;
  alreadySent: boolean;
  domainAuthority: number | null;
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
              {mention.platform === "web" && domainAuthority !== null && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    domainAuthority >= 6
                      ? "bg-emerald-500/20 text-emerald-300"
                      : domainAuthority >= 4
                        ? "bg-sky-500/20 text-sky-300"
                        : domainAuthority >= 2
                          ? "bg-amber-500/20 text-amber-300"
                          : "bg-red-500/20 text-red-300"
                  }`}
                  title="Open PageRank (0–10) — free alternative to Semrush DA"
                >
                  PR {domainAuthority.toFixed(1)}
                </span>
              )}
              {mention.author && (
                <span className="text-[10px] text-neutral-600">
                  by {mention.author}
                </span>
              )}
              {mention.published_at && (
                <span className="text-[10px] text-neutral-600">
                  {new Date(mention.published_at).toLocaleDateString("en-US")}
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
            {mention.platform === "web" && (
              <button
                onClick={onSendToCrm}
                disabled={sending || alreadySent}
                className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-1.5 text-xs font-medium text-violet-300 transition hover:bg-violet-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                title={
                  alreadySent
                    ? "Already added as a prospect"
                    : "Create an outreach prospect from this mention"
                }
              >
                {sending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : alreadySent ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Send className="h-3 w-3" />
                )}
                {sending
                  ? "Sending…"
                  : alreadySent
                    ? "Sent to CRM"
                    : "Send to CRM"}
              </button>
            )}
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
