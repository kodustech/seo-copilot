"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus, RefreshCcw } from "lucide-react";

import {
  KANBAN_STAGES,
  type GrowthWorkItem,
  type WorkItemPriority,
  type WorkItemSource,
  type WorkItemStage,
  type WorkItemType,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_SOURCES,
  WORK_ITEM_TYPES,
} from "@/lib/kanban";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

type CreateFormState = {
  title: string;
  description: string;
  itemType: WorkItemType;
  stage: WorkItemStage;
  source: WorkItemSource;
  priority: WorkItemPriority;
  link: string;
  dueAt: string;
};

type BoardResponse = {
  items?: GrowthWorkItem[];
};

type ImportResponse = {
  inserted?: number;
  skipped?: number;
};

type ItemsResponse = {
  item?: GrowthWorkItem;
};

type FeedImportSource = "blog" | "changelog" | "all";

const PRIORITY_RANK: Record<WorkItemPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

const DEFAULT_CREATE_FORM: CreateFormState = {
  title: "",
  description: "",
  itemType: "idea",
  stage: "backlog",
  source: "manual",
  priority: "medium",
  link: "",
  dueAt: "",
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

function authHeaders(token?: string | null) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function stageLabel(stage: WorkItemStage) {
  return KANBAN_STAGES.find((entry) => entry.id === stage)?.label ?? stage;
}

function typeLabel(type: WorkItemType) {
  if (type === "idea") return "Idea";
  if (type === "keyword") return "Keyword";
  if (type === "title") return "Title";
  if (type === "article") return "Article";
  return "Social";
}

function sourceLabel(source: WorkItemSource) {
  if (source === "manual") return "Manual";
  if (source === "blog") return "Blog";
  if (source === "changelog") return "Changelog";
  if (source === "agent") return "Agent";
  return "n8n";
}

function priorityLabel(priority: WorkItemPriority) {
  if (priority === "high") return "High";
  if (priority === "low") return "Low";
  return "Medium";
}

function priorityBadgeClass(priority: WorkItemPriority) {
  if (priority === "high") {
    return "border-red-500/40 bg-red-500/10 text-red-200";
  }
  if (priority === "low") {
    return "border-neutral-600 bg-neutral-800 text-neutral-300";
  }
  return "border-sky-500/40 bg-sky-500/10 text-sky-200";
}

function typeBadgeClass(type: WorkItemType) {
  if (type === "article") return "border-blue-500/40 bg-blue-500/10 text-blue-200";
  if (type === "social") return "border-cyan-500/40 bg-cyan-500/10 text-cyan-200";
  if (type === "title") return "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  if (type === "keyword") return "border-amber-500/40 bg-amber-500/10 text-amber-200";
  return "border-neutral-500/40 bg-neutral-500/10 text-neutral-200";
}

function formatDueDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
}

