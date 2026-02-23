"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarPlus, Clipboard, Loader2, RefreshCw, Save } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type LaneFilter = "all" | "blog" | "changelog" | "mixed";
type PersistedYoloStatus = "draft" | "selected" | "discarded";
type ReviewStatus = "draft" | "reviewed" | "scheduled" | "discarded";
type StatusFilter = "all" | ReviewStatus;

type YoloPost = {
  id: string;
  position: number;
  lane: "blog" | "changelog" | "mixed";
  theme: string;
  platform: string;
  hook: string;
  content: string;
  cta: string;
  hashtags: string[];
  status: PersistedYoloStatus;
};

type EditableYoloPost = YoloPost & {
  body: string;
};

type YoloApiResponse = {
  batchDate: string | null;
  generatedAt?: string | null;
  stale?: boolean;
  posts?: YoloPost[];
  error?: string;
};

type SocialAccount = {
  id: number;
  platform: string;
  username: string;
};

type ScheduledSocialPost = {
  id: string;
  caption: string;
  status: string | null;
  scheduledAt: string | null;
  socialAccountIds: number[];
};

type ScheduledSocialApiResponse = {
  posts?: ScheduledSocialPost[];
  error?: string;
};

type YoloPatchResponse = {
  post?: YoloPost;
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

function jsonHeaders(token?: string | null) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function toEditablePost(post: YoloPost): EditableYoloPost {
  const hook = normalizeMultiline(post.hook).trim();
  const content = normalizeMultiline(post.content).trim();

  let body = "";
  if (hook && content) {
    body = content.toLowerCase().startsWith(hook.toLowerCase())
      ? content
      : `${hook}\n\n${content}`;
  } else {
    body = hook || content;
  }
  body = normalizeBodyLayout(body);

  return {
    ...post,
    body,
  };
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeBodyLayout(value: string): string {
  const normalized = normalizeMultiline(value).trim();
  if (!normalized) return "";

  if (/\n\s*\n/.test(normalized)) {
    return normalized.replace(/\n{3,}/g, "\n\n");
  }

  const compact = normalized.replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  const sentences = compact
    .split(/(?<=[.!?])\s+/g)
    .map((item) => item.trim())
    .filter(Boolean);

  if (sentences.length < 3) {
    return normalized;
  }

  const chunks: string[] = [];
  let current: string[] = [];

  for (const sentence of sentences) {
    current.push(sentence);
    const length = current.join(" ").length;
    if (current.length >= 2 || length >= 220) {
      chunks.push(current.join(" "));
      current = [];
    }
  }

  if (current.length) {
    chunks.push(current.join(" "));
  }

  return chunks.join("\n\n");
}

function deriveThemeFromBody(body: string, fallback: string): string {
  const cleaned = body.replace(/\r\n?/g, "\n").trim();
  if (!cleaned) {
    return fallback.trim();
  }

  const [firstLine] = cleaned.split("\n").filter((line) => line.trim().length > 0);
  const theme = firstLine?.trim() || fallback.trim();
  if (!theme) {
    return "Social post idea";
  }
  return theme.slice(0, 120);
}

function postCaptionFromBody(body: string): string {
  return normalizeMultiline(body).trim();
}

function captionSignature(caption: string): string {
  return normalizeMultiline(caption)
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getDefaultScheduleDate(): string {
  const now = new Date();
  const next = new Date(now);
  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);
  return next.toISOString().slice(0, 10);
}

function scheduleDateToIso(dateValue: string, timeValue: string): string | null {
  if (!dateValue || !timeValue) return null;

  const [year, month, day] = dateValue.split("-").map((value) => Number(value));
  const [hours, minutes] = timeValue.split(":").map((value) => Number(value));
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes)
  ) {
    return null;
  }

  const localDate = new Date(year, month - 1, day, hours, minutes, 0, 0);
  if (Number.isNaN(localDate.getTime())) return null;
  return localDate.toISOString();
}

