"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Check,
  Copy,
  Download,
  ExternalLink,
  Link2,
  Loader2,
  Mail,
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

type ResearchColumn = {
  key: string;
  label: string;
  type: string;
  enrich: { kind: string; prompt?: string; field?: string };
  order: number;
};

type ResearchCell = {
  value: string | number | boolean | null;
  status: string;
  evidence?: string | null;
  error?: string | null;
};

type ResearchTable = {
  id: string;
  name: string;
  slug?: string | null;
  rubricId: string;
  description: string | null;
  columns?: ResearchColumn[];
  rowCount?: number;
};

type Person = {
  id?: string;
  name: string;
  role: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedin?: string | null;
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
  people?: Person[];
  cells?: Record<string, ResearchCell>;
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

type Panel = "none" | "add" | "create" | "find";
type Market = "global" | "brazil";
type SizeBand = "any" | "small" | "mid" | "large";
type ContactFilter = "all" | "has" | "missing";

function topPerson(people: Person[] | undefined): Person | null {
  if (!people?.length) return null;
  const withEmail = people.find((p) => p.email?.trim());
  return withEmail ?? people[0] ?? null;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function ScorePill({
  score,
  pass,
}: {
  score: number | null;
  pass: boolean | null;
}) {
  if (score == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn(
        "inline-flex min-w-[2.5rem] items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-xs tabular-nums",
        pass === true &&
          "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
        pass === false && "bg-muted text-muted-foreground",
        pass == null && "bg-muted text-foreground",
      )}
    >
      {score}
    </span>
  );
}

function formatCell(cell: ResearchCell | undefined): string {
  if (!cell || cell.value == null || cell.value === "") {
    if (cell?.status === "running") return "…";
    if (cell?.status === "failed") return "err";
    return "—";
  }
  if (typeof cell.value === "boolean") return cell.value ? "yes" : "no";
  return String(cell.value);
}

export function ResearchPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tableFromUrl = searchParams.get("table");

  const [token, setToken] = useState<string | null>(null);
  const [tables, setTables] = useState<ResearchTable[]>([]);
  const [rubrics, setRubrics] = useState<Rubric[]>([]);
  const [tableId, setTableId] = useState<string | null>(null);
  const [rows, setRows] = useState<ResearchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [contactFilter, setContactFilter] = useState<ContactFilter>("all");
  const [query, setQuery] = useState("");
  const [importText, setImportText] = useState("");
  const [panel, setPanel] = useState<Panel>("none");
  const [newTableName, setNewTableName] = useState("");
  const [newRubric, setNewRubric] = useState("qe-kodus-v1");
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);

  const [market, setMarket] = useState<Market>("brazil");
  const [size, setSize] = useState<SizeBand>("mid");
  const [maxCompanies, setMaxCompanies] = useState("12");
  const [focus, setFocus] = useState("");

  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [drawerPeople, setDrawerPeople] = useState<Person[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
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
      // URL ?table=slug|id wins when valid
      if (tableFromUrl) {
        const hit = nextTables.find(
          (t) =>
            t.id === tableFromUrl ||
            t.slug === tableFromUrl ||
            t.name.toLowerCase() === tableFromUrl.toLowerCase(),
        );
        if (hit) return hit.id;
      }
      if (current && nextTables.some((t) => t.id === current)) return current;
      return nextTables[0]?.id ?? null;
    });
  }, [token, headers, tableFromUrl]);

  // Keep URL in sync with selected table (slug preferred)
  useEffect(() => {
    if (!tableId) return;
    const t = tables.find((x) => x.id === tableId);
    if (!t) return;
    const ref = t.slug || t.id;
    if (tableFromUrl === ref || tableFromUrl === t.id) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("table", ref);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [tableId, tables, tableFromUrl, pathname, router, searchParams]);

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
      // Keep column schema in sync (MCP may add columns)
      if (data.table) {
        setTables((prev) =>
          prev.map((t) =>
            t.id === tableId
              ? {
                  ...t,
                  ...data.table,
                  columns: data.table.columns ?? t.columns,
                  slug: data.table.slug ?? t.slug,
                }
              : t,
          ),
        );
      }
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
      await new Promise((r) => setTimeout(r, 4000));
      try {
        const res = await fetch(`/api/research/status?tableId=${tableId}`, {
          headers: headers(),
        });
        if (!res.ok) continue;
        const state = await res.json();
        if (state.running) {
          setNotice(state.lastSummary ?? "Working…");
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
    const name = `List ${new Date().toLocaleDateString("pt-BR")}`;
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
    setPanel("none");
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
      setNotice(`Added ${data.added} companies${data.skipped ? ` (${data.skipped} skipped)` : ""}.`);
      await loadRows();
      await loadTables();
    } finally {
      setImporting(false);
    }
  };

  const runJob = async (
    kind: "research" | "people" | "full",
    opts: { force?: boolean; onlyIfPass?: boolean } = {},
  ) => {
    if (!token || !tableId) return;
    const rowIds = selected.size > 0 ? [...selected] : undefined;
    const res = await fetch(`/api/research/tables/${tableId}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind,
        rowIds,
        force: Boolean(opts.force),
        // Clay default: enrich everyone unless caller restricts
        onlyIfPass: opts.onlyIfPass === true,
      }),
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
    setNotice(
      kind === "people"
        ? selected.size
          ? `Finding people on ${selected.size} selected…`
          : "Finding people on all rows…"
        : "Running…",
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
      setDrawerPeople(data.people ?? []);
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
        action === "people"
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
      const res = await fetch(`/api/research/tables/${tableId}/export`, {
        headers: headers(),
      });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `list-${tableId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    })();
  };

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      const p = topPerson(r.people);
      if (contactFilter === "has" && !p) return false;
      if (contactFilter === "missing" && p) return false;
      if (q) {
        const hay = [
          r.companyName,
          r.domain,
          r.whyNow,
          p?.name,
          p?.role,
          p?.email,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, contactFilter, query]);

  const activeTable = tables.find((t) => t.id === tableId) ?? null;
  const customColumns = useMemo(
    () =>
      [...(activeTable?.columns ?? [])].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    [activeTable?.columns],
  );
  const drawerRow = rows.find((r) => r.id === drawerRowId);
  const withContact = rows.filter((r) => topPerson(r.people)).length;
  const allSelected =
    filteredRows.length > 0 &&
    filteredRows.every((r) => selected.has(r.id));

  const copyTableRef = async () => {
    if (!activeTable) return;
    const ref = activeTable.slug || activeTable.id;
    const url =
      typeof window !== "undefined"
        ? `${window.location.origin}/research?table=${encodeURIComponent(ref)}`
        : `/research?table=${ref}`;
    try {
      await navigator.clipboard.writeText(
        `table_ref: ${ref}\nurl: ${url}`,
      );
      setNotice(`Copied table_ref=${ref} for MCP / Codex`);
    } catch {
      setNotice(`table_ref=${ref}`);
    }
  };

  if (!token) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Table tabs (workspace-style) */}
      <div className="flex items-center gap-1 border-b bg-muted/20 px-3 pt-2">
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {tables.map((t) => {
            const active = t.id === tableId;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTableId(t.id);
                  setSelected(new Set());
                  setDrawerRowId(null);
                }}
                className={cn(
                  "relative max-w-[220px] shrink-0 truncate rounded-t-md border border-b-0 px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "border-border bg-background font-medium text-foreground shadow-[0_-1px_0_0_hsl(var(--background))]"
                    : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <span className="truncate">{t.name}</span>
                {typeof t.rowCount === "number" && (
                  <span className="ml-1.5 text-[11px] tabular-nums text-muted-foreground">
                    {t.rowCount}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            onClick={() => setPanel("create")}
            className="mb-1 ml-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="New list"
            title="New list"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h1 className="truncate text-base font-semibold tracking-tight">
              {activeTable?.name ?? "Lists"}
            </h1>
            {activeTable && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {rows.length} companies · {withContact} with contact
                {filteredRows.length !== rows.length
                  ? ` · ${filteredRows.length} shown`
                  : ""}
                {selected.size > 0 ? ` · ${selected.size} selected` : ""}
                {activeTable.slug ? (
                  <button
                    type="button"
                    className="ml-2 inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] hover:bg-muted"
                    title="Copy slug + URL for Codex/MCP"
                    onClick={() => void copyTableRef()}
                  >
                    <Copy className="size-3" />
                    {activeTable.slug}
                  </button>
                ) : null}
              </span>
            )}
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 w-44 pl-8 text-sm md:w-56"
            placeholder="Search…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <Select
          value={contactFilter}
          onValueChange={(v) => setContactFilter(v as ContactFilter)}
        >
          <SelectTrigger className="h-8 w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All rows</SelectItem>
            <SelectItem value="has">Has contact</SelectItem>
            <SelectItem value="missing">Missing contact</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            disabled={running || !tableId || rows.length === 0}
            onClick={() => void runJob("people", { onlyIfPass: false })}
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Users className="size-3.5" />
            )}
            Find people
            {selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!tableId}
            onClick={() => setPanel("add")}
          >
            <Plus className="size-3.5" />
            Import
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!tableId || rows.length === 0}
            onClick={exportCsv}
          >
            <Download className="size-3.5" />
            Export
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="More">
                <MoreHorizontal className="size-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-52 p-1">
              <button
                type="button"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={running || !tableId}
                onClick={() => setPanel("find")}
              >
                Find ICP companies…
              </button>
              <button
                type="button"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={running || !tableId}
                onClick={() => void runJob("research")}
              >
                Score pending rows
              </button>
              <button
                type="button"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={running || !tableId}
                onClick={() => void runJob("research", { force: true })}
              >
                Re-score all
              </button>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-3 border-b bg-muted/30 px-4 py-2 text-sm">
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

      {/* Spreadsheet */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!activeTable && !loading ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              No lists yet. Create one and import companies, or find ICP leads.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => setPanel("create")}>
                <Plus className="size-3.5" />
                New list
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setPanel("find");
                }}
              >
                <Search className="size-3.5" />
                Find ICP
              </Button>
            </div>
          </div>
        ) : (
          <Table>
            <TableHeader className="sticky top-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <input
                    type="checkbox"
                    className="size-3.5"
                    checked={allSelected}
                    onChange={() => {
                      if (allSelected) setSelected(new Set());
                      else setSelected(new Set(filteredRows.map((r) => r.id)));
                    }}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="w-10 text-xs text-muted-foreground">
                  #
                </TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="hidden sm:table-cell">Domain</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead className="hidden md:table-cell">Role</TableHead>
                <TableHead className="hidden lg:table-cell">Email</TableHead>
                <TableHead className="w-12 hidden md:table-cell">LI</TableHead>
                {customColumns.map((col) => (
                  <TableHead
                    key={col.key}
                    className="min-w-[120px] max-w-[200px] text-xs"
                    title={`${col.key} · enrich=${col.enrich?.kind ?? "none"}`}
                  >
                    {col.label}
                  </TableHead>
                ))}
                <TableHead className="w-16">Score</TableHead>
                <TableHead className="hidden xl:table-cell max-w-[200px]">
                  Why now
                </TableHead>
                <TableHead className="w-24 pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={11 + customColumns.length}
                    className="h-24 text-center text-muted-foreground"
                  >
                    <Loader2 className="mr-2 inline size-4 animate-spin" />
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && filteredRows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={11 + customColumns.length}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    {rows.length === 0 ? (
                      <div className="space-y-2">
                        <p>Empty list. Import domains or find ICP companies.</p>
                        <div className="flex justify-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPanel("add")}
                          >
                            Import
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setPanel("find")}
                          >
                            Find ICP
                          </Button>
                        </div>
                      </div>
                    ) : (
                      "No rows match filters."
                    )}
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                filteredRows.map((r, idx) => {
                  const p = topPerson(r.people);
                  return (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer"
                      onClick={() => void openDrawer(r.id)}
                    >
                      <TableCell
                        className="pl-4"
                        onClick={(e) => e.stopPropagation()}
                      >
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
                      <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                        {idx + 1}
                      </TableCell>
                      <TableCell>
                        <div className="font-medium leading-tight">
                          {r.companyName}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground sm:hidden">
                          {r.domain ?? "—"}
                        </div>
                      </TableCell>
                      <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                        {r.domain ? (
                          <a
                            href={`https://${r.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.domain}
                            <ExternalLink className="size-3 opacity-50" />
                          </a>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        {p ? (
                          <span className="text-sm font-medium">{p.name}</span>
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="hidden max-w-[160px] truncate text-xs text-muted-foreground md:table-cell">
                        {p?.role ?? "—"}
                      </TableCell>
                      <TableCell
                        className="hidden max-w-[180px] truncate font-mono text-xs lg:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p?.email ? (
                          <a
                            href={`mailto:${p.email}`}
                            className="inline-flex items-center gap-1 text-foreground hover:underline"
                          >
                            <Mail className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{p.email}</span>
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell
                        className="hidden md:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p?.linkedin ? (
                          <a
                            href={p.linkedin}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex text-muted-foreground hover:text-foreground"
                            title={p.linkedin}
                          >
                            <Link2 className="size-3.5" />
                          </a>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      {customColumns.map((col) => {
                        const cell = r.cells?.[col.key];
                        const text = formatCell(cell);
                        const isUrl =
                          col.type === "url" &&
                          typeof cell?.value === "string" &&
                          /^https?:\/\//i.test(cell.value);
                        return (
                          <TableCell
                            key={col.key}
                            className="max-w-[200px] truncate text-xs"
                            title={
                              cell?.evidence ||
                              cell?.error ||
                              (cell?.value != null ? String(cell.value) : "")
                            }
                            onClick={(e) => {
                              if (isUrl) e.stopPropagation();
                            }}
                          >
                            {isUrl ? (
                              <a
                                href={String(cell!.value)}
                                target="_blank"
                                rel="noreferrer"
                                className="inline-flex items-center gap-1 text-primary hover:underline"
                              >
                                <Link2 className="size-3 shrink-0" />
                                <span className="truncate">
                                  {hostLabel(String(cell!.value))}
                                </span>
                              </a>
                            ) : (
                              <span
                                className={cn(
                                  cell?.status === "failed" && "text-rose-600",
                                  cell?.status === "running" &&
                                    "text-muted-foreground",
                                )}
                              >
                                {text}
                              </span>
                            )}
                          </TableCell>
                        );
                      })}
                      <TableCell>
                        <ScorePill score={r.icpScore} pass={r.pass} />
                      </TableCell>
                      <TableCell className="hidden max-w-[200px] xl:table-cell">
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {r.whyNow ??
                            (r.antiFlags?.length
                              ? `Anti: ${r.antiFlags.join(", ")}`
                              : "—")}
                        </span>
                      </TableCell>
                      <TableCell className="pr-4 text-xs text-muted-foreground">
                        {p ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <Check className="size-3" />
                            Contact
                          </span>
                        ) : r.status === "researching" ? (
                          "Scoring…"
                        ) : r.status === "pending" ? (
                          "Queued"
                        ) : r.status === "researched" ? (
                          "No contact"
                        ) : (
                          r.status
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Create list */}
      <Dialog
        open={panel === "create"}
        onOpenChange={(open) => setPanel(open ? "create" : "none")}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New list</DialogTitle>
            <DialogDescription>
              A spreadsheet of companies you can import and enrich.
            </DialogDescription>
          </DialogHeader>
          <Input
            placeholder="e.g. QA leads LATAM"
            value={newTableName}
            onChange={(e) => setNewTableName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createTable();
            }}
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

      {/* Import */}
      <Dialog
        open={panel === "add"}
        onOpenChange={(open) => setPanel(open ? "add" : "none")}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import companies</DialogTitle>
            <DialogDescription>
              One domain or company per line. Then run{" "}
              <strong>Find people</strong> to enrich contacts.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={8}
            className="font-mono text-sm"
            placeholder={"finnet.com.br\ncasar.com\npagbrasil.com"}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button
              disabled={!importText.trim() || importing || !tableId}
              onClick={() => void importDomains()}
            >
              {importing ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Add to list"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Find ICP (secondary) */}
      <Dialog
        open={panel === "find"}
        onOpenChange={(open) => setPanel(open ? "find" : "none")}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Find ICP companies</DialogTitle>
            <DialogDescription>
              Optional discovery from public job boards. Prefer importing your
              own list when you already have targets.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
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
                  <SelectItem value="brazil">Brazil</SelectItem>
                  <SelectItem value="global">Global</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Size
              </label>
              <Select
                value={size}
                onValueChange={(v) => setSize(v as SizeBand)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mid">Mid</SelectItem>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                  <SelectItem value="any">Any</SelectItem>
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
                  <SelectItem value="6">6</SelectItem>
                  <SelectItem value="12">12</SelectItem>
                  <SelectItem value="20">20</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Focus
              </label>
              <Input
                placeholder="fintech, Playwright…"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPanel("none")}>
              Cancel
            </Button>
            <Button disabled={running} onClick={() => void runFind()}>
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Search className="size-4" />
              )}
              Find &amp; score
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Row drawer */}
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
                  {drawerRow.domain ?? "—"}
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
                variant="secondary"
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
                variant="outline"
                disabled={actionBusy}
                onClick={() =>
                  void rowAction(drawerRowId, "qualify", { force: true })
                }
              >
                Score
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
              {drawerLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <section>
                    <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      People
                    </h3>
                    <ul className="space-y-1.5 text-sm">
                      {(drawerPeople.length
                        ? drawerPeople
                        : drawerRow.people ?? []
                      ).map((p, i) => (
                        <li
                          key={p.id ?? i}
                          className="rounded-md border px-2.5 py-2"
                        >
                          <div className="font-medium">{p.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {[p.role, p.email].filter(Boolean).join(" · ") ||
                              "—"}
                          </div>
                          {p.linkedin && (
                            <a
                              href={p.linkedin}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              <Link2 className="size-3" />
                              LinkedIn
                            </a>
                          )}
                        </li>
                      ))}
                      {(drawerPeople.length
                        ? drawerPeople
                        : drawerRow.people ?? []
                      ).length === 0 && (
                        <li className="text-xs text-muted-foreground">
                          No contacts yet. Run Find people.
                        </li>
                      )}
                    </ul>
                  </section>

                  {(drawerRow.whyNow || drawerRow.icpScore != null) && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Context
                      </h3>
                      <div className="flex items-center gap-2">
                        <ScorePill
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
                      </div>
                      {drawerRow.whyNow && (
                        <p className="mt-2 text-sm text-muted-foreground">
                          {drawerRow.whyNow}
                        </p>
                      )}
                    </section>
                  )}

                  {evidence.length > 0 && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Evidence
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
                              <span className="truncate font-mono text-[11px]">
                                {e.criterionId.replace(/_/g, " ")}
                              </span>
                            </div>
                            {e.evidence && (
                              <p className="mt-1 text-xs text-muted-foreground">
                                {e.evidence}
                              </p>
                            )}
                            {e.sources[0] && (
                              <a
                                href={e.sources[0].url}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                              >
                                <ExternalLink className="size-3" />
                                {hostLabel(e.sources[0].url)}
                              </a>
                            )}
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}
                </>
              )}
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
