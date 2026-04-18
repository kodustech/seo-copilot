"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CalendarPlus,
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Clipboard,
  Flame,
  GraduationCap,
  Loader2,
  RefreshCw,
  Rocket,
  Search,
  Sparkles,
  Wand2,
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
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { copyToClipboard as copyTextToClipboard } from "@/lib/clipboard";
import { DEFAULT_SOCIAL_VARIATION_STRATEGY } from "@/lib/social-writing-style";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";

type PostIdea = {
  id: string;
  variant: string;
  hook: string;
  content: string;
  platform: string;
};

type PlatformConfigForm = {
  id: string;
  platform: string;
  maxLength: string;
  linksPolicy: string;
  numVariations: number;
};

type FeedPost = {
  id: string;
  title: string;
  link: string;
  excerpt: string;
  content: string;
  publishedAt?: string;
};

type FeedSource = "blog" | "changelog";
type SocialGenerationMode =
  | "content_marketing"
  | "build_in_public"
  | "adversarial";
type SocialStyle = "default" | "build_in_public" | "adversarial";

const STYLE_TO_MODE: Record<SocialStyle, SocialGenerationMode> = {
  default: "content_marketing",
  build_in_public: "build_in_public",
  adversarial: "adversarial",
};

const STYLE_OPTIONS: {
  value: SocialStyle;
  label: string;
  hint: string;
  icon: typeof Sparkles;
}[] = [
  {
    value: "default",
    label: "Default",
    hint: "Teach a lesson from the content (P.A.T)",
    icon: GraduationCap,
  },
  {
    value: "build_in_public",
    label: "Build in public",
    hint: "Ship-update: what changed, why, what we learned",
    icon: Rocket,
  },
  {
    value: "adversarial",
    label: "Adversarial",
    hint: "Push back against a common belief (uses your worldview)",
    icon: Flame,
  },
];

type SocialAccount = {
  id: number;
  platform: string;
  username: string;
};

type VoiceMode = "auto" | "global" | "user" | "custom";

const platformOptions = [
  { label: "LinkedIn", value: "LinkedIn" },
  { label: "Instagram", value: "Instagram" },
  { label: "Twitter / X", value: "Twitter" },
];

const voiceModeOptions: { label: string; value: VoiceMode; helper: string }[] = [
  {
    label: "Auto (Company + Mine)",
    value: "auto",
    helper: "Uses merged policy: Kodus global + your profile.",
  },
  {
    label: "Company Voice",
    value: "global",
    helper: "Uses only the Kodus global policy.",
  },
  {
    label: "My Voice",
    value: "user",
    helper: "Uses only your personal profile.",
  },
  {
    label: "Custom Tone",
    value: "custom",
    helper: "Overrides tone just for this generation.",
  },
];

function createConfigId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function createPlatformConfig(
  overrides: Partial<Omit<PlatformConfigForm, "id">> & { id?: string } = {},
): PlatformConfigForm {
  return {
    id: overrides.id ?? createConfigId(),
    platform: overrides.platform ?? "LinkedIn",
    maxLength: overrides.maxLength ?? "900",
    linksPolicy:
      overrides.linksPolicy ?? "No in-body links; encourage comments",
    numVariations: overrides.numVariations ?? 3,
  };
}