export function KanbanPage() {
  const token = useAuthToken();
  const [items, setItems] = useState<GrowthWorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createForm, setCreateForm] = useState<CreateFormState>(DEFAULT_CREATE_FORM);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  const [importSource, setImportSource] = useState<FeedImportSource>("changelog");
  const [importLimit, setImportLimit] = useState("8");
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveErrors, setMoveErrors] = useState<Record<string, string>>({});

  const titleInputRef = useRef<HTMLInputElement>(null);

  async function loadBoard() {
    if (!token) {
      return;
    }

    try {
      setLoading(true);
      setLoadError(null);
      const response = await fetch("/api/kanban/items", {
        method: "GET",
        headers: authHeaders(token),
      });
      const data = (await response.json()) as BoardResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Could not load kanban board.");
      }
      setItems(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "Could not load kanban board.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBoard();
  }, [token]);

  const groupedItems = useMemo(() => {
    const grouped = new Map<WorkItemStage, GrowthWorkItem[]>();
    for (const stage of KANBAN_STAGES) {
      grouped.set(stage.id, []);
    }

    for (const item of items) {
      const list = grouped.get(item.stage);
      if (list) {
        list.push(item);
      }
    }

    for (const [stage, list] of grouped.entries()) {
      grouped.set(
        stage,
        [...list].sort((a, b) => {
          const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
          if (rankDiff !== 0) return rankDiff;
          return (
            new Date(b.updatedAt).getTime() -
            new Date(a.updatedAt).getTime()
          );
        }),
      );
    }

    return grouped;
  }, [items]);

  async function handleCreateItem(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;

    const title = createForm.title.trim();
    if (!title) {
      setCreateError("Title is required.");
      return;
    }

    try {
      setCreateLoading(true);
      setCreateError(null);
      setCreateNotice(null);

      const response = await fetch("/api/kanban/items", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          title,
          description: createForm.description,
          itemType: createForm.itemType,
          stage: createForm.stage,
          source: createForm.source,
          priority: createForm.priority,
          link: createForm.link,
          dueAt: createForm.dueAt ? new Date(createForm.dueAt).toISOString() : null,
        }),
      });
      const data = (await response.json()) as ItemsResponse & { error?: string };
      if (!response.ok || !data.item) {
        throw new Error(data.error || "Could not create item.");
      }

      setItems((prev) => [data.item as GrowthWorkItem, ...prev]);
      setCreateForm(DEFAULT_CREATE_FORM);
      setCreateNotice("Item created.");
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : "Could not create item.",
      );
    } finally {
      setCreateLoading(false);
    }
  }

  async function handleImport() {
    if (!token) return;
    const parsedLimit = Number(importLimit);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(30, Math.round(parsedLimit)))
      : 8;

    try {
      setImportLoading(true);
      setImportError(null);
      setImportNotice(null);
      const response = await fetch("/api/kanban/import", {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({
          source: importSource,
          limit,
        }),
      });
      const data = (await response.json()) as ImportResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Could not import feed ideas.");
      }

      setImportNotice(
        `Imported ${data.inserted ?? 0} item(s). Skipped ${data.skipped ?? 0} duplicate(s).`,
      );
      await loadBoard();
    } catch (error) {
      setImportError(
        error instanceof Error ? error.message : "Could not import feed ideas.",
      );
    } finally {
      setImportLoading(false);
    }
  }

  async function handleMoveItem(itemId: string, stage: WorkItemStage) {
    if (!token) return;

    try {
      setMovingId(itemId);
      setMoveErrors((prev) => ({ ...prev, [itemId]: "" }));

      const response = await fetch(`/api/kanban/items/${itemId}`, {
        method: "PATCH",
        headers: authHeaders(token),
        body: JSON.stringify({ stage }),
      });
      const data = (await response.json()) as ItemsResponse & { error?: string };
      if (!response.ok || !data.item) {
        throw new Error(data.error || "Could not move item.");
      }

      setItems((prev) =>
        prev.map((item) => (item.id === itemId ? (data.item as GrowthWorkItem) : item)),
      );
    } catch (error) {
      setMoveErrors((prev) => ({
        ...prev,
        [itemId]:
          error instanceof Error ? error.message : "Could not move item.",
      }));
    } finally {
      setMovingId(null);
    }
  }

  return (
    <div className="min-h-screen bg-neutral-950 px-4 py-8 text-neutral-100 sm:px-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <header className="space-y-2">
          <h1 className="text-balance text-3xl font-semibold">Growth Kanban</h1>
          <p className="max-w-4xl text-pretty text-sm text-neutral-400">
            Track ideas, SEO workflow, article execution, and social follow-ups in
            a single board.
          </p>
        </header>

        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="space-y-4">
            <Card className="border-white/10 bg-neutral-900">
              <CardHeader className="space-y-1">
                <CardTitle className="text-lg">Import Feed Ideas</CardTitle>
                <p className="text-pretty text-xs text-neutral-400">
                  Pull ideas from blog or changelog and drop them into backlog.
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-1.5">
                  <p className="text-xs uppercase text-neutral-500">Source</p>
                  <Select
                    value={importSource}
                    onValueChange={(value) => setImportSource(value as FeedImportSource)}
                    disabled={importLoading}
                  >
                    <SelectTrigger className="bg-neutral-950">
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="changelog">Changelog</SelectItem>
                      <SelectItem value="blog">Blog</SelectItem>
                      <SelectItem value="all">All</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs uppercase text-neutral-500">Limit</p>
                  <Input
                    value={importLimit}
                    onChange={(event) => setImportLimit(event.target.value)}
                    placeholder="8"
                    inputMode="numeric"
                    className="bg-neutral-950"
                  />
                </div>

                {importError ? (
                  <p className="text-xs text-red-400">{importError}</p>
                ) : null}
                {importNotice ? (
                  <p className="text-xs text-emerald-400">{importNotice}</p>
                ) : null}

                <Button
                  type="button"
                  className="w-full bg-sky-600 text-white hover:bg-sky-500"
                  onClick={handleImport}
                  disabled={importLoading}
                >
                  {importLoading ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Importing
                    </>
                  ) : (
                    <>
                      <RefreshCcw className="mr-2 size-4" />
                      Import Ideas
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>

            <Card className="border-white/10 bg-neutral-900">
              <CardHeader className="space-y-1">
                <CardTitle className="text-lg">Create Item</CardTitle>
                <p className="text-pretty text-xs text-neutral-400">
                  Add any work item manually and place it directly in the right
                  stage.
                </p>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={handleCreateItem}>
                  <div className="space-y-1.5">
                    <p className="text-xs uppercase text-neutral-500">Title</p>
                    <Input
                      ref={titleInputRef}
                      value={createForm.title}
                      onChange={(event) =>
                        setCreateForm((prev) => ({ ...prev, title: event.target.value }))
                      }
                      placeholder="Ex: PR review latency playbook"
                      className="bg-neutral-950"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs uppercase text-neutral-500">Description</p>
                    <Textarea
                      value={createForm.description}
                      onChange={(event) =>
                        setCreateForm((prev) => ({
                          ...prev,
                          description: event.target.value,
                        }))
                      }
                      placeholder="Short context for this card..."
                      className="min-h-20 bg-neutral-950"
                    />
                  </div>

                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <p className="text-xs uppercase text-neutral-500">Type</p>
                      <Select
                        value={createForm.itemType}
                        onValueChange={(value) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            itemType: value as WorkItemType,
                          }))
                        }
                      >
                        <SelectTrigger className="bg-neutral-950">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORK_ITEM_TYPES.map((itemType) => (
                            <SelectItem key={itemType} value={itemType}>
                              {typeLabel(itemType)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs uppercase text-neutral-500">Priority</p>
                      <Select
                        value={createForm.priority}
                        onValueChange={(value) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            priority: value as WorkItemPriority,
                          }))
                        }
                      >
                        <SelectTrigger className="bg-neutral-950">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORK_ITEM_PRIORITIES.map((priority) => (
                            <SelectItem key={priority} value={priority}>
                              {priorityLabel(priority)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs uppercase text-neutral-500">Source</p>
                      <Select
                        value={createForm.source}
                        onValueChange={(value) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            source: value as WorkItemSource,
                          }))
                        }
                      >
                        <SelectTrigger className="bg-neutral-950">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORK_ITEM_SOURCES.map((source) => (
                            <SelectItem key={source} value={source}>
                              {sourceLabel(source)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <p className="text-xs uppercase text-neutral-500">Stage</p>
                      <Select
                        value={createForm.stage}
                        onValueChange={(value) =>
                          setCreateForm((prev) => ({
                            ...prev,
                            stage: value as WorkItemStage,
                          }))
                        }
                      >
                        <SelectTrigger className="bg-neutral-950">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {KANBAN_STAGES.map((stage) => (
                            <SelectItem key={stage.id} value={stage.id}>
                              {stage.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs uppercase text-neutral-500">Reference URL</p>
                    <Input
                      value={createForm.link}
                      onChange={(event) =>
                        setCreateForm((prev) => ({ ...prev, link: event.target.value }))
                      }
                      placeholder="https://..."
                      className="bg-neutral-950"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-xs uppercase text-neutral-500">Due date</p>
                    <Input
                      type="date"
                      value={createForm.dueAt}
                      onChange={(event) =>
                        setCreateForm((prev) => ({ ...prev, dueAt: event.target.value }))
                      }
                      className="bg-neutral-950"
                    />
                  </div>

                  {createError ? (
                    <p className="text-xs text-red-400">{createError}</p>
                  ) : null}
                  {createNotice ? (
                    <p className="text-xs text-emerald-400">{createNotice}</p>
                  ) : null}

                  <Button
                    type="submit"
                    className="w-full bg-white text-neutral-900 hover:bg-neutral-200"
                    disabled={createLoading}
                  >
                    {createLoading ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Creating
                      </>
                    ) : (
                      <>
                        <Plus className="mr-2 size-4" />
                        Add Item
                      </>
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </aside>

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-balance text-xl font-semibold">Pipeline</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-white/15 bg-transparent text-neutral-200 hover:bg-white/10"
                onClick={() => void loadBoard()}
                disabled={loading}
              >
                {loading ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Refreshing
                  </>
                ) : (
                  <>
                    <RefreshCcw className="mr-2 size-4" />
                    Refresh
                  </>
                )}
              </Button>
            </div>

            {loadError ? (
              <Card className="border-red-500/40 bg-red-500/10">
                <CardContent className="py-4">
                  <p className="text-sm text-red-100">{loadError}</p>
                </CardContent>
              </Card>
            ) : null}

            <div className="overflow-x-auto pb-2">
              <div className="flex min-w-max gap-4">
                {KANBAN_STAGES.map((stage) => {
                  const stageItems = groupedItems.get(stage.id) ?? [];
                  return (
                    <Card
                      key={stage.id}
                      className="w-[320px] border-white/10 bg-neutral-900"
                    >
                      <CardHeader className="space-y-1 pb-3">
                        <div className="flex items-center justify-between gap-2">
                          <CardTitle className="text-base">{stage.label}</CardTitle>
                          <Badge
                            variant="outline"
                            className="tabular-nums border-white/15 bg-white/5 text-neutral-300"
                          >
                            {stageItems.length}
                          </Badge>
                        </div>
                        <p className="text-pretty text-xs text-neutral-500">{stage.help}</p>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {loading ? (
                          <>
                            <Skeleton className="h-24 w-full bg-neutral-800" />
                            <Skeleton className="h-20 w-full bg-neutral-800" />
                          </>
                        ) : stageItems.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-white/10 bg-neutral-950 p-4">
                            <p className="text-pretty text-xs text-neutral-500">
                              No items here yet.
                            </p>
                            <Button
                              type="button"
                              variant="link"
                              className="mt-1 h-auto p-0 text-xs text-sky-300"
                              onClick={() => titleInputRef.current?.focus()}
                            >
                              Add one from the form
                            </Button>
                          </div>
                        ) : (
                          stageItems.map((item) => {
                            const dueDate = formatDueDate(item.dueAt);
                            const cardMoving = movingId === item.id;
                            return (
                              <div
                                key={item.id}
                                className={cn(
                                  "space-y-3 rounded-lg border border-white/10 bg-neutral-950 p-3",
                                  cardMoving && "opacity-70",
                                )}
                              >
                                <div className="space-y-2">
                                  <p className="line-clamp-2 text-pretty text-sm font-medium text-neutral-100">
                                    {item.title}
                                  </p>
                                  {item.description ? (
                                    <p className="line-clamp-3 text-pretty text-xs text-neutral-400">
                                      {item.description}
                                    </p>
                                  ) : null}
                                </div>

                                <div className="flex flex-wrap gap-1.5">
                                  <Badge
                                    variant="outline"
                                    className={cn("text-[10px]", typeBadgeClass(item.itemType))}
                                  >
                                    {typeLabel(item.itemType)}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className="text-[10px] border-white/10 bg-white/5 text-neutral-300"
                                  >
                                    {sourceLabel(item.source)}
                                  </Badge>
                                  <Badge
                                    variant="outline"
                                    className={cn(
                                      "text-[10px]",
                                      priorityBadgeClass(item.priority),
                                    )}
                                  >
                                    {priorityLabel(item.priority)}
                                  </Badge>
                                </div>

                                {item.link ? (
                                  <a
                                    href={item.link}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="line-clamp-1 text-xs text-sky-300 underline-offset-4 hover:underline"
                                  >
                                    {item.link}
                                  </a>
                                ) : null}

                                <div className="space-y-1.5">
                                  <p className="text-[11px] uppercase text-neutral-500">
                                    Move to stage
                                  </p>
                                  <Select
                                    value={item.stage}
                                    onValueChange={(value) =>
                                      void handleMoveItem(item.id, value as WorkItemStage)
                                    }
                                    disabled={cardMoving}
                                  >
                                    <SelectTrigger className="h-8 bg-neutral-900 text-xs">
                                      <SelectValue placeholder="Select stage" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {KANBAN_STAGES.map((entry) => (
                                        <SelectItem key={entry.id} value={entry.id}>
                                          {entry.label}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                </div>

                                <div className="flex items-center justify-between text-[11px] text-neutral-500">
                                  <span>{stageLabel(item.stage)}</span>
                                  {dueDate ? <span className="tabular-nums">Due {dueDate}</span> : null}
                                </div>

                                {moveErrors[item.id] ? (
                                  <p className="text-xs text-red-400">{moveErrors[item.id]}</p>
                                ) : null}
                              </div>
                            );
                          })
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
