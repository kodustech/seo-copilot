"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  Check,
  Download,
  ExternalLink,
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
  packRaw?: Record<string, unknown>;
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
};

type Panel = "none" | "add" | "create";
type Market = "global" | "brazil";
type SizeBand = "any" | "small" | "mid" | "large";

function engOpenings(row: ResearchRow): number | null {
  const careers = row.packRaw?.careers as
    | { meta?: { extraFlags?: { engOpenings?: number } } }
    | undefined;
  const n = careers?.meta?.extraFlags?.engOpenings;
  return typeof n === "number" ? n : null;
}

function rowMarket(row: ResearchRow): string | null {
  const find = row.packRaw?.find as { market?: string } | undefined;
  return find?.market ?? null;
}

type HuntProvenance = {
  source: string;
  query: string;
  url: string;
  title: string | null;
  quote: string;
  confidence?: number;
};

function rowHunt(row: ResearchRow): HuntProvenance | null {
  const hunt = row.packRaw?.hunt as HuntProvenance | undefined;
  return hunt?.url && hunt?.quote ? hunt : null;
}

function rowDiscovery(
  row: ResearchRow,
): { sourceUrl?: string; sourceQuery?: string | null; ats?: string } | null {
  return (
    (row.packRaw?.discovery as {
      sourceUrl?: string;
      sourceQuery?: string | null;
      ats?: string;
    }) ?? null
  );
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function matchesSize(size: SizeBand, eng: number | null): boolean {
  if (size === "any") return true;
  if (eng == null) return true; // keep until researched
  if (size === "small") return eng > 0 && eng <= 10;
  if (size === "mid") return eng >= 3 && eng <= 50;
  if (size === "large") return eng >= 20;
  return true;
}

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
  const [minScore, setMinScore] = useState<string>("");
  const [filterSize, setFilterSize] = useState<SizeBand | "all">("all");
  const [filterMarket, setFilterMarket] = useState<"all" | Market>("all");
  const [importText, setImportText] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [newTableName, setNewTableName] = useState("");
  const [newRubric, setNewRubric] = useState("qe-kodus-v1");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  // Find form (the actual product)
  const [market, setMarket] = useState<Market>("brazil");
  const [size, setSize] = useState<SizeBand>("mid");
  const [maxCompanies, setMaxCompanies] = useState("12");
  const [focus, setFocus] = useState("");

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
      const res = await fetch(`/api/research/tables/${tableId}`, {
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
  }, [token, tableId, headers]);

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
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const res = await fetch(`/api/research/status?tableId=${tableId}`, {
          headers: headers(),
        });
        if (!res.ok) continue;
        const state = await res.json();
        if (state.running) {
          setNotice(
            state.lastSummary ??
              "Working… finding + scoring companies (can take several minutes).",
          );
          // Refresh mid-run so new rows appear
          await loadRows();
          continue;
        }
        if (state.lastError) setNotice(state.lastError);
        else if (state.lastSummary) setNotice(state.lastSummary);
        await loadRows();
        await loadTables();
        break;
      } catch {
        // keep polling
      }
    }
    setRunning(false);
  }, [token, tableId, headers, loadRows, loadTables]);

  const ensureTable = async (): Promise<string | null> => {
    if (tableId) return tableId;
    if (!token) return null;
    const name = `QE ${market === "brazil" ? "Brasil" : "Global"} · ${new Date().toLocaleDateString("pt-BR")}`;
    const res = await fetch("/api/research/tables", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name, rubricId: "qe-kodus-v1" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setNotice(data.error ?? "Could not create list");
      return null;
    }
    setTableId(data.table.id);
    await loadTables();
    return data.table.id as string;
  };

  const runFind = async () => {
    if (!token || running) return;
    const id = await ensureTable();
    if (!id) return;

    setRunning(true);
    setNotice("Finding companies…");
    const res = await fetch(`/api/research/tables/${id}/find`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        market,
        size,
        maxCompanies: Number(maxCompanies) || 12,
        focus: focus.trim() || null,
        researchAfter: true,
      }),
    });
    if (res.status === 409) {
      setNotice("Job already running…");
      void pollUntilDone();
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setNotice(data.error ?? "Find failed");
      setRunning(false);
      return;
    }
    setFilterMarket(market);
    setFilterSize(size === "any" ? "all" : size);
    void pollUntilDone();
  };

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
      setNotice(`Added ${data.added} companies.`);
      await loadRows();
    } finally {
      setImporting(false);
    }
  };

  const runJob = async (kind: "research" | "people" | "full", force = false) => {
    if (!token || !tableId) return;
    const rowIds = selected.size > 0 ? [...selected] : undefined;
    const res = await fetch(`/api/research/tables/${tableId}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ kind, rowIds, force }),
    });
    if (res.status === 409) {
      void pollUntilDone();
      return;
    }
    if (!res.ok) {
      const data = await res.json();
      setNotice(data.error ?? "Failed");
      return;
    }
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
      setNotice(
        action === "ai_column"
          ? (data.answer ?? "Done")
          : action === "people"
            ? `Found ${(data.people ?? []).length} people`
            : "Done",
      );
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
        `/api/research/tables/${tableId}/export`,
        { headers: headers() },
      );
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `research-${tableId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  };

  const filteredRows = useMemo(() => {
    const min = minScore ? Number(minScore) : null;
    return rows.filter((r) => {
      if (passOnly && r.pass !== true) return false;
      if (min != null && !Number.isNaN(min)) {
        if (r.icpScore == null || r.icpScore < min) return false;
      }
      if (filterMarket !== "all") {
        const m = rowMarket(r);
        if (m && m !== filterMarket) return false;
      }
      if (filterSize !== "all") {
        if (!matchesSize(filterSize, engOpenings(r))) return false;
      }
      return true;
    });
  }, [rows, passOnly, minScore, filterMarket, filterSize]);

  const activeTable = tables.find((t) => t.id === tableId) ?? null;
  const drawerRow = rows.find((r) => r.id === drawerRowId);
  const passedCount = rows.filter((r) => r.pass === true).length;

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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-balance text-xl font-semibold tracking-tight">
            Research
          </h1>
          <p className="max-w-xl text-pretty text-sm text-muted-foreground">
            Find companies that match the QE ICP (region + size + hiring
            signals), score them against the playbook, then get contacts.
          </p>
        </div>
        {tables.length > 0 && (
          <div className="flex items-center gap-2">
            <Select
              value={tableId ?? undefined}
              onValueChange={(v) => {
                setTableId(v);
                setSelected(new Set());
                setDrawerRowId(null);
              }}
            >
              <SelectTrigger className="h-9 w-[200px]">
                <SelectValue placeholder="List" />
              </SelectTrigger>
              <SelectContent>
                {tables.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={() => setPanel("create")}>
              <Plus className="size-4" />
              New list
            </Button>
          </div>
        )}
      </div>

      {/* ── Primary: Find ICP ─────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2">
          <Search className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Find ICP companies</h2>
        </div>
        <p className="mb-4 text-pretty text-xs text-muted-foreground">
          Searches public boards for QA/SDET/automation hiring — Brazil: Gupy +
          Workable + Programathor + LinkedIn (via search) + Remotive; Global:
          Greenhouse/Lever/Ashby/Workable/SmartRecruiters/LinkedIn/Remotive —
          then scores with the QE playbook.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Region
            </label>
            <Select
              value={market}
              onValueChange={(v) => setMarket(v as Market)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="brazil">
                  Brazil (Gupy + Workable + Programathor)
                </SelectItem>
                <SelectItem value="global">
                  Global (GH/Lever/Ashby/Workable/SR)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Company size (eng signal)
            </label>
            <Select value={size} onValueChange={(v) => setSize(v as SizeBand)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mid">Mid (~3–50 eng openings)</SelectItem>
                <SelectItem value="small">Small (≤10 eng openings)</SelectItem>
                <SelectItem value="large">Large (20+ eng openings)</SelectItem>
                <SelectItem value="any">Any size</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              How many
            </label>
            <Select value={maxCompanies} onValueChange={setMaxCompanies}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="6">6 (fast test)</SelectItem>
                <SelectItem value="12">12</SelectItem>
                <SelectItem value="20">20</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Extra focus (optional)
            </label>
            <Input
              placeholder="fintech, Playwright…"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
            />
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={running} onClick={() => void runFind()}>
            {running ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            Find &amp; score ICP
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => {
              setMarket("brazil");
              setSize("mid");
              setMaxCompanies("6");
              setFocus("");
              void runFind();
            }}
          >
            Quick test: Brazil mid-size (6)
          </Button>
          <span className="text-xs text-muted-foreground">
            Creates a list automatically if you don’t have one. Takes a few
            minutes.
          </span>
        </div>
      </section>

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

      {/* ── Results ───────────────────────────────────────────────────── */}
      {activeTable && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{activeTable.name}</span>
            <Badge variant="secondary" className="text-xs">
              QE playbook
            </Badge>
            <span className="text-xs text-muted-foreground tabular-nums">
              {rows.length} found · {passedCount} pass ICP
              {filteredRows.length !== rows.length &&
                ` · showing ${filteredRows.length}`}
            </span>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-muted/20 px-3 py-2.5">
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Region
              </label>
              <Select
                value={filterMarket}
                onValueChange={(v) => setFilterMarket(v as "all" | Market)}
              >
                <SelectTrigger className="h-8 w-[130px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="brazil">Brazil</SelectItem>
                  <SelectItem value="global">Global</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Size
              </label>
              <Select
                value={filterSize}
                onValueChange={(v) => setFilterSize(v as SizeBand | "all")}
              >
                <SelectTrigger className="h-8 w-[140px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sizes</SelectItem>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="mid">Mid</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <label className="text-[11px] font-medium text-muted-foreground">
                Min score
              </label>
              <Input
                className="h-8 w-20"
                inputMode="numeric"
                placeholder="55"
                value={minScore}
                onChange={(e) => setMinScore(e.target.value)}
              />
            </div>
            <label className="mb-1.5 flex cursor-pointer items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                className="size-3.5"
                checked={passOnly}
                onChange={(e) => setPassOnly(e.target.checked)}
              />
              ICP pass only
            </label>

            <div className="ml-auto flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={running || !tableId}
                onClick={() => void runJob("research")}
              >
                Score pending
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={running || passedCount === 0}
                onClick={() => void runJob("people")}
              >
                <Users className="size-3.5" />
                People on pass
              </Button>
              <Button size="sm" variant="outline" onClick={() => setPanel("add")}>
                <Plus className="size-3.5" />
                Paste domains
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" aria-label="More">
                    <MoreHorizontal className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-48 p-1">
                  <button
                    type="button"
                    className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => void runJob("research", true)}
                  >
                    Re-score all
                  </button>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={exportCsv}
                  >
                    <Download className="size-3.5" />
                    Export CSV
                  </button>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>Company</TableHead>
                  <TableHead className="w-24">Region</TableHead>
                  <TableHead className="w-16">Eng</TableHead>
                  <TableHead className="w-16">Score</TableHead>
                  <TableHead className="w-16">ICP</TableHead>
                  <TableHead className="hidden md:table-cell">Why now</TableHead>
                  <TableHead className="w-24">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-20 text-center text-muted-foreground"
                    >
                      <Loader2 className="mr-2 inline size-4 animate-spin" />
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && filteredRows.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="h-28 text-center text-sm text-muted-foreground"
                    >
                      {rows.length === 0
                        ? "No companies yet. Use “Find & score ICP” above."
                        : "No rows match these filters."}
                    </TableCell>
                  </TableRow>
                )}
                {!loading &&
                  filteredRows.map((r) => {
                    const eng = engOpenings(r);
                    const m = rowMarket(r);
                    return (
                      <TableRow
                        key={r.id}
                        className="cursor-pointer"
                        onClick={() => void openDrawer(r.id)}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="size-3.5"
                            checked={selected.has(r.id)}
                            onChange={() => {
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(r.id)) next.delete(r.id);
                                else next.add(r.id);
                                return next;
                              });
                            }}
                            aria-label={`Select ${r.companyName}`}
                          />
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium">{r.companyName}</span>
                            {rowHunt(r) && (
                              <Badge
                                variant="outline"
                                className="border-emerald-500/40 px-1 py-0 text-[9px] uppercase text-emerald-700 dark:text-emerald-400"
                                title={`Sinal: “${rowHunt(r)!.quote.slice(0, 140)}”`}
                              >
                                sinal
                              </Badge>
                            )}
                          </div>
                          <div className="font-mono text-xs text-muted-foreground">
                            {r.domain ?? "—"}
                          </div>
                        </TableCell>
                        <TableCell className="text-xs capitalize text-muted-foreground">
                          {m ?? "—"}
                        </TableCell>
                        <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                          {eng ?? "—"}
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
                        <TableCell className="hidden max-w-[220px] md:table-cell">
                          <span className="line-clamp-2 text-xs text-muted-foreground">
                            {r.antiFlags?.length
                              ? `Anti: ${r.antiFlags.join(", ")}`
                              : (r.whyNow ?? "—")}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.status === "pending"
                            ? "Queued"
                            : r.status === "researching"
                              ? "Scoring…"
                              : r.status === "researched"
                                ? "Done"
                                : r.status}
                        </TableCell>
                      </TableRow>
                    );
                  })}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {!activeTable && !running && (
        <p className="text-center text-sm text-muted-foreground">
          Hit <strong>Find &amp; score ICP</strong> above — a list is created
          for you.
        </p>
      )}

      {/* Create list */}
      <Dialog
        open={panel === "create"}
        onOpenChange={(open) => setPanel(open ? "create" : "none")}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
            <DialogDescription>
              Optional — Find already creates one. Use this to organize runs.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="List name"
            value={newTableName}
            onChange={(e) => setNewTableName(e.target.value)}
          />
          <Select value={newRubric} onValueChange={setNewRubric}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(rubrics.length
                ? rubrics
                : [{ id: "qe-kodus-v1", name: "QE / E2E testing ICP" }]
              ).map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              disabled={!newTableName.trim() || creating}
              onClick={() => void createTable()}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Paste domains */}
      <Dialog
        open={panel === "add"}
        onOpenChange={(open) => setPanel(open ? "add" : "none")}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Paste domains</DialogTitle>
            <DialogDescription>
              One per line. Then use “Score pending” to run the playbook.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={7}
            className="font-mono text-sm"
            placeholder={"omie.com.br\nlinear.app"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              disabled={!importText.trim() || importing}
              onClick={() => void importDomains()}
            >
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drawer */}
      {drawerRowId && drawerRow && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setDrawerRowId(null)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l bg-background shadow-lg">
            <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
              <div className="min-w-0">
                <div className="truncate font-semibold">
                  {drawerRow.companyName}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">
                  {drawerRow.domain ?? "—"} · {rowMarket(drawerRow) ?? "?"}
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
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <section>
                    <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                      Score
                    </h3>
                    <div className="flex items-center gap-2">
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
                      {engOpenings(drawerRow) != null && (
                        <span className="text-xs text-muted-foreground">
                          ~{engOpenings(drawerRow)} eng openings
                        </span>
                      )}
                    </div>
                    {drawerRow.whyNow && (
                      <p className="mt-2 text-sm">{drawerRow.whyNow}</p>
                    )}
                  </section>
                  {rowHunt(drawerRow) && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                        Encontrada via sinal
                      </h3>
                      <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm">
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Badge variant="outline" className="text-[10px]">
                            {rowHunt(drawerRow)!.source.replace(/_/g, " ")}
                          </Badge>
                          <span className="truncate">
                            busca: “{rowHunt(drawerRow)!.query}”
                          </span>
                        </div>
                        <blockquote className="mt-1.5 border-l-2 border-emerald-500/50 pl-2 text-xs italic">
                          “{rowHunt(drawerRow)!.quote}”
                        </blockquote>
                        <a
                          href={rowHunt(drawerRow)!.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 inline-flex items-center gap-1 text-xs text-emerald-700 underline-offset-2 hover:underline dark:text-emerald-400"
                        >
                          <ExternalLink className="size-3" />
                          {rowHunt(drawerRow)!.title ??
                            hostLabel(rowHunt(drawerRow)!.url)}
                        </a>
                      </div>
                    </section>
                  )}
                  {!rowHunt(drawerRow) && rowDiscovery(drawerRow)?.sourceUrl && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                        Origem
                      </h3>
                      <a
                        href={rowDiscovery(drawerRow)!.sourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                      >
                        <ExternalLink className="size-3" />
                        {hostLabel(rowDiscovery(drawerRow)!.sourceUrl!)}
                        {rowDiscovery(drawerRow)!.sourceQuery
                          ? ` — busca: “${rowDiscovery(drawerRow)!.sourceQuery}”`
                          : ""}
                      </a>
                    </section>
                  )}
                  <section>
                    <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                      Playbook checklist
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
                                e.status === "unknown" &&
                                  "bg-muted-foreground/40",
                              )}
                            />
                            <span className="text-xs capitalize text-muted-foreground">
                              {e.kind}
                            </span>
                            <span className="truncate font-mono text-[11px]">
                              {e.criterionId.replace(/_/g, " ")}
                            </span>
                          </div>
                          {e.evidence && (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {e.evidence}
                            </p>
                          )}
                          {e.sources.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                              {e.sources.slice(0, 4).map((s, i) => (
                                <a
                                  key={i}
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] text-primary underline-offset-2 hover:underline"
                                >
                                  <ExternalLink className="size-3" />
                                  {hostLabel(s.url)}
                                  {s.pack && s.pack !== "llm" ? (
                                    <span className="text-muted-foreground">
                                      ({s.pack})
                                    </span>
                                  ) : null}
                                </a>
                              ))}
                            </div>
                          )}
                          {e.confidence > 0 && (
                            <div className="mt-1 text-[10px] text-muted-foreground">
                              confiança {Math.round(e.confidence * 100)}%
                            </div>
                          )}
                        </li>
                      ))}
                      {evidence.length === 0 && (
                        <li className="text-xs text-muted-foreground">
                          Not scored yet.
                        </li>
                      )}
                    </ul>
                  </section>
                  <section>
                    <h3 className="mb-2 text-xs font-medium uppercase text-muted-foreground">
                      People
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {people.map((p, i) => (
                        <li key={i} className="rounded border px-2 py-1.5">
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {[p.role, p.email].filter(Boolean).join(" · ") ||
                              "—"}
                          </div>
                        </li>
                      ))}
                      {people.length === 0 && (
                        <li className="text-xs text-muted-foreground">
                          None yet
                        </li>
                      )}
                    </ul>
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-xs font-medium uppercase text-muted-foreground">
                      Ask
                    </h3>
                    <div className="flex gap-2">
                      <Input
                        placeholder="Use Playwright?"
                        value={aiPrompt}
                        onChange={(e) => setAiPrompt(e.target.value)}
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
        </>
      )}
    </div>
  );
}
