"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clipboard,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";

type TargetAccount = {
  id: string;
  x_username: string;
  display_name: string | null;
  avatar_url: string | null;
  enabled: boolean;
  last_synced_at: string | null;
};

type DraftAngle = "contrarian" | "add_specificity" | "sharp_question";

type Draft = {
  id: string;
  position: number;
  angle: DraftAngle;
  draft_text: string;
  selected: boolean;
};

type CandidateMetrics = {
  likes?: number;
  retweets?: number;
  replies?: number;
  quotes?: number;
  bookmarks?: number;
  impressions?: number;
};

type Candidate = {
  id: string;
  target_account_id: string;
  x_post_id: string;
  post_url: string;
  post_text: string;
  post_created_at: string;
  author_username: string;
  author_display_name: string | null;
  author_avatar_url: string | null;
  metrics: CandidateMetrics;
  engagement_score: number;
  status: "new" | "drafted" | "dismissed" | "replied" | "snoozed";
  fetched_at: string;
  user_hint?: string | null;
  x_reply_drafts?: Draft[];
};

const ANGLE_LABELS: Record<DraftAngle, string> = {
  contrarian: "Contrarian",
  add_specificity: "Specifics",
  sharp_question: "Sharp question",
};

const STATUS_FILTERS = [
  { value: "active", label: "Active" },
  { value: "new", label: "New" },
  { value: "drafted", label: "Drafted" },
  { value: "replied", label: "Replied" },
  { value: "dismissed", label: "Dismissed" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["value"];

function formatNumber(n: number | undefined): string {
  if (!n) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function formatRelativeTime(iso: string): string {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.round(diffMs / 60000);
  if (diffMin < 1) return "now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return `${diffDay}d ago`;
}

function buildReplyIntent(post: Candidate, text: string): string {
  const params = new URLSearchParams({
    text,
    in_reply_to: post.x_post_id,
  });
  return `https://x.com/intent/tweet?${params.toString()}`;
}

export function ReplyRadarPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);

  const [targets, setTargets] = useState<TargetAccount[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(false);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [addingTarget, setAddingTarget] = useState(false);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [targetFilter, setTargetFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [draftEdits, setDraftEdits] = useState<Record<string, string>>({});
  const [regenerating, setRegenerating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hintDraft, setHintDraft] = useState<string>("");

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  const authHeaders = useCallback(() => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }, [token]);

  const fetchTargets = useCallback(async () => {
    if (!token) return;
    setTargetsLoading(true);
    setTargetsError(null);
    try {
      const res = await fetch("/api/x/targets", {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load targets");
      setTargets(data.targets ?? []);
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setTargetsLoading(false);
    }
  }, [token, authHeaders]);

  const fetchCandidates = useCallback(async () => {
    if (!token) return;
    setCandidatesLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter === "active") {
        params.set("status", "new,drafted");
      } else {
        params.set("status", statusFilter);
      }
      if (targetFilter) params.set("target", targetFilter);

      const res = await fetch(`/api/x/candidates?${params}`, {
        headers: authHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to load candidates");
      const list = (data.candidates ?? []) as Candidate[];
      setCandidates(list);
      if (list.length) {
        setSelectedId((prev) =>
          prev && list.find((c) => c.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedId(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCandidatesLoading(false);
    }
  }, [token, statusFilter, targetFilter, authHeaders]);

  useEffect(() => {
    if (token) {
      void fetchTargets();
      void fetchCandidates();
    }
  }, [token, fetchTargets, fetchCandidates]);

  async function handleAddTarget(event: React.FormEvent) {
    event.preventDefault();
    if (!newUsername.trim()) return;
    setAddingTarget(true);
    setTargetsError(null);
    try {
      const res = await fetch("/api/x/targets", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ username: newUsername.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to add target");
      setNewUsername("");
      await fetchTargets();
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setAddingTarget(false);
    }
  }

  async function handleRemoveTarget(id: string) {
    try {
      const res = await fetch(`/api/x/targets?id=${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to remove");
      }
      await fetchTargets();
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleToggleTarget(id: string, enabled: boolean) {
    try {
      await fetch("/api/x/targets", {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ id, enabled }),
      });
      await fetchTargets();
    } catch (err) {
      setTargetsError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleCandidateStatus(
    id: string,
    status: "replied" | "dismissed",
  ) {
    try {
      await fetch("/api/x/candidates", {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ id, status }),
      });
      setCandidates((prev) => prev.filter((c) => c.id !== id));
      setSelectedId((prev) => (prev === id ? null : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleRegenerate(candidateId: string) {
    setRegenerating(true);
    setError(null);
    try {
      const res = await fetch("/api/x/drafts", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          candidateId,
          userHint: hintDraft.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || "Failed to generate");
      setCandidates((prev) =>
        prev.map((c) =>
          c.id === candidateId
            ? {
                ...c,
                x_reply_drafts: data.drafts ?? [],
                status: "drafted",
                user_hint: hintDraft.trim() || null,
              }
            : c,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRegenerating(false);
    }
  }

  async function handleCopy(draftId: string, text: string) {
    try {
      await copyToClipboard(text);
      setCopiedId(draftId);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError("Could not copy this draft right now.");
    }
  }

  const selectedCandidate = useMemo(
    () => candidates.find((c) => c.id === selectedId) ?? null,
    [candidates, selectedId],
  );

  useEffect(() => {
    setHintDraft(selectedCandidate?.user_hint ?? "");
  }, [selectedId, selectedCandidate?.user_hint]);

  const remainingSlots = Math.max(0, 20 - targets.length);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold">Reply Radar</h1>
          <p className="text-xs text-neutral-500">
            High-signal posts from your X target accounts, with pre-drafted replies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 border-white/10 bg-transparent text-neutral-300 hover:bg-white/10"
            onClick={() => fetchCandidates()}
            disabled={candidatesLoading}
          >
            {candidatesLoading ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-3.5 w-3.5" />
            )}
            Refresh
          </Button>
          <Button
            size="sm"
            className="h-8 bg-violet-600 text-white hover:bg-violet-500"
            onClick={() => setTargetsOpen(true)}
          >
            Manage targets
            <Badge
              variant="outline"
              className="ml-2 border-white/20 bg-white/10 text-[10px] text-white"
            >
              {targets.length}/20
            </Badge>
          </Button>
        </div>
      </header>

      <div className="flex items-center gap-2 border-b border-white/5 px-6 py-2 text-xs">
        {STATUS_FILTERS.map((filter) => (
          <button
            key={filter.value}
            onClick={() => setStatusFilter(filter.value)}
            className={cn(
              "rounded-full px-3 py-1 transition",
              statusFilter === filter.value
                ? "bg-violet-500/20 text-violet-200"
                : "text-neutral-500 hover:text-neutral-300",
            )}
          >
            {filter.label}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <select
            value={targetFilter ?? ""}
            onChange={(event) => setTargetFilter(event.target.value || null)}
            className="rounded-md border border-white/10 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
          >
            <option value="">All targets</option>
            {targets.map((t) => (
              <option key={t.id} value={t.id}>
                @{t.x_username}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div className="border-b border-red-500/30 bg-red-500/10 px-6 py-2 text-xs text-red-300">
          {error}
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="w-[360px] shrink-0 overflow-y-auto border-r border-white/10">
          {candidatesLoading ? (
            <div className="flex h-full items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
            </div>
          ) : candidates.length === 0 ? (
            <div className="p-6 text-center text-sm text-neutral-500">
              {targets.length === 0
                ? "Add target accounts to start surfacing posts."
                : "No candidates yet. Wait for the next sync."}
            </div>
          ) : (
            <ul className="divide-y divide-white/5">
              {candidates.map((candidate) => {
                const active = candidate.id === selectedId;
                return (
                  <li key={candidate.id}>
                    <button
                      onClick={() => setSelectedId(candidate.id)}
                      className={cn(
                        "w-full space-y-1.5 px-4 py-3 text-left transition",
                        active
                          ? "bg-white/[0.05]"
                          : "hover:bg-white/[0.02]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2 text-[11px] text-neutral-500">
                        <span className="truncate font-medium text-neutral-300">
                          @{candidate.author_username}
                        </span>
                        <span>{formatRelativeTime(candidate.post_created_at)}</span>
                      </div>
                      <p className="line-clamp-3 text-sm leading-snug text-neutral-200">
                        {candidate.post_text}
                      </p>
                      <div className="flex items-center gap-3 text-[10px] text-neutral-500">
                        <span>♥ {formatNumber(candidate.metrics.likes)}</span>
                        <span>↻ {formatNumber(candidate.metrics.retweets)}</span>
                        <span>💬 {formatNumber(candidate.metrics.replies)}</span>
                        {candidate.status === "drafted" ? (
                          <Badge
                            variant="outline"
                            className="ml-auto border-violet-400/40 bg-violet-500/10 text-[9px] text-violet-200"
                          >
                            Drafted
                          </Badge>
                        ) : null}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {selectedCandidate ? (
            <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
              <Card className="border-white/10 bg-white/[0.02]">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">
                        {selectedCandidate.author_display_name ??
                          `@${selectedCandidate.author_username}`}
                      </CardTitle>
                      <CardDescription>
                        @{selectedCandidate.author_username} ·{" "}
                        {formatRelativeTime(selectedCandidate.post_created_at)}
                      </CardDescription>
                    </div>
                    <a
                      href={selectedCandidate.post_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-neutral-400 hover:text-neutral-200"
                    >
                      Open <ExternalLink className="ml-1 inline h-3 w-3" />
                    </a>
                  </div>
                </CardHeader>
                <CardContent>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-200">
                    {selectedCandidate.post_text}
                  </p>
                  <div className="mt-3 flex items-center gap-4 text-xs text-neutral-500">
                    <span>♥ {formatNumber(selectedCandidate.metrics.likes)}</span>
                    <span>
                      ↻ {formatNumber(selectedCandidate.metrics.retweets)}
                    </span>
                    <span>
                      💬 {formatNumber(selectedCandidate.metrics.replies)}
                    </span>
                    <span>
                      👀 {formatNumber(selectedCandidate.metrics.impressions)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <div className="space-y-2">
                <label className="flex items-center justify-between text-xs text-neutral-400">
                  <span>Your take (optional)</span>
                  {hintDraft.trim() ? (
                    <button
                      type="button"
                      onClick={() => setHintDraft("")}
                      className="text-[10px] text-neutral-500 hover:text-neutral-300"
                    >
                      Clear
                    </button>
                  ) : null}
                </label>
                <Textarea
                  value={hintDraft}
                  onChange={(event) => setHintDraft(event.target.value)}
                  placeholder="What do you want to say about this post? E.g. 'I think building your own email editor is worth it when you need deep brand integration.'"
                  className="min-h-[72px] resize-none border-white/10 bg-white/[0.02] text-xs text-neutral-200"
                />
                <p className="text-[10px] text-neutral-500">
                  If filled, the 3 drafts will express this take through each
                  angle (contrarian / specifics / question) instead of guessing
                  one from the post alone. Saved per candidate.
                </p>
              </div>

              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-neutral-200">
                  Reply drafts
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 border-white/10 bg-transparent text-xs text-neutral-300 hover:bg-white/10"
                  onClick={() => handleRegenerate(selectedCandidate.id)}
                  disabled={regenerating}
                >
                  {regenerating ? (
                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                  ) : (
                    <Sparkles className="mr-1.5 h-3 w-3" />
                  )}
                  Regenerate
                </Button>
              </div>

              {selectedCandidate.x_reply_drafts &&
              selectedCandidate.x_reply_drafts.length > 0 ? (
                <div className="space-y-3">
                  {[...selectedCandidate.x_reply_drafts]
                    .sort((a, b) => a.position - b.position)
                    .map((draft) => {
                      const currentText =
                        draftEdits[draft.id] ?? draft.draft_text;
                      return (
                        <Card
                          key={draft.id}
                          className="border-white/10 bg-white/[0.02]"
                        >
                          <CardHeader className="pb-2">
                            <div className="flex items-center justify-between">
                              <Badge
                                variant="outline"
                                className="border-white/10 bg-white/5 text-[10px] text-neutral-300"
                              >
                                {ANGLE_LABELS[draft.angle]}
                              </Badge>
                              <span className="text-[10px] text-neutral-500">
                                {currentText.length}/260
                              </span>
                            </div>
                          </CardHeader>
                          <CardContent className="space-y-3">
                            <Textarea
                              value={currentText}
                              onChange={(event) =>
                                setDraftEdits((prev) => ({
                                  ...prev,
                                  [draft.id]: event.target.value,
                                }))
                              }
                              className="min-h-[80px] resize-none border-white/10 bg-neutral-900 text-sm"
                            />
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs text-neutral-400 hover:text-neutral-100"
                                onClick={() => handleCopy(draft.id, currentText)}
                              >
                                <Clipboard className="mr-1.5 h-3.5 w-3.5" />
                                {copiedId === draft.id ? "Copied" : "Copy"}
                              </Button>
                              <a
                                href={buildReplyIntent(
                                  selectedCandidate,
                                  currentText,
                                )}
                                target="_blank"
                                rel="noreferrer"
                              >
                                <Button
                                  size="sm"
                                  className="h-8 bg-violet-600 text-xs text-white hover:bg-violet-500"
                                >
                                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                                  Reply on X
                                </Button>
                              </a>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-6 text-center text-sm text-neutral-500">
                  No drafts yet.{" "}
                  <button
                    className="text-violet-300 hover:underline"
                    onClick={() => handleRegenerate(selectedCandidate.id)}
                  >
                    Generate now
                  </button>
                  .
                </div>
              )}

              <div className="flex items-center justify-between border-t border-white/10 pt-4">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-neutral-400"
                  onClick={() =>
                    handleCandidateStatus(selectedCandidate.id, "dismissed")
                  }
                >
                  <X className="mr-1.5 h-3.5 w-3.5" />
                  Dismiss
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="border-emerald-500/40 bg-emerald-500/10 text-xs text-emerald-300"
                  onClick={() =>
                    handleCandidateStatus(selectedCandidate.id, "replied")
                  }
                >
                  Mark as replied
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-neutral-500">
              Select a candidate to see drafts.
            </div>
          )}
        </div>
      </div>

      <Dialog open={targetsOpen} onOpenChange={setTargetsOpen}>
        <DialogContent className="border-white/10 bg-neutral-950 text-neutral-100 sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Target accounts</DialogTitle>
            <DialogDescription className="text-neutral-400">
              Add up to 20 X accounts. The Radar pulls their recent posts and
              flags the ones worth replying to.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleAddTarget} className="flex items-center gap-2">
            <Input
              value={newUsername}
              onChange={(event) => setNewUsername(event.target.value)}
              placeholder="@username"
              className="border-white/10 bg-neutral-900"
              disabled={remainingSlots === 0 || addingTarget}
            />
            <Button
              type="submit"
              className="bg-violet-600 hover:bg-violet-500"
              disabled={!newUsername.trim() || remainingSlots === 0 || addingTarget}
            >
              {addingTarget ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          </form>

          {targetsError ? (
            <p className="text-xs text-red-400">{targetsError}</p>
          ) : null}

          <div className="max-h-[360px] space-y-1 overflow-y-auto">
            {targetsLoading ? (
              <div className="flex justify-center py-6">
                <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
              </div>
            ) : targets.length === 0 ? (
              <p className="py-6 text-center text-sm text-neutral-500">
                No targets yet.
              </p>
            ) : (
              targets.map((target) => (
                <div
                  key={target.id}
                  className="flex items-center justify-between rounded-md border border-white/5 bg-white/[0.02] px-3 py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-neutral-200">
                      {target.display_name ?? `@${target.x_username}`}
                    </p>
                    <p className="text-xs text-neutral-500">
                      @{target.x_username}
                      {target.last_synced_at
                        ? ` · synced ${formatRelativeTime(target.last_synced_at)}`
                        : " · never synced"}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() =>
                        handleToggleTarget(target.id, !target.enabled)
                      }
                      className={cn(
                        "rounded-full px-2 py-0.5 text-[10px]",
                        target.enabled
                          ? "bg-emerald-500/15 text-emerald-300"
                          : "bg-neutral-700/40 text-neutral-400",
                      )}
                    >
                      {target.enabled ? "Enabled" : "Paused"}
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-neutral-500 hover:text-red-300"
                      onClick={() => handleRemoveTarget(target.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          <DialogFooter>
            <p className="text-xs text-neutral-500">
              {remainingSlots} slot{remainingSlots === 1 ? "" : "s"} remaining
            </p>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