function toReviewStatus(
  post: EditableYoloPost,
  scheduledPostIds: Set<string>,
): ReviewStatus {
  if (post.status === "discarded") {
    return "discarded";
  }
  if (scheduledPostIds.has(post.id)) {
    return "scheduled";
  }
  if (post.status === "selected") {
    return "reviewed";
  }
  return "draft";
}

function mapReviewStatusToPersisted(value: string): PersistedYoloStatus {
  if (value === "reviewed") return "selected";
  if (value === "discarded") return "discarded";
  return "draft";
}

function mapPersistedStatusToReview(
  value: PersistedYoloStatus,
): "draft" | "reviewed" | "discarded" {
  if (value === "selected") return "reviewed";
  return value;
}

function statusBadgeClass(status: ReviewStatus): string {
  if (status === "scheduled") {
    return "border-sky-500/40 bg-sky-500/10 text-sky-300";
  }
  if (status === "reviewed") {
    return "border-emerald-500/40 bg-emerald-500/10 text-emerald-300";
  }
  if (status === "discarded") {
    return "border-red-500/40 bg-red-500/10 text-red-300";
  }
  return "border-white/20 bg-white/[0.03] text-neutral-300";
}

function statusLabel(status: ReviewStatus): string {
  if (status === "reviewed") return "reviewed";
  return status;
}

function formatAccountLabel(account: SocialAccount): string {
  const safePlatform = account.platform.trim() || "Social";
  const safeUsername = account.username.trim().replace(/^@+/, "") || "unknown";
  return `${safePlatform} @${safeUsername}`;
}

