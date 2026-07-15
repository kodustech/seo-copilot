"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  Search,
  Users,
  X,
} from "lucide-react";

import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

type Rubric = {
  id: string;
  name: string;
  description: string;
  pass_threshold: number;
};

type ResearchTable = {
  id: string;
  name: string;
  rubricId: string;
  description: string | null;
  rowCount?: number;
};

type ResearchRow = {
  id: string;
  companyName: string;
  domain: string | null;
  source: string;
  status: string;
  icpScore: number | null;
  triggerScore: number | null;
  fitScore: number | null;
  antiFlags: string[];
  whyNow: string | null;
  pass: boolean | null;
  lastResearchedAt: string | null;
  error: string | null;
};

type Evidence = {
  criterionId: string;
  kind: string;
  status: string;
  confidence: number;
  evidence: string | null;
  sources: Array<{ url: string; pack?: string }>;
  weight: number;
};

type Person = {
  name: string;
  role: string | null;
  email: string | null;
  emailStatus: string | null;
  providerUsed: string | null;
};

type Panel = "none" | "add" | "create";

function ScoreCell({
  score,
  pass,
}: {
  score: number | null;
  pass: boolean | null;
}) {
  if (score == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn(
        "font-mono text-sm tabular-nums",
        pass === true && "text-emerald-600 dark:text-emerald-400",
        pass === false && "text-muted-foreground",
      )}
    >
      {score}
    </span>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "researched"
      ? "bg-emerald-500"
      : status === "researching"
        ? "bg-amber-500 animate-pulse"
        : status === "failed"
          ? "bg-rose-500"
          : "bg-muted-foreground/40";
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className={cn("size-1.5 rounded-full", color)} />
      {status === "pending"
        ? "Not run"
        : status === "researching"
          ? "Running…"
          : status === "researched"
            ? "Done"
            : status === "failed"
              ? "Failed"
              : status}
    </span>
  );
}