function getDefaultPlatformConfigs() {
  return [
    createPlatformConfig({
      platform: "LinkedIn",
      maxLength: "900",
      linksPolicy: "No links; ask for comments",
    }),
    createPlatformConfig({
      platform: "Twitter",
      maxLength: "500",
      linksPolicy: "Sem link",
    }),
  ];
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

function normalizeMultilineForCopy(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

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
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function SocialGenerator() {
  const token = useAuthToken();
  const [baseContent, setBaseContent] = useState("");
  const [instructions, setInstructions] = useState("");
  const [voiceMode, setVoiceMode] = useState<VoiceMode>("auto");
  const [customTone, setCustomTone] = useState(
    "Personal, direct, technical, candid, slightly opinionated",
  );
  const [variationStrategy, setVariationStrategy] = useState(
    DEFAULT_SOCIAL_VARIATION_STRATEGY,
  );
  const [language, setLanguage] = useState("pt-BR");
  const [platformConfigs, setPlatformConfigs] = useState<PlatformConfigForm[]>(
    () => getDefaultPlatformConfigs()
  );
  const [posts, setPosts] = useState<PostIdea[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [scheduledIds, setScheduledIds] = useState<Set<string>>(new Set());
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [feedSource, setFeedSource] = useState<FeedSource>("blog");
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [selectedFeedId, setSelectedFeedId] = useState("");
  const [feedComboOpen, setFeedComboOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseSearch, setBrowseSearch] = useState("");
  const [browseSource, setBrowseSource] = useState<FeedSource>("blog");
  const [style, setStyle] = useState<SocialStyle>("default");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [hasWorldview, setHasWorldview] = useState<boolean | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleTarget, setScheduleTarget] = useState<PostIdea | null>(null);
  const [scheduleDate, setScheduleDate] = useState(getDefaultScheduleDate);
  const [scheduleTime, setScheduleTime] = useState("09:00");
  const [scheduleAccounts, setScheduleAccounts] = useState<SocialAccount[]>([]);
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [scheduleLoadingAccounts, setScheduleLoadingAccounts] = useState(false);
  const [scheduleSubmitting, setScheduleSubmitting] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleNotice, setScheduleNotice] = useState<string | null>(null);

  const hasValidPlatform = platformConfigs.some(
    (config) => config.platform.trim().length > 0
  );
  const canGenerate = baseContent.trim().length > 12 && hasValidPlatform && !loading;

  // Browse modal: filtered posts
  const browsePosts = useMemo(() => {
    if (!browseSearch.trim()) return feedPosts;
    const q = browseSearch.toLowerCase();
    return feedPosts.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        (p.excerpt && p.excerpt.toLowerCase().includes(q)),
    );
  }, [feedPosts, browseSearch]);

  const handleOpenBrowse = useCallback(() => {
    setBrowseSearch("");
    setBrowseSource(feedSource);
    setBrowseOpen(true);
  }, [feedSource]);

  const handleSelectFromBrowse = useCallback(
    (postId: string) => {
      handleSelectFeedPost(postId);
      setBrowseOpen(false);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [feedPosts],
  );

  useEffect(() => {
    setSelectedFeedId("");
    void reloadFeed(feedSource);
  }, [feedSource]);

  // Auto-suggest style from feed source (user can override)
  useEffect(() => {
    if (feedSource === "changelog") {
      setStyle((prev) => (prev === "default" ? "build_in_public" : prev));
    }
  }, [feedSource]);

  // Fetch worldview status once we have a token, so we can warn if adversarial
  // is picked without a worldview configured.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch("/api/voice/me", { headers: jsonHeaders(token) })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const worldview =
          typeof data?.profile?.worldview === "string"
            ? data.profile.worldview.trim()
            : "";
        const globalWorldview =
          typeof data?.globalProfile?.worldview === "string"
            ? data.globalProfile.worldview.trim()
            : "";
        setHasWorldview(Boolean(worldview || globalWorldview));
      })
      .catch(() => {
        if (!cancelled) setHasWorldview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  // When browse source changes inside modal, sync it
  function handleBrowseSourceChange(source: FeedSource) {
    setBrowseSource(source);
    setFeedSource(source);
    setBrowseSearch("");
  }

  async function handleGeneratePosts() {
    if (!canGenerate) {
      setError("Add at least one base idea to generate a post.");
      return;
    }
    setError(null);
    setLoading(true);

    try {
      const formattedPlatforms = platformConfigs
        .map((config) => {
          const parsedMaxLength = Number(config.maxLength);
          return {
            platform: config.platform.trim(),
            maxLength: Number.isFinite(parsedMaxLength) ? parsedMaxLength : undefined,
            linksPolicy: config.linksPolicy.trim(),
            numVariations: config.numVariations,
          };
        })
        .filter((config) => config.platform.length > 0);

      if (!formattedPlatforms.length) {
        throw new Error("Add at least one platform configuration.");
      }

      const userInstructions = instructions.trim();

      const response = await fetch("/api/content", {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          baseContent,
          language,
          voiceMode,
          tone: voiceMode === "custom" ? customTone : undefined,
          variationStrategy,
          platformConfigs: formattedPlatforms,
          instructions: userInstructions || undefined,
          contentSource: feedSource,
          generationMode: STYLE_TO_MODE[style],
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "We couldn't generate posts right now.");
      }
      const variations =
        (Array.isArray(data?.posts) ? data.posts : Array.isArray(data) ? data : []) ??
        [];

      if (!variations.length) {
        throw new Error("The copilot did not return variations.");
      }

      type SocialVariation = {
        variant?: number | string;
        hook?: string;
        post?: string;
        cta?: string;
        hashtags?: unknown[];
        platform?: string;
      };

      const timestamp = Date.now();
      setPosts(
        variations.map((item: SocialVariation, index: number) => {
          const variantLabel =
            typeof item.variant === "number" && Number.isFinite(item.variant)
              ? String(item.variant)
              : item.variant
                ? String(item.variant)
                : String(index + 1);
          const resolvedPlatform =
            (typeof item.platform === "string" && item.platform.trim().length > 0
              ? item.platform.trim()
              : platformConfigs[index % platformConfigs.length]?.platform) ?? "Social";
          return {
            id: `${timestamp}-${index}`,
            variant: variantLabel,
            hook: item.hook || "",
            content: item.post || "",
            platform: resolvedPlatform,
          };
        })
      );
      setCopiedId(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unexpected error while generating posts."
      );
    } finally {
      setLoading(false);
    }
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
            typeof record.platform === "string" &&
            record.platform.trim().length > 0
              ? record.platform.trim()
              : "unknown";
          const username =
            typeof record.username === "string" &&
            record.username.trim().length > 0
              ? record.username.trim()
              : `account-${id}`;

          return { id, platform, username } as SocialAccount;
        })
        .filter((entry: SocialAccount | null): entry is SocialAccount =>
          Boolean(entry),
        );

      setScheduleAccounts(normalized);
      setSelectedAccountIds((prev) => {
        if (normalized.length === 1) return [normalized[0].id];
        if (!prev.length) return [];
        const allowed = new Set<number>(
          normalized.map((account: SocialAccount) => account.id),
        );
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

  function openScheduleModal(post: PostIdea) {
    setScheduleTarget(post);
    setScheduleOpen(true);
    setScheduleNotice(null);
    setScheduleError(null);
    void loadScheduleAccounts();
  }

  function toggleAccountSelection(accountId: number) {
    setSelectedAccountIds((prev) =>
      prev.includes(accountId)
        ? prev.filter((id) => id !== accountId)
        : [...prev, accountId],
    );
  }

  async function handleSchedulePost() {
    if (!scheduleTarget) {
      setScheduleError("Select a post variation first.");
      return;
    }
    if (!token) {
      setScheduleError("Missing session. Please sign in again.");
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

    try {
      setScheduleSubmitting(true);
      setScheduleError(null);
      setScheduleNotice(null);

      const response = await fetch("/api/social/schedule", {
        method: "POST",
        headers: jsonHeaders(token),
        body: JSON.stringify({
          caption: formatPostForCopy(scheduleTarget),
          scheduledAt,
          socialAccountIds: selectedAccountIds,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Could not schedule this post.");
      }

      setScheduledIds((prev) => new Set(prev).add(scheduleTarget.id));
      const readableDate = new Date(scheduledAt).toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      });
      setScheduleNotice(`Post scheduled for ${readableDate}.`);
      setScheduleOpen(false);
    } catch (err) {
      setScheduleError(
        err instanceof Error ? err.message : "Unexpected error while scheduling.",
      );
    } finally {
      setScheduleSubmitting(false);
    }
  }

  function formatPostForCopy(post: PostIdea) {
    const sections: string[] = [];
    const hook = normalizeMultilineForCopy(post.hook);
    if (hook.trim()) {
      sections.push(hook);
    }
    const content = normalizeMultilineForCopy(post.content);
    if (content.trim()) {
      sections.push(content);
    }
    return sections.join("\n\n");
  }

  async function handleCopyPost(id: string, content: string) {
    try {
      await copyTextToClipboard(content);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      setError("Could not copy the text right now.");
    }
  }

  function handleConfigChange(
    id: string,
    updates: Partial<Omit<PlatformConfigForm, "id">>
  ) {
    setPlatformConfigs((prev) =>
      prev.map((config) =>
        config.id === id
          ? {
              ...config,
              ...updates,
            }
          : config
      )
    );
  }

  function handleAddPlatform() {
    setPlatformConfigs((prev) => [...prev, createPlatformConfig()]);
  }

  function handleRemovePlatform(id: string) {
    setPlatformConfigs((prev) =>
      prev.length > 1 ? prev.filter((config) => config.id !== id) : prev
    );
  }

  async function reloadFeed(source: FeedSource = feedSource) {
    try {
      setFeedLoading(true);
      setFeedError(null);
      const response = await fetch(`/api/feed?source=${source}`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Error fetching source posts.");
      }
      const posts = Array.isArray(data?.posts) ? data.posts : [];
      setFeedPosts(posts);
    } catch (err) {
      setFeedError(
        err instanceof Error ? err.message : "Could not fetch the feed right now."
      );
    } finally {
      setFeedLoading(false);
    }
  }

  function handleSelectFeedPost(postId: string) {
    setSelectedFeedId(postId);
    const match = feedPosts.find((post) => post.id === postId);
    if (!match) {
      return;
    }
    const composed = [
      match.title,
      match.content || match.excerpt,
      match.link ? `Reference: ${match.link}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    setBaseContent(composed);
  }

  const hasPosts = useMemo(() => posts.length > 0, [posts]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-neutral-50 to-white px-4 py-10 text-neutral-900 dark:from-neutral-950 dark:to-neutral-900 sm:px-8">
      <div className="mx-auto flex max-w-5xl flex-col gap-8">
        <header className="space-y-4">
          <div className="flex items-center gap-3">
            <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">
              Social Media
            </Badge>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              Base + instructions {"->"} ready posts
            </p>
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-neutral-900 dark:text-white">
              Quick social post generator
            </h1>
            <p className="mt-2 max-w-3xl text-base text-neutral-600 dark:text-neutral-300">
              Paste base content, add instructions or preferred tone, and
              get ready-to-use suggestions for LinkedIn, Instagram, and X.
            </p>
          </div>
        </header>

        <Card className="border-0 bg-white/80 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="flex-row items-start justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">Quick brief</CardTitle>
              <CardDescription className="text-base">
                Base content, tone, platform rules, and number of variations
                quer.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <p className="text-xs uppercase text-neutral-500">
                Content base
              </p>
              <Textarea
                value={baseContent}
                onChange={(event) => setBaseContent(event.target.value)}
                placeholder="Paste an article excerpt, brief, or core idea..."
                className="min-h-[160px] resize-none bg-neutral-50/70 text-base dark:bg-neutral-800"
              />
              <div className="grid gap-2 md:grid-cols-[minmax(200px,240px)_minmax(0,1fr)_auto_auto]">
                <div className="min-w-0">
                  <Select
                    value={feedSource}
                    onValueChange={(value) => setFeedSource(value as FeedSource)}
                    disabled={feedLoading}
                  >
                    <SelectTrigger className="w-full min-w-0 bg-neutral-50/70 text-sm dark:bg-neutral-800 [&>span]:truncate">
                      <SelectValue placeholder="Source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="blog">Blog posts</SelectItem>
                      <SelectItem value="changelog">
                        Changelog (build in public)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="min-w-0">
                  <Popover open={feedComboOpen} onOpenChange={setFeedComboOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={feedComboOpen}
                        disabled={feedLoading || feedPosts.length === 0}
                        className="w-full min-w-0 justify-between bg-neutral-50/70 text-sm font-normal dark:bg-neutral-800 dark:border-neutral-700"
                      >
                        <span className="truncate">
                          {selectedFeedId
                            ? feedPosts.find((p) => p.id === selectedFeedId)?.title ?? "Select..."
                            : feedSource === "changelog"
                              ? "Search changelog updates..."
                              : "Search blog posts..."}
                        </span>
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
                      <Command>
                        <CommandInput
                          placeholder={`Search ${feedPosts.length} ${feedSource === "changelog" ? "updates" : "posts"}...`}
                        />
                        <CommandList className="max-h-72">
                          <CommandEmpty>No results found.</CommandEmpty>
                          <CommandGroup>
                            {feedPosts.map((post) => (
                              <CommandItem
                                key={post.id}
                                value={`${post.title} ${post.excerpt ?? ""}`}
                                onSelect={() => {
                                  handleSelectFeedPost(post.id);
                                  setFeedComboOpen(false);
                                }}
                                className="flex flex-col items-start gap-0.5 py-2"
                              >
                                <span className="text-sm font-medium leading-tight">
                                  {post.title}
                                </span>
                                {post.publishedAt && (
                                  <span className="text-[10px] text-neutral-500">
                                    {new Date(post.publishedAt).toLocaleDateString("pt-BR")}
                                  </span>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full text-sm md:w-auto"
                  onClick={() => {
                    setSelectedFeedId("");
                    void reloadFeed(feedSource);
                  }}
                  disabled={feedLoading}
                >
                  {feedLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  <span className="hidden md:inline">Refresh</span>
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full text-sm md:w-auto"
                  onClick={handleOpenBrowse}
                  disabled={feedLoading || feedPosts.length === 0}
                >
                  <Search className="mr-2 h-4 w-4" />
                  Browse
                </Button>
              </div>
              <p className="text-[11px] text-neutral-500">
                Choose a source to pull ideas and prefill your base content.
              </p>
              {feedError && (
                <p className="text-xs text-red-500">{feedError}</p>
              )}
            </div>
            <div className="space-y-3">
              <p className="text-xs uppercase text-neutral-500">Style</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {STYLE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  const active = style === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setStyle(option.value)}
                      className={`flex h-full flex-col items-start gap-1 rounded-2xl border p-3 text-left transition ${
                        active
                          ? "border-violet-400/60 bg-violet-500/10"
                          : "border-neutral-200/70 bg-neutral-50/70 hover:border-neutral-300 dark:border-white/10 dark:bg-neutral-800 dark:hover:border-white/30"
                      }`}
                    >
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Icon className="h-4 w-4" />
                        {option.label}
                      </div>
                      <p className="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">
                        {option.hint}
                      </p>
                    </button>
                  );
                })}
              </div>
              {style === "adversarial" && hasWorldview === false ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-600 dark:text-amber-300">
                  Adversarial works best with a worldview defined. Set one up in{" "}
                  <a
                    href="/settings"
                    className="underline underline-offset-2"
                  >
                    Settings → Voice Policy
                  </a>{" "}
                  so the pushback stays aligned with what you actually believe.
                </div>
              ) : null}
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">Language</p>
                <Select value={language} onValueChange={setLanguage}>
                  <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                    <SelectValue placeholder="Language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pt-BR">Portuguese (pt-BR)</SelectItem>
                    <SelectItem value="en-US">English (en-US)</SelectItem>
                    <SelectItem value="es-ES">Spanish (es-ES)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">
                  Voice source
                </p>
                <Select
                  value={voiceMode}
                  onValueChange={(value) => setVoiceMode(value as VoiceMode)}
                >
                  <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                    <SelectValue placeholder="Select source" />
                  </SelectTrigger>
                  <SelectContent>
                    {voiceModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-neutral-500">
                  {
                    voiceModeOptions.find((option) => option.value === voiceMode)
                      ?.helper
                  }
                </p>
              </div>

              <div className="space-y-2">
                <p className="text-xs uppercase text-neutral-500">
                  Tone override
                </p>
                <Input
                  value={customTone}
                  onChange={(event) => setCustomTone(event.target.value)}
                  placeholder="Ex: Practical and direct"
                  className="bg-neutral-50/70 dark:bg-neutral-800"
                  disabled={voiceMode !== "custom"}
                />
                {voiceMode !== "custom" ? (
                  <p className="text-[11px] text-neutral-500">
                    Enable “Custom Tone” to edit this field.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="rounded-2xl border border-neutral-200/80 dark:border-white/10">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-xs uppercase text-neutral-500"
                onClick={() => setAdvancedOpen((open) => !open)}
              >
                <span>Advanced (optional overrides)</span>
                {advancedOpen ? (
                  <ChevronUp className="h-4 w-4" />
                ) : (
                  <ChevronDown className="h-4 w-4" />
                )}
              </button>
              {advancedOpen ? (
                <div className="grid gap-4 border-t border-neutral-200/80 p-4 md:grid-cols-2 dark:border-white/10">
                  <div className="space-y-2">
                    <p className="text-xs uppercase text-neutral-500">
                      Instructions
                    </p>
                    <Textarea
                      value={instructions}
                      onChange={(event) => setInstructions(event.target.value)}
                      placeholder="Extra guidance for this specific generation. Leave empty to rely on the selected style."
                      className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                    />
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs uppercase text-neutral-500">
                      Variation strategy
                    </p>
                    <Textarea
                      value={variationStrategy}
                      onChange={(event) =>
                        setVariationStrategy(event.target.value)
                      }
                      placeholder="Override how variations should differ."
                      className="min-h-[120px] resize-none bg-neutral-50/70 dark:bg-neutral-800"
                    />
                  </div>
                </div>
              ) : null}
            </div>
            <div className="space-y-4 rounded-2xl border border-neutral-200/80 p-4 dark:border-white/10">
              <div className="flex items-center justify-between">
                <p className="text-xs uppercase text-neutral-500">
                  Plataformas e regras
                </p>
                <Button variant="ghost" size="sm" onClick={handleAddPlatform}>
                  + Adicionar plataforma
                </Button>
              </div>
              <div className="space-y-4">
                {platformConfigs.map((config, index) => (
                  <div
                    key={config.id}
                    className="rounded-2xl border border-neutral-200/80 p-4 dark:border-white/10"
                  >
                    <div className="mb-3 flex items-center justify-between">
                      <p className="text-sm font-medium text-neutral-700 dark:text-neutral-100">
                        {`Plataforma #${index + 1}`}
                      </p>
                      {platformConfigs.length > 1 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRemovePlatform(config.id)}
                          className="text-red-500 hover:text-red-600"
                        >
                          <X className="mr-1 h-4 w-4" />
                          Remover
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Plataforma
                        </p>
                        <Select
                          value={config.platform}
                          onValueChange={(value) =>
                            handleConfigChange(config.id, { platform: value })
                          }
                        >
                          <SelectTrigger className="bg-neutral-50/70 dark:bg-neutral-800">
                            <SelectValue placeholder="Plataforma" />
                          </SelectTrigger>
                          <SelectContent>
                            {platformOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Max length
                        </p>
                        <Input
                          type="number"
                          min={40}
                          max={1000}
                          value={config.maxLength}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              maxLength: event.target.value,
                            })
                          }
                          placeholder="Ex.: 260"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Variations count
                        </p>
                        <Input
                          type="number"
                          min={1}
                          max={6}
                          value={config.numVariations}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            if (!Number.isFinite(next)) return;
                            handleConfigChange(config.id, {
                              numVariations: Math.min(6, Math.max(1, Math.round(next))),
                            });
                          }}
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                      <div className="space-y-2">
                        <p className="text-xs uppercase text-neutral-500">
                          Links
                        </p>
                        <Input
                          value={config.linksPolicy}
                          onChange={(event) =>
                            handleConfigChange(config.id, {
                              linksPolicy: event.target.value,
                            })
                          }
                          placeholder="Ex.: sem links no corpo"
                          className="bg-neutral-50/70 dark:bg-neutral-800"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {error && <p className="text-sm text-red-500">{error}</p>}
            {scheduleNotice ? (
              <p className="text-sm text-emerald-500">{scheduleNotice}</p>
            ) : null}
            <div className="flex flex-wrap gap-3">
              <Button
                className="flex-1 min-w-[240px] justify-center rounded-2xl bg-neutral-900 px-6 py-6 text-base font-medium hover:bg-neutral-800 dark:bg-white dark:text-neutral-900"
                onClick={handleGeneratePosts}
                disabled={!canGenerate}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-3 h-5 w-5 animate-spin" />
                    Gerando posts...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-3 h-5 w-5" />
                    Gerar posts sociais
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                className="rounded-2xl px-6 py-6 text-base font-medium"
                onClick={() => {
                  setBaseContent("");
                  setSelectedFeedId("");
                  setInstructions("");
                  setVoiceMode("auto");
                  setCustomTone("Conversational and direct");
                  setVariationStrategy(
                    "Vary hook and format (carousel/thread/short post) across variations."
                  );
                  setLanguage("pt-BR");
                  setPlatformConfigs(getDefaultPlatformConfigs());
                  setPosts([]);
                  setScheduledIds(new Set());
                  setError(null);
                  setFeedError(null);
                  setScheduleNotice(null);
                }}
                type="button"
              >
                Limpar campos
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="border-0 bg-white/90 shadow-sm ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/5">
          <CardHeader className="flex-row items-center justify-between gap-3">
            <div>
              <CardTitle className="text-2xl">Posts sugeridos</CardTitle>
              <CardDescription className="text-base">
                Copie e ajuste antes de publicar.
              </CardDescription>
            </div>
            <Badge className="rounded-full px-4 py-1 text-sm" variant="outline">
              {hasPosts ? `${posts.length} variations` : "Waiting for brief"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-4">
            {!hasPosts ? (
              <div className="rounded-3xl border border-dashed border-neutral-300/70 p-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
                Generate posts from the brief above to see suggestions
                aqui.
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-3">
                {posts.map((post) => (
                  <div
                    key={post.id}
                    className="flex flex-col gap-3 rounded-2xl border border-neutral-200/80 bg-white/80 p-4 shadow-sm dark:border-white/10 dark:bg-neutral-950/40"
                  >
                    <div className="flex items-center justify-between gap-2 text-xs uppercase tracking-wide text-neutral-500">
                      <div className="flex items-center gap-2">
                        <Wand2 className="h-4 w-4" />
                        <span>
                          {post.platform} • Var #{post.variant}
                        </span>
                      </div>
                      {scheduledIds.has(post.id) ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-500/40 bg-emerald-500/10 text-[10px] text-emerald-400"
                        >
                          Scheduled
                        </Badge>
                      ) : null}
                    </div>
                    {post.hook && (
                      <p className="whitespace-pre-wrap text-sm font-semibold text-neutral-900 dark:text-white">
                        {post.hook}
                      </p>
                    )}
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
                      {post.content}
                    </p>
                    <Separator />
                    <div className="flex items-center gap-2 text-xs text-neutral-500">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full px-3 py-2 text-xs"
                        onClick={() =>
                          handleCopyPost(post.id, formatPostForCopy(post))
                        }
                      >
                        <Clipboard className="mr-2 h-4 w-4" />
                        {copiedId === post.id ? "Copied!" : "Copy"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-full px-3 py-2 text-xs"
                        onClick={() => openScheduleModal(post)}
                      >
                        <CalendarPlus className="mr-2 h-4 w-4" />
                        Schedule
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Dialog
          open={scheduleOpen}
          onOpenChange={(open) => {
            setScheduleOpen(open);
            if (!open) {
              setScheduleError(null);
            }
          }}
        >
          <DialogContent className="border-neutral-800 bg-neutral-950 text-neutral-100 sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Schedule social post</DialogTitle>
              <DialogDescription className="text-neutral-400">
                Pick a publish time and select the social accounts connected in
                Post-Bridge.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs text-neutral-300">
                {scheduleTarget ? (
                  <>
                    <p className="font-medium text-neutral-100">
                      {scheduleTarget.platform} • Var #{scheduleTarget.variant}
                    </p>
                    <p className="mt-1 max-h-24 overflow-hidden whitespace-pre-wrap">
                      {scheduleTarget.content}
                    </p>
                  </>
                ) : (
                  <p>Select a post first.</p>
                )}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    Date
                  </p>
                  <Input
                    type="date"
                    value={scheduleDate}
                    onChange={(event) => setScheduleDate(event.target.value)}
                    className="border-white/10 bg-neutral-900 text-neutral-100"
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    Time
                  </p>
                  <Input
                    type="time"
                    value={scheduleTime}
                    onChange={(event) => setScheduleTime(event.target.value)}
                    className="border-white/10 bg-neutral-900 text-neutral-100"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs uppercase tracking-wide text-neutral-500">
                    Social accounts
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-neutral-300"
                    onClick={() => void loadScheduleAccounts()}
                    disabled={scheduleLoadingAccounts}
                  >
                    {scheduleLoadingAccounts ? (
                      <>
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        Loading
                      </>
                    ) : (
                      <>
                        <RefreshCw className="mr-1 h-3.5 w-3.5" />
                        Refresh
                      </>
                    )}
                  </Button>
                </div>

                {scheduleAccounts.length ? (
                  <div className="grid gap-2">
                    {scheduleAccounts.map((account) => {
                      const selected = selectedAccountIds.includes(account.id);
                      return (
                        <button
                          key={account.id}
                          type="button"
                          onClick={() => toggleAccountSelection(account.id)}
                          className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition ${
                            selected
                              ? "border-violet-400/60 bg-violet-500/20 text-violet-100"
                              : "border-white/10 bg-white/5 text-neutral-200 hover:border-white/30"
                          }`}
                        >
                          <span className="font-medium">{account.platform}</span>
                          <span className="text-xs text-neutral-400">
                            @{account.username}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed border-white/10 bg-white/5 p-3 text-xs text-neutral-400">
                    No social accounts available. Connect them in Post-Bridge and
                    click refresh.
                  </p>
                )}
              </div>

              {scheduleError ? (
                <p className="text-sm text-red-400">{scheduleError}</p>
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
                className="bg-violet-600 text-white hover:bg-violet-500"
                onClick={handleSchedulePost}
                disabled={
                  scheduleSubmitting ||
                  scheduleLoadingAccounts ||
                  !scheduleTarget
                }
              >
                {scheduleSubmitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Scheduling...
                  </>
                ) : (
                  <>
                    <CalendarPlus className="mr-2 h-4 w-4" />
                    Confirm schedule
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Browse posts modal */}
        <Dialog open={browseOpen} onOpenChange={setBrowseOpen}>
          <DialogContent className="border-neutral-800 bg-neutral-950 text-neutral-100 sm:max-w-2xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Browse content</DialogTitle>
              <DialogDescription className="text-neutral-400">
                Search and explore posts to use as base content.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 flex-1 min-h-0 flex flex-col">
              {/* Source tabs */}
              <div className="flex gap-2">
                {(["blog", "changelog"] as const).map((src) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => handleBrowseSourceChange(src)}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                      browseSource === src
                        ? "bg-violet-500/20 text-violet-300"
                        : "bg-white/[0.04] text-neutral-500 hover:text-neutral-300"
                    }`}
                  >
                    {src === "blog" ? "Blog posts" : "Changelog"}
                  </button>
                ))}
                <span className="ml-auto self-center text-[10px] text-neutral-600">
                  {feedPosts.length} items
                </span>
              </div>

              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  type="text"
                  value={browseSearch}
                  onChange={(e) => setBrowseSearch(e.target.value)}
                  placeholder="Search by title or content..."
                  className="w-full rounded-lg border border-white/10 bg-white/5 py-2 pl-10 pr-3 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-violet-500/50 focus:outline-none focus:ring-1 focus:ring-violet-500/30"
                  autoFocus
                />
              </div>

              {/* Results list */}
              <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                {feedLoading ? (
                  <div className="flex items-center justify-center py-12">
                    <Loader2 className="h-5 w-5 animate-spin text-neutral-600" />
                  </div>
                ) : browsePosts.length === 0 ? (
                  <div className="py-12 text-center text-sm text-neutral-500">
                    {browseSearch
                      ? "No posts match your search."
                      : "No posts available."}
                  </div>
                ) : (
                  browsePosts.map((post) => (
                    <button
                      key={post.id}
                      type="button"
                      onClick={() => handleSelectFromBrowse(post.id)}
                      className={`group w-full rounded-lg border px-4 py-3 text-left transition ${
                        selectedFeedId === post.id
                          ? "border-violet-400/60 bg-violet-500/10"
                          : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium leading-snug text-white line-clamp-2">
                            {post.title}
                          </p>
                          {post.excerpt && (
                            <p className="mt-1 text-xs leading-relaxed text-neutral-500 line-clamp-2">
                              {post.excerpt}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {post.publishedAt && (
                            <span className="text-[10px] text-neutral-600">
                              {new Date(post.publishedAt).toLocaleDateString("pt-BR")}
                            </span>
                          )}
                          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-neutral-500 opacity-0 transition group-hover:opacity-100">
                            Select
                          </span>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