export function SocialYoloPage() {
  const token = useAuthToken();
  const [loading, setLoading] = useState(true);
  const [regenerating, setRegenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [batchDate, setBatchDate] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [posts, setPosts] = useState<EditableYoloPost[]>([]);
  const [laneFilter, setLaneFilter] = useState<LaneFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [selectedPostIds, setSelectedPostIds] = useState<Set<string>>(new Set());
  const [scheduledPostIds, setScheduledPostIds] = useState<Set<string>>(new Set());
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorPostId, setEditorPostId] = useState<string | null>(null);
  const [editorPlatform, setEditorPlatform] = useState("");
  const [editorBody, setEditorBody] = useState("");
  const [editorStatus, setEditorStatus] = useState<
    "draft" | "reviewed" | "discarded"
  >("draft");
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTargetIds, setScheduleTargetIds] = useState<string[]>([]);
  const [scheduleDate, setScheduleDate] = useState(getDefaultScheduleDate);
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleAccounts, setScheduleAccounts] = useState<SocialAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [scheduleLoadingAccounts, setScheduleLoadingAccounts] = useState(false);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    void loadLatestBatch(token);
  }, [token]);

  async function fetchScheduledCaptionSignatures(
    currentToken: string,
  ): Promise<Set<string>> {
    try {
      const response = await fetch("/api/social/schedule", {
        method: "GET",
        headers: jsonHeaders(currentToken),
      });
      const data = (await response.json()) as ScheduledSocialApiResponse;
      if (!response.ok) {
        return new Set<string>();
      }

      const signatures = new Set<string>();
      const items = Array.isArray(data.posts) ? data.posts : [];
      for (const item of items) {
        if (typeof item.caption !== "string") continue;
        const signature = captionSignature(item.caption);
        if (signature) signatures.add(signature);
      }
      return signatures;
    } catch {
      return new Set<string>();
    }
  }

  function resolveScheduledIds(
    nextPosts: EditableYoloPost[],
    signatures: Set<string>,
  ): Set<string> {
    if (!signatures.size) {
      return new Set<string>();
    }

    const ids = new Set<string>();
    for (const post of nextPosts) {
      const signature = captionSignature(postCaptionFromBody(post.body));
      if (signature && signatures.has(signature)) {
        ids.add(post.id);
      }
    }
    return ids;
  }

  async function loadLatestBatch(currentToken: string) {
    setLoading(true);
    setError(null);
    setNotice(null);

    try {
      const [queueResponse, scheduledSignatures] = await Promise.all([
        fetch("/api/social/yolo", {
          headers: jsonHeaders(currentToken),
        }),
        fetchScheduledCaptionSignatures(currentToken),
      ]);

      const data = (await queueResponse.json()) as YoloApiResponse;
      if (!queueResponse.ok) {
        throw new Error(data?.error || "Could not load YOLO queue.");
      }

      const nextPosts = Array.isArray(data.posts)
        ? data.posts.map(toEditablePost)
        : [];
      setPosts(nextPosts);
      setBatchDate(data.batchDate ?? null);
      setGeneratedAt(data.generatedAt ?? null);
      setStale(Boolean(data.stale));
      setSelectedPostIds(new Set());
      setScheduledPostIds(resolveScheduledIds(nextPosts, scheduledSignatures));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load YOLO queue.");
      setPosts([]);
      setBatchDate(null);
      setGeneratedAt(null);
      setStale(false);
      setSelectedPostIds(new Set());
      setScheduledPostIds(new Set());
    } finally {
      setLoading(false);
    }
  }

  async function regenerateBatch() {
    if (!token) return;

    setRegenerating(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch("/api/social/yolo", {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({ force: true }),
      });
      const data = (await response.json()) as YoloApiResponse;
      if (!response.ok) {
        throw new Error(data?.error || "Could not regenerate YOLO queue.");
      }

      const nextPosts = Array.isArray(data.posts)
        ? data.posts.map(toEditablePost)
        : [];
      setPosts(nextPosts);
      setBatchDate(data.batchDate ?? null);
      setGeneratedAt(new Date().toISOString());
      setStale(false);
      setSelectedPostIds(new Set());
      setScheduledPostIds(new Set());
      setNotice(
        nextPosts.length
          ? `Generated ${nextPosts.length} fresh drafts.`
          : "YOLO queue regenerated.",
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not regenerate YOLO queue.",
      );
    } finally {
      setRegenerating(false);
    }
  }

  async function patchYoloPost(postId: string, payload: Record<string, unknown>) {
    if (!token) {
      throw new Error("Missing session. Please sign in again.");
    }

    const response = await fetch(`/api/social/yolo/${postId}`, {
      method: "PATCH",
      headers: jsonHeaders(token),
      body: JSON.stringify(payload),
    });

    const data = (await response.json()) as YoloPatchResponse;
    if (!response.ok) {
      throw new Error(data?.error || "Could not update post.");
    }

    return data.post;
  }

  function openEditorModal(post: EditableYoloPost) {
    setEditorPostId(post.id);
    setEditorPlatform(post.platform);
    setEditorBody(post.body);
    setEditorStatus(mapPersistedStatusToReview(post.status));
    setEditorError(null);
    setEditorOpen(true);
  }

  function resetEditorState() {
    setEditorOpen(false);
    setEditorPostId(null);
    setEditorPlatform("");
    setEditorBody("");
    setEditorStatus("draft");
    setEditorError(null);
  }

  async function handleSaveEditor() {
    if (!editorPostId) {
      setEditorError("Pick a post before saving.");
      return;
    }

    const normalizedBody = postCaptionFromBody(editorBody);
    if (!normalizedBody) {
      setEditorError("Post content cannot be empty.");
      return;
    }

    const source = posts.find((post) => post.id === editorPostId);
    const persistedStatus = mapReviewStatusToPersisted(editorStatus);
    const platform = editorPlatform.trim() || source?.platform || "Social";

    setEditorSaving(true);
    setEditorError(null);
    setError(null);
    setNotice(null);

    try {
      const payload = {
        theme: deriveThemeFromBody(normalizedBody, source?.theme ?? "Social post idea"),
        platform,
        hook: "",
        content: normalizedBody,
        cta: "",
        hashtags: [],
        status: persistedStatus,
      };

      const updated = await patchYoloPost(editorPostId, payload);
      if (updated) {
        setPosts((prev) =>
          prev.map((entry) =>
            entry.id === editorPostId ? toEditablePost(updated) : entry,
          ),
        );
      }
      setNotice("Post updated.");
      resetEditorState();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : "Could not save post.");
    } finally {
      setEditorSaving(false);
    }
  }

  function copyPost(post: EditableYoloPost) {
    const payload = normalizeMultiline(post.body);
    navigator.clipboard
      .writeText(payload)
      .then(() => {
        setCopiedId(post.id);
        setTimeout(() => setCopiedId(null), 1200);
      })
      .catch(() => setError("Could not copy this draft right now."));
  }

  function togglePostSelection(postId: string, checked: boolean) {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(postId);
      } else {
        next.delete(postId);
      }
      return next;
    });
  }

  const filteredPosts = useMemo(() => {
    return posts.filter((post) => {
      const laneMatch = laneFilter === "all" || post.lane === laneFilter;
      const derivedStatus = toReviewStatus(post, scheduledPostIds);
      const statusMatch = statusFilter === "all" || derivedStatus === statusFilter;
      return laneMatch && statusMatch;
    });
  }, [posts, laneFilter, statusFilter, scheduledPostIds]);

  const counts = useMemo(() => {
    const scheduled = posts.filter((post) => scheduledPostIds.has(post.id)).length;
    const reviewed = posts.filter(
      (post) => post.status === "selected" && !scheduledPostIds.has(post.id),
    ).length;
    const discarded = posts.filter((post) => post.status === "discarded").length;
    return {
      total: posts.length,
      reviewed,
      scheduled,
      discarded,
    };
  }, [posts, scheduledPostIds]);

  const selectedCount = selectedPostIds.size;
  const allFilteredSelected =
    filteredPosts.length > 0 && filteredPosts.every((post) => selectedPostIds.has(post.id));

  function toggleSelectAllFiltered() {
    setSelectedPostIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const post of filteredPosts) {
          next.delete(post.id);
        }
      } else {
        for (const post of filteredPosts) {
          next.add(post.id);
        }
      }
      return next;
    });
  }

  async function loadScheduleAccounts() {
    if (!token) {
      setScheduleError("Missing session. Please sign in again.");
      return;
    }

    try {
      setScheduleLoadingAccounts(true);
      setScheduleError(null);

      const response = await fetch("/api/social/accounts", {
        method: "GET",
        headers: jsonHeaders(token),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || "Could not fetch social accounts.");
      }

      const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
      const normalized: SocialAccount[] = accounts
        .map((entry: unknown) => {
          if (!entry || typeof entry !== "object") return null;
          const record = entry as Record<string, unknown>;

          const id = Number(record.id);
          if (!Number.isInteger(id) || id <= 0) return null;

          const platform =
            typeof record.platform === "string" && record.platform.trim().length > 0
              ? record.platform.trim()
              : "unknown";
          const username =
            typeof record.username === "string" && record.username.trim().length > 0
              ? record.username.trim()
              : `account-${id}`;

          return { id, platform, username } as SocialAccount;
        })
        .filter((entry: SocialAccount | null): entry is SocialAccount => Boolean(entry));

      setScheduleAccounts(normalized);
      setSelectedAccountIds((prev) => {
        if (normalized.length === 1) return [normalized[0].id];
        if (!prev.length) return [];
        const allowed = new Set<number>(normalized.map((account) => account.id));
        return prev.filter((id) => allowed.has(id));
      });
    } catch (err) {
      setScheduleError(
        err instanceof Error
          ? err.message
          : "Could not load social accounts right now.",
      );
    } finally {
      setScheduleLoadingAccounts(false);
    }
  }

  function openScheduleModal(postIds: string[]) {
    if (!postIds.length) return;
    setScheduleTargetIds(postIds);
    setScheduleError(null);
    setScheduleOpen(true);
    void loadScheduleAccounts();
  }

  function toggleAccountSelection(accountId: number) {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId)
        ? prev.filter((id) => id !== accountId)
        : [...prev, accountId],
    );
  }

  async function handleScheduleTargets() {
    if (!token) {
      setScheduleError("Missing session. Please sign in again.");
      return;
    }
    if (!scheduleTargetIds.length) {
      setScheduleError("Select at least one post to schedule.");
      return;
    }
    if (!selectedAccountIds.length) {
      setScheduleError("Select at least one social account.");
      return;
    }

    const scheduledAt = scheduleDateToIso(scheduleDate, scheduleTime);
    if (!scheduledAt) {
      setScheduleError("Provide a valid date and time.");
      return;
    }

    const targets = posts.filter((post) => scheduleTargetIds.includes(post.id));
    if (!targets.length) {
      setScheduleError("Could not find selected posts.");
      return;
    }

    try {
      setScheduleSubmitting(true);
      setScheduleError(null);
      setError(null);
      setNotice(null);

      const successIds: string[] = [];
      const failedTitles: string[] = [];

      for (const post of targets) {
        const caption = postCaptionFromBody(post.body);
        if (!caption) {
          failedTitles.push(`#${post.position}`);
          continue;
        }

        const response = await fetch("/api/social/schedule", {
          method: "POST",
          headers: jsonHeaders(token),
          body: JSON.stringify({
            caption,
            scheduledAt,
            socialAccountIds: selectedAccountIds,
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          failedTitles.push(`#${post.position}`);
          continue;
        }

        void patchYoloPost(post.id, { status: "selected" }).catch(() => {
          return undefined;
        });
        successIds.push(post.id);
      }

      if (successIds.length) {
        setScheduledPostIds((prev) => {
          const next = new Set(prev);
          for (const id of successIds) {
            next.add(id);
          }
          return next;
        });
        setPosts((prev) =>
          prev.map((post) =>
            successIds.includes(post.id)
              ? { ...post, status: "selected" as const }
              : post,
          ),
        );
        setSelectedPostIds((prev) => {
          const next = new Set(prev);
          for (const id of successIds) {
            next.delete(id);
          }
          return next;
        });
      }

      const readableDate = new Date(scheduledAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      });

      if (!failedTitles.length) {
        setNotice(
          `${successIds.length} post${successIds.length === 1 ? "" : "s"} scheduled for ${readableDate}.`,
        );
        setScheduleOpen(false);
        return;
      }

      if (successIds.length) {
        setNotice(
          `${successIds.length} post${successIds.length === 1 ? "" : "s"} scheduled for ${readableDate}.`,
        );
      }
      setScheduleError(
        `Failed to schedule ${failedTitles.length} post${failedTitles.length === 1 ? "" : "s"} (${failedTitles.join(", ")}).`,
      );
    } catch (err) {
      setScheduleError(
        err instanceof Error ? err.message : "Could not schedule posts right now.",
      );
    } finally {
      setScheduleSubmitting(false);
    }
  }

  const scheduleTargetPosts = useMemo(() => {
    if (!scheduleTargetIds.length) return [];
    return posts.filter((post) => scheduleTargetIds.includes(post.id));
  }, [scheduleTargetIds, posts]);

  const editorPost = useMemo(() => {
    if (!editorPostId) return null;
    return posts.find((post) => post.id === editorPostId) ?? null;
  }, [editorPostId, posts]);

  return (
    <div className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
        <header className="space-y-3">
          <Badge
            variant="outline"
            className="w-fit border-white/15 bg-white/[0.03] text-neutral-300"
          >
            YOLO Social Queue
          </Badge>
          <h1 className="text-balance text-3xl font-semibold text-white">
            Edit first, schedule when ready
          </h1>
          <p className="text-pretty text-sm text-neutral-400">
            Daily ideas come from recent blog posts and changelog updates. Review
            the draft, save your edits, then schedule one or many posts.
          </p>
          <p className="text-xs text-neutral-500">
            Workflow: Draft {"->"} Reviewed {"->"} Scheduled {"->"} Published
          </p>
        </header>

        <Card className="border-white/10 bg-neutral-900/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg text-white">Batch metadata</CardTitle>
              <CardDescription className="text-neutral-400">
                {batchDate ? `Batch date: ${batchDate}` : "No generated batch yet."}
                {generatedAt
                  ? ` · Generated at ${new Date(generatedAt).toLocaleString("en-US")}`
                  : ""}
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                onClick={() => token && void loadLatestBatch(token)}
                disabled={loading || regenerating || !token}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Reload
              </Button>
              <Button
                type="button"
                className="bg-violet-600 text-white hover:bg-violet-500"
                onClick={() => void regenerateBatch()}
                disabled={loading || regenerating || !token}
              >
                {regenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Regenerating
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-2 h-4 w-4" />
                    Regenerate now
                  </>
                )}
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-xs text-neutral-500">Total drafts</p>
                <p className="text-xl font-semibold tabular-nums text-white">
                  {counts.total}
                </p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-xs text-neutral-500">Reviewed</p>
                <p className="text-xl font-semibold tabular-nums text-emerald-300">
                  {counts.reviewed}
                </p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-xs text-neutral-500">Scheduled</p>
                <p className="text-xl font-semibold tabular-nums text-sky-300">
                  {counts.scheduled}
                </p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
                <p className="text-xs text-neutral-500">Discarded</p>
                <p className="text-xl font-semibold tabular-nums text-red-300">
                  {counts.discarded}
                </p>
              </div>
            </div>

            {stale ? (
              <p className="rounded-md border border-yellow-400/30 bg-yellow-500/10 px-3 py-2 text-sm text-yellow-200">
                This batch is from a previous day. Regenerate to refresh themes.
              </p>
            ) : null}

            {error ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </p>
            ) : null}
            {notice ? (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-300">
                {notice}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-neutral-900/70">
          <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg text-white">Filters</CardTitle>
              <CardDescription className="text-neutral-400">
                Narrow by lane and workflow status before editing or scheduling.
              </CardDescription>
            </div>
            <div className="grid w-full gap-2 sm:w-auto sm:grid-cols-2">
              <Select
                value={laneFilter}
                onValueChange={(value) => setLaneFilter(value as LaneFilter)}
              >
                <SelectTrigger className="border-white/15 bg-neutral-950 text-neutral-100">
                  <SelectValue placeholder="Lane" />
                </SelectTrigger>
                <SelectContent className="border-white/15 bg-neutral-900 text-neutral-100">
                  <SelectItem value="all">All lanes</SelectItem>
                  <SelectItem value="blog">Blog</SelectItem>
                  <SelectItem value="changelog">Changelog</SelectItem>
                  <SelectItem value="mixed">Mixed</SelectItem>
                </SelectContent>
              </Select>

              <Select
                value={statusFilter}
                onValueChange={(value) => setStatusFilter(value as StatusFilter)}
              >
                <SelectTrigger className="border-white/15 bg-neutral-950 text-neutral-100">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent className="border-white/15 bg-neutral-900 text-neutral-100">
                  <SelectItem value="all">All status</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="reviewed">Reviewed</SelectItem>
                  <SelectItem value="scheduled">Scheduled</SelectItem>
                  <SelectItem value="discarded">Discarded</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                onClick={toggleSelectAllFiltered}
                disabled={!filteredPosts.length}
              >
                {allFilteredSelected ? "Unselect filtered" : "Select filtered"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                onClick={() => setSelectedPostIds(new Set())}
                disabled={!selectedCount}
              >
                Clear selection
              </Button>
              <Button
                type="button"
                className="bg-sky-600 text-white hover:bg-sky-500"
                onClick={() => openScheduleModal(Array.from(selectedPostIds))}
                disabled={!selectedCount}
              >
                <CalendarPlus className="mr-2 h-4 w-4" />
                Schedule selected ({selectedCount})
              </Button>
            </div>
          </CardContent>
        </Card>

        {loading ? (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <Card key={index} className="border-white/10 bg-neutral-900/70">
                <CardHeader className="space-y-2">
                  <Skeleton className="h-4 w-24 bg-white/10" />
                  <Skeleton className="h-5 w-full bg-white/10" />
                </CardHeader>
                <CardContent className="space-y-3">
                  <Skeleton className="h-8 w-full bg-white/10" />
                  <Skeleton className="h-24 w-full bg-white/10" />
                  <Skeleton className="h-8 w-full bg-white/10" />
                </CardContent>
              </Card>
            ))}
          </div>
        ) : filteredPosts.length === 0 ? (
          <Card className="border-dashed border-white/20 bg-neutral-900/40">
            <CardContent className="space-y-3 py-10 text-center">
              <p className="text-sm text-neutral-300">
                No drafts match the current filters.
              </p>
              <Button
                type="button"
                onClick={() => void regenerateBatch()}
                className="bg-violet-600 text-white hover:bg-violet-500"
                disabled={regenerating || !token}
              >
                {regenerating ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Regenerating
                  </>
                ) : (
                  "Generate new drafts"
                )}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {filteredPosts.map((post) => {
              const derivedStatus = toReviewStatus(post, scheduledPostIds);
              const isSelected = selectedPostIds.has(post.id);
              const isScheduled = scheduledPostIds.has(post.id);

              return (
                <Card key={post.id} className="border-white/10 bg-neutral-900/70">
                  <CardHeader className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            togglePostSelection(post.id, Boolean(checked))
                          }
                          aria-label={`Select post #${post.position}`}
                        />
                        <Badge
                          variant="outline"
                          className="border-white/20 bg-white/[0.03] text-neutral-300"
                        >
                          #{post.position} · {post.lane}
                        </Badge>
                      </div>
                      <Badge
                        variant="outline"
                        className={statusBadgeClass(derivedStatus)}
                      >
                        {statusLabel(derivedStatus)}
                      </Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="rounded-md border border-white/10 bg-neutral-950 p-3">
                      <p className="mb-2 text-xs uppercase text-neutral-500">
                        {post.platform}
                      </p>
                      <p className="max-h-52 overflow-y-auto whitespace-pre-wrap text-sm text-neutral-200">
                        {post.body}
                      </p>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                        onClick={() => copyPost(post)}
                      >
                        <Clipboard className="mr-2 h-4 w-4" />
                        {copiedId === post.id ? "Copied" : "Copy"}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                        onClick={() => openScheduleModal([post.id])}
                      >
                        <CalendarPlus className="mr-2 h-4 w-4" />
                        {isScheduled ? "Reschedule" : "Schedule"}
                      </Button>
                      <Button
                        type="button"
                        className="bg-violet-600 text-white hover:bg-violet-500"
                        onClick={() => openEditorModal(post)}
                      >
                        <Save className="mr-2 h-4 w-4" />
                        Edit
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (!open) {
            resetEditorState();
            return;
          }
          setEditorOpen(true);
        }}
      >
        <DialogContent className="border-white/10 bg-neutral-900 text-neutral-100">
          <DialogHeader>
            <DialogTitle>Edit post</DialogTitle>
            <DialogDescription className="text-neutral-400">
              {editorPost
                ? `Editing #${editorPost.position} from ${editorPost.lane}.`
                : "Adjust text, platform, and review status before scheduling."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs uppercase text-neutral-500">Platform</label>
                <Input
                  value={editorPlatform}
                  onChange={(event) => setEditorPlatform(event.target.value)}
                  className="border-white/10 bg-neutral-950 text-neutral-100"
                  placeholder="Platform"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs uppercase text-neutral-500">Status</label>
                <Select
                  value={editorStatus}
                  onValueChange={(value) =>
                    setEditorStatus(
                      value === "reviewed" || value === "discarded"
                        ? value
                        : "draft",
                    )
                  }
                >
                  <SelectTrigger className="border-white/10 bg-neutral-950 text-neutral-100">
                    <SelectValue placeholder="Status" />
                  </SelectTrigger>
                  <SelectContent className="border-white/15 bg-neutral-900 text-neutral-100">
                    <SelectItem value="draft">Draft</SelectItem>
                    <SelectItem value="reviewed">Reviewed</SelectItem>
                    <SelectItem value="discarded">Discarded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-xs uppercase text-neutral-500">Content</label>
              <Textarea
                value={editorBody}
                onChange={(event) => setEditorBody(event.target.value)}
                placeholder="Post content"
                rows={14}
                className="resize-none border-white/10 bg-neutral-950 text-neutral-100"
              />
            </div>

            {editorError ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {editorError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
              onClick={resetEditorState}
              disabled={editorSaving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-violet-600 text-white hover:bg-violet-500"
              onClick={() => void handleSaveEditor()}
              disabled={editorSaving}
            >
              {editorSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving
                </>
              ) : (
                <>
                  <Save className="mr-2 h-4 w-4" />
                  Save changes
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="border-white/10 bg-neutral-900 text-neutral-100">
          <DialogHeader>
            <DialogTitle>Schedule posts</DialogTitle>
            <DialogDescription className="text-neutral-400">
              Choose date/time and social accounts for{" "}
              {scheduleTargetPosts.length} post
              {scheduleTargetPosts.length === 1 ? "" : "s"}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-xs uppercase text-neutral-500">Date</label>
                <Input
                  type="date"
                  value={scheduleDate}
                  onChange={(event) => setScheduleDate(event.target.value)}
                  className="border-white/10 bg-neutral-950 text-neutral-100"
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs uppercase text-neutral-500">Time</label>
                <Input
                  type="time"
                  value={scheduleTime}
                  onChange={(event) => setScheduleTime(event.target.value)}
                  className="border-white/10 bg-neutral-950 text-neutral-100"
                />
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs uppercase text-neutral-500">Social accounts</p>
              {scheduleLoadingAccounts ? (
                <div className="rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-300">
                  Loading accounts...
                </div>
              ) : scheduleAccounts.length === 0 ? (
                <div className="rounded-md border border-white/10 bg-neutral-950 px-3 py-2 text-sm text-neutral-300">
                  No Post-Bridge accounts found.
                </div>
              ) : (
                <div className="space-y-2 rounded-md border border-white/10 bg-neutral-950 p-3">
                  {scheduleAccounts.map((account) => {
                    const checked = selectedAccountIds.includes(account.id);
                    return (
                      <label
                        key={account.id}
                        className="flex items-center gap-2 text-sm text-neutral-200"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleAccountSelection(account.id)}
                          aria-label={`Select ${formatAccountLabel(account)}`}
                        />
                        <span>{formatAccountLabel(account)}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            {scheduleTargetPosts.length > 0 ? (
              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">Selected posts</p>
                <div className="max-h-36 space-y-2 overflow-y-auto rounded-md border border-white/10 bg-neutral-950 p-3">
                  {scheduleTargetPosts.map((post) => (
                    <p key={post.id} className="text-sm text-neutral-300">
                      #{post.position} · {post.theme}
                    </p>
                  ))}
                </div>
              </div>
            ) : null}

            {scheduleError ? (
              <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {scheduleError}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
              onClick={() => setScheduleOpen(false)}
              disabled={scheduleSubmitting}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="bg-sky-600 text-white hover:bg-sky-500"
              onClick={() => void handleScheduleTargets()}
              disabled={scheduleSubmitting || !scheduleTargetPosts.length}
            >
              {scheduleSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Scheduling
                </>
              ) : (
                <>
                  <CalendarPlus className="mr-2 h-4 w-4" />
                  Schedule now
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