export function ResearchPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const [token, setToken] = useState<string | null>(null);
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [rows, setRows] = useState<ResearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [passOnly, setPassOnly] = useState(false);
  const [importText, setImportText] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [newTableName, setNewTableName] = useState("");
  const [newRubric, setNewRubric] = useState("qe-kodus-v1");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [actionBusy, setActionBusy] = useState(false);

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    }),
    [token],
  );

  const loadTables = useCallback(async () => {
    if (!token) return;
    const res = await fetch("/api/research/tables", { headers: headers() });
    if (!res.ok) {
      setNotice((await res.json()).error ?? "Failed to load lists");
      return;
    }
    const data = await res.json();
    const nextTables = (data.tables ?? []) as ResearchTable[];
    setTables(nextTables);
    setRubrics(data.rubrics ?? []);
    setTableId((current) => {
      if (current && nextTables.some((t) => t.id === current)) return current;
      return nextTables[0]?.id ?? null;
    });
  }, [token, headers]);

  const loadRows = useCallback(async () => {
    if (!token || !tableId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const qs = passOnly ? "?passOnly=1" : "";
      const res = await fetch(`/api/research/tables/${tableId}${qs}`, {
        headers: headers(),
      });
      if (!res.ok) {
        setNotice((await res.json()).error ?? "Failed to load companies");
        return;
      }
      const data = await res.json();
      setRows(data.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, [token, tableId, passOnly, headers]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const pollUntilDone = useCallback(async () => {
    if (!token || !tableId) return;
    setRunning(true);
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(`/api/research/status?tableId=${tableId}`, {
          headers: headers(),
        });
        if (!res.ok) continue;
        const state = await res.json();
        if (state.running) {
          setNotice("Research running… this can take a few minutes.");
          continue;
        }
        if (state.lastError) setNotice(state.lastError);
        else if (state.lastSummary) setNotice(state.lastSummary);
        else setNotice(null);
        await loadRows();
        await loadTables();
        break;
      } catch {
        // keep polling
      }
    }
    setRunning(false);
  }, [token, tableId, headers, loadRows, loadTables]);

  const createTable = async () => {
    if (!token || !newTableName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/research/tables", {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          name: newTableName.trim(),
          rubricId: newRubric,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Could not create list");
        return;
      }
      setNewTableName("");
      setPanel("none");
      setTableId(data.table.id);
      await loadTables();
      setPanel("add");
    } finally {
      setCreating(false);
    }
  };

  const importDomains = async () => {
    if (!token || !tableId || !importText.trim()) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/research/tables/${tableId}/rows`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ text: importText, source: "csv" }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Import failed");
        return;
      }
      setImportText("");
      setPanel("none");
      setNotice(
        data.added === 0
          ? "No new companies (duplicates skipped)."
          : `Added ${data.added} compan${data.added === 1 ? "y" : "ies"}.`,
      );
      await loadRows();
      await loadTables();
    } finally {
      setImporting(false);
    }
  };

  const importSource = async (source: string) => {
    if (!token || !tableId) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/research/tables/${tableId}/import`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Import failed");
        return;
      }
      setNotice(
        data.added === 0
          ? "Nothing new to import."
          : `Imported ${data.added} compan${data.added === 1 ? "y" : "ies"}.`,
      );
      setPanel("none");
      await loadRows();
      await loadTables();
    } finally {
      setImporting(false);
    }
  };

  const runJob = async (
    kind: "research" | "people" | "full",
    force = false,
  ) => {
    if (!token || !tableId) return;
    const rowIds = selected.size > 0 ? [...selected] : undefined;
    const res = await fetch(`/api/research/tables/${tableId}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind,
        rowIds,
        force,
        enrichPeople: kind === "full",
      }),
    });
    if (res.status === 409) {
      setNotice("A job is already running…");
      void pollUntilDone();
      return;
    }
    if (!res.ok) {
      const data = await res.json();
      setNotice(data.error ?? "Failed to start");
      return;
    }
    setNotice(
      kind === "people"
        ? "Finding people…"
        : "Research started… hang tight.",
    );
    void pollUntilDone();
  };

  const openDrawer = async (rowId: string) => {
    if (!token) return;
    setDrawerRowId(rowId);
    setDrawerLoading(true);
    try {
      const res = await fetch(`/api/research/rows/${rowId}`, {
        headers: headers(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setEvidence(data.evidence ?? []);
      setPeople(data.people ?? []);
    } finally {
      setDrawerLoading(false);
    }
  };

  const rowAction = async (
    rowId: string,
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!token) return;
    setActionBusy(true);
    try {
      const res = await fetch(`/api/research/rows/${rowId}/actions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action, ...extra }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Action failed");
        return;
      }
      if (action === "ai_column") {
        setNotice(data.answer ?? "Done");
      } else if (action === "people") {
        setNotice(`Found ${(data.people ?? []).length} people`);
      } else if (action === "qualify") {
        setNotice("Pushed to CRM and outreach");
      } else {
        setNotice("Done");
      }
      if (drawerRowId === rowId) await openDrawer(rowId);
      await loadRows();
    } finally {
      setActionBusy(false);
    }
  };

  const exportCsv = () => {
    if (!token || !tableId) return;
    void (async () => {
      const res = await fetch(
        `/api/research/tables/${tableId}/export${passOnly ? "?passOnly=1" : ""}`,
        { headers: headers() },
      );
      if (!res.ok) {
        setNotice("Export failed");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `research-${tableId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const activeTable = tables.find((t) => t.id === tableId) ?? null;
  const activeRubric = rubrics.find((r) => r.id === activeTable?.rubricId);
  const drawerRow = rows.find((r) => r.id === drawerRowId);

  const stats = useMemo(() => {
    const researched = rows.filter((r) => r.status === "researched").length;
    const passed = rows.filter((r) => r.pass === true).length;
    return { total: rows.length, researched, passed };
  }, [rows]);

  const hasTables = tables.length > 0;
  const showEmptyNoTables = !loading && !hasTables;
  const showEmptyNoRows =
    !loading && hasTables && rows.length === 0 && !passOnly;
  const showTable = hasTables && (rows.length > 0 || passOnly);

  // ─── No lists yet ─────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-6xl flex-col gap-5 p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-balance text-xl font-semibold tracking-tight">
            Research
          </h1>
          <p className="text-pretty text-sm text-muted-foreground">
            Score companies against your ICP, then find who to contact.
          </p>
        </div>

        {hasTables && (
          <div className="flex items-center gap-2">
            <Select
              value={tableId ?? undefined}
              onValueChange={(v) => {
                setTableId(v);
                setSelected(new Set());
                setDrawerRowId(null);
                setNotice(null);
              }}
            >
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue placeholder="Select list" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                    {typeof t.rowCount === "number" ? ` · ${t.rowCount}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel("create")}
            >
              <Plus className="size-4" />
              New list
            </Button>
          </div>
        )}
      </div>

      {/* Toast / status — only when something useful to say */}
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span className="text-pretty">{notice}</span>
          <button
            type="button"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      {/* Empty: no list */}
      {showEmptyNoTables && (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
          <div className="mb-3 flex size-10 items-center justify-center rounded-full border bg-muted/40">
            <Search className="size-5 text-muted-foreground" />
          </div>
          <h2 className="text-balance text-base font-medium">
            Start a research list
          </h2>
          <p className="mt-1 max-w-sm text-pretty text-sm text-muted-foreground">
            Add companies, run research against your ICP playbook, then find
            people to contact.
          </p>
          <Button className="mt-5" onClick={() => setPanel("create")}>
            <Plus className="size-4" />
            Create list
          </Button>
        </div>
      )}

      {/* Empty: list exists, no companies */}
      {showEmptyNoRows && activeTable && (
        <div className="flex flex-1 flex-col items-center justify-center rounded-xl border border-dashed px-6 py-16 text-center">
          <h2 className="text-balance text-base font-medium">
            Add companies to “{activeTable.name}”
          </h2>
          <p className="mt-1 max-w-md text-pretty text-sm text-muted-foreground">
            Paste domains, or pull from your watchlist, CRM, or strong ICP
            signals.
            {activeRubric ? (
              <>
                {" "}
                Scoring with <span className="text-foreground">{activeRubric.name}</span>.
              </>
            ) : null}
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
            <Button onClick={() => setPanel("add")}>
              <Plus className="size-4" />
              Paste domains
            </Button>
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("watchlist")}
            >
              From watchlist
            </Button>
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("icp_signals")}
            >
              Strong signals
            </Button>
            <Button
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("crm")}
            >
              From CRM
            </Button>
          </div>
        </div>
      )}

      {/* Main table state */}
      {showTable && activeTable && (
        <>
          {/* Compact toolbar */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={running || loading}
              onClick={() => void runJob("research")}
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              {selected.size > 0
                ? `Research ${selected.size} selected`
                : stats.researched === 0
                  ? "Run research"
                  : "Research pending"}
            </Button>

            <Button
              size="sm"
              variant="secondary"
              disabled={running || loading || stats.passed === 0}
              onClick={() => void runJob("people")}
              title={
                stats.passed === 0
                  ? "Research companies first — people run only on ICP pass"
                  : undefined
              }
            >
              <Users className="size-4" />
              Find people
            </Button>

            <Button
              size="sm"
              variant="outline"
              onClick={() => setPanel("add")}
            >
              <Plus className="size-4" />
              Add
            </Button>

            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="More actions">
                  <MoreHorizontal className="size-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-56 p-1">
                <div className="flex flex-col">
                  {(
                    [
                      {
                        label: "Research + find people",
                        onClick: () => void runJob("full"),
                        disabled: running,
                      },
                      {
                        label: "Re-run all research",
                        onClick: () => void runJob("research", true),
                        disabled: running,
                      },
                      null,
                      {
                        label: "Import from watchlist",
                        onClick: () => void importSource("watchlist"),
                      },
                      {
                        label: "Import strong signals",
                        onClick: () => void importSource("icp_signals"),
                      },
                      {
                        label: "Import from CRM",
                        onClick: () => void importSource("crm"),
                      },
                      null,
                      {
                        label: "Export CSV",
                        onClick: exportCsv,
                        icon: true,
                      },
                    ] as Array<
                      | {
                          label: string;
                          onClick: () => void;
                          disabled?: boolean;
                          icon?: boolean;
                        }
                      | null
                    >
                  ).map((item, i) =>
                    item === null ? (
                      <div
                        key={`sep-${i}`}
                        className="my-1 h-px bg-border"
                        role="separator"
                      />
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        disabled={item.disabled}
                        onClick={item.onClick}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                      >
                        {item.icon && <Download className="size-3.5" />}
                        {item.label}
                      </button>
                    ),
                  )}
                </div>
              </PopoverContent>
            </Popover>

            <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="tabular-nums">
                {stats.total} companies
                {stats.researched > 0 && (
                  <>
                    {" · "}
                    {stats.researched} researched
                  </>
                )}
                {stats.passed > 0 && (
                  <>
                    {" · "}
                    <span className="text-emerald-600 dark:text-emerald-400">
                      {stats.passed} pass
                    </span>
                  </>
                )}
              </span>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border"
                  checked={passOnly}
                  onChange={(e) => setPassOnly(e.target.checked)}
                />
                Pass only
              </label>
            </div>
          </div>

          {passOnly && rows.length === 0 && !loading && (
            <p className="text-sm text-muted-foreground">
              No companies passed yet. Turn off “Pass only” or run research.
            </p>
          )}

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <input
                      type="checkbox"
                      className="size-3.5"
                      checked={
                        rows.length > 0 && selected.size === rows.length
                      }
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead>Company</TableHead>
                  <TableHead className="w-20">Score</TableHead>
                  <TableHead className="w-16">ICP</TableHead>
                  <TableHead className="hidden md:table-cell">Why now</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell
                      colSpan={6}
                      className="h-24 text-center text-muted-foreground"
                    >
                      <Loader2 className="mr-2 inline size-4 animate-spin" />
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!loading &&
                  rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      data-state={selected.has(r.id) ? "selected" : undefined}
                      onClick={() => void openDrawer(r.id)}
                    >
                      <TableCell onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="size-3.5"
                          checked={selected.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                          aria-label={`Select ${r.companyName}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{r.companyName}</div>
                        <div className="font-mono text-xs text-muted-foreground">
                          {r.domain ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell>
                        <ScoreCell score={r.icpScore} pass={r.pass} />
                      </TableCell>
                      <TableCell>
                        {r.pass === true ? (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <Check className="size-3.5" />
                            Pass
                          </span>
                        ) : r.pass === false ? (
                          <span className="text-xs text-muted-foreground">
                            No
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[240px] md:table-cell">
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {r.antiFlags?.length
                            ? `Anti: ${r.antiFlags.join(", ")}`
                            : (r.whyNow ?? "—")}
                        </span>
                      </TableCell>
                      <TableCell>
                        <StatusDot status={r.status} />
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {/* Create list dialog */}
      <Dialog
        open={panel === "create"}
        onOpenChange={(open) => setPanel(open ? "create" : "none")}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New research list</DialogTitle>
            <DialogDescription>
              Pick a playbook. You can add companies right after.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="list-name">
                Name
              </label>
              <Input
                id="list-name"
                placeholder="e.g. QE pipeline Jul"
                value={newTableName}
                onChange={(e) => setNewTableName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createTable();
                }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">ICP playbook</label>
              <Select value={newRubric} onValueChange={setNewRubric}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(rubrics.length > 0
                    ? rubrics
                    : [
                        {
                          id: "qe-kodus-v1",
                          name: "QE / E2E testing ICP",
                          description: "",
                          pass_threshold: 55,
                        },
                        {
                          id: "generic-b2b-v1",
                          name: "Generic B2B SaaS",
                          description: "",
                          pass_threshold: 40,
                        },
                      ]
                  ).map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              disabled={!newTableName.trim() || creating}
              onClick={() => void createTable()}
            >
              {creating && <Loader2 className="size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add companies dialog */}
      <Dialog
        open={panel === "add"}
        onOpenChange={(open) => setPanel(open ? "add" : "none")}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add companies</DialogTitle>
            <DialogDescription>
              One domain per line. Optional name:{" "}
              <code className="text-xs">Omie, omie.com.br</code>
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
            placeholder={"linear.app\nposthog.com\nOmie, omie.com.br"}
            className="font-mono text-sm"
          />
          <div className="flex flex-wrap gap-2">
            <span className="w-full text-xs text-muted-foreground">
              Or import from:
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("watchlist")}
            >
              Watchlist
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("icp_signals")}
            >
              Strong signals
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={importing}
              onClick={() => void importSource("crm")}
            >
              CRM
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              disabled={!importText.trim() || importing}
              onClick={() => void importDomains()}
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Add to list
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Company drawer */}
      {drawerRowId && drawerRow && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setDrawerRowId(null)}
          aria-hidden
        />
      )}
      {drawerRowId && drawerRow && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-background shadow-lg">
          <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
            <div className="min-w-0">
              <div className="truncate font-semibold">
                {drawerRow.companyName}
              </div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {drawerRow.domain ?? "no domain"}
              </div>
            </div>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Close"
              onClick={() => setDrawerRowId(null)}
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="flex flex-wrap gap-2 border-b px-4 py-2">
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy}
              onClick={() =>
                void rowAction(drawerRowId, "people", { onlyIfPass: false })
              }
            >
              <Users className="size-3.5" />
              Find people
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={actionBusy}
              onClick={() => void rowAction(drawerRowId, "crm")}
            >
              <Building2 className="size-3.5" />
              To CRM
            </Button>
            <Button
              size="sm"
              disabled={actionBusy}
              onClick={() =>
                void rowAction(drawerRowId, "qualify", { force: true })
              }
            >
              Qualify
            </Button>
          </div>

          <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
            {drawerLoading ? (
              <div className="text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline size-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <>
                <section>
                  <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                    Result
                  </h3>
                  <div className="flex items-baseline gap-3">
                    <ScoreCell
                      score={drawerRow.icpScore}
                      pass={drawerRow.pass}
                    />
                    {drawerRow.pass === true && (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                      >
                        ICP pass
                      </Badge>
                    )}
                    {drawerRow.pass === false && (
                      <Badge variant="outline">Not a fit</Badge>
                    )}
                  </div>
                  {drawerRow.whyNow && (
                    <p className="mt-2 text-pretty text-sm">{drawerRow.whyNow}</p>
                  )}
                  {drawerRow.antiFlags?.length > 0 && (
                    <p className="mt-1 text-xs text-rose-600 dark:text-rose-400">
                      Anti-flags: {drawerRow.antiFlags.join(", ")}
                    </p>
                  )}
                  {drawerRow.error && (
                    <p className="mt-2 text-sm text-rose-600">{drawerRow.error}</p>
                  )}
                </section>

                <section>
                  <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                    Checklist
                  </h3>
                  <ul className="space-y-2">
                    {evidence.map((e) => (
                      <li
                        key={e.criterionId}
                        className="rounded-md border px-2.5 py-2 text-sm"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "size-1.5 shrink-0 rounded-full",
                              e.status === "pass" && "bg-emerald-500",
                              e.status === "fail" && "bg-rose-500",
                              e.status === "unknown" && "bg-muted-foreground/40",
                            )}
                          />
                          <span className="text-xs font-medium capitalize text-muted-foreground">
                            {e.kind}
                          </span>
                          <span className="truncate font-mono text-[11px]">
                            {e.criterionId.replace(/_/g, " ")}
                          </span>
                        </div>
                        {e.evidence && (
                          <p className="mt-1 text-pretty text-xs text-muted-foreground">
                            {e.evidence}
                          </p>
                        )}
                        {e.sources?.[0]?.url?.startsWith("http") && (
                          <a
                            href={e.sources[0].url}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-1 block truncate text-[11px] text-foreground/70 underline-offset-2 hover:underline"
                          >
                            {e.sources[0].url}
                          </a>
                        )}
                      </li>
                    ))}
                    {evidence.length === 0 && (
                      <li className="text-xs text-muted-foreground">
                        Run research to fill the checklist.
                      </li>
                    )}
                  </ul>
                </section>

                <section>
                  <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                    People
                  </h3>
                  <ul className="space-y-1.5">
                    {people.map((p, i) => (
                      <li
                        key={`${p.name}-${i}`}
                        className="rounded-md border px-2.5 py-1.5 text-sm"
                      >
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {[p.role, p.email, p.emailStatus]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </div>
                      </li>
                    ))}
                    {people.length === 0 && (
                      <li className="text-xs text-muted-foreground">
                        No people yet. Use Find people.
                      </li>
                    )}
                  </ul>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    Ask anything
                  </h3>
                  <div className="flex gap-2">
                    <Input
                      placeholder="e.g. Do they use Playwright?"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && aiPrompt.trim()) {
                          void rowAction(drawerRowId, "ai_column", {
                            prompt: aiPrompt.trim(),
                          });
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!aiPrompt.trim() || actionBusy}
                      onClick={() =>
                        void rowAction(drawerRowId, "ai_column", {
                          prompt: aiPrompt.trim(),
                        })
                      }
                    >
                      Ask
                    </Button>
                  </div>
                </section>
              </>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
