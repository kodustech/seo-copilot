"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Check,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  History,
  Link2,
  Loader2,
  Mail,
  MoreHorizontal,
  Play,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
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
import { Switch } from "@/components/ui/switch";

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
/** Grid unit: companies (1 row = account) or people (1 row = contact). */
type ViewMode = "companies" | "people";

type PersonFlat = {
  key: string;
  personId?: string;
  rowId: string;
  companyName: string;
  domain: string | null;
  name: string;
  role: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedin: string | null;
  companyStatus: string;
  icpScore: number | null;
  pass: boolean | null;
  whyNow: string | null;
};

function topPerson(people: Person[] | undefined): Person | null {
  if (!people?.length) return null;
  const withEmail = people.find((p) => p.email?.trim());
  return withEmail ?? people[0] ?? null;
}

function personFlatKey(rowId: string, person: Person, index: number): string {
  return person.id?.trim() || `${rowId}::${index}`;
}

function defaultViewMode(name: string, slug?: string | null): ViewMode {
  const s = `${name} ${slug ?? ""}`.toLowerCase();
  if (/people|person|contact|lead/.test(s)) return "people";
  return "companies";
}

/** Map person-row selection keys → unique company research_row ids. */
function companyIdsFromPersonSelection(
  selected: Set<string>,
  rows: ResearchRow[],
): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    const people = r.people ?? [];
    people.forEach((p, i) => {
      if (selected.has(personFlatKey(r.id, p, i))) ids.add(r.id);
    });
  }
  return [...ids];
}

function flattenPeople(rows: ResearchRow[]): PersonFlat[] {
  const out: PersonFlat[] = [];
  for (const r of rows) {
    const people = r.people ?? [];
    people.forEach((p, i) => {
      out.push({
        key: personFlatKey(r.id, p, i),
        personId: p.id,
        rowId: r.id,
        companyName: r.companyName,
        domain: r.domain,
        name: p.name,
        role: p.role,
        email: p.email,
        emailStatus: p.emailStatus,
        linkedin: p.linkedin ?? null,
        companyStatus: r.status,
        icpScore: r.icpScore,
        pass: r.pass,
        whyNow: r.whyNow,
      });
    });
  }
  return out;
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

/** Honest labels — never imply unknown is “good”. */
function emailStatusHint(
  status: string | null | undefined,
  hasEmail: boolean,
): string | null {
  if (!hasEmail) return null;
  const s = (status ?? "").toLowerCase();
  if (s === "valid") return "valid";
  if (s === "invalid") return "invalid";
  if (s === "bounced") return "bounced";
  if (s === "catchall") return "catchall";
  if (s === "disposable") return "disposable";
  if (s === "unverified" || s === "unknown" || !s) return "unverified";
  if (s === "config_missing" || s === "error") return "unverified";
  return s;
}

function emailStatusClass(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  if (s === "valid") return "text-emerald-600 dark:text-emerald-400";
  if (s === "invalid" || s === "bounced") return "text-rose-600 dark:text-rose-400";
  if (s === "catchall") return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
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
  const [viewMode, setViewMode] = useState<ViewMode>("companies");
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
  const [peopleSnapshots, setPeopleSnapshots] = useState<
    Array<{
      id: string;
      reason: string;
      personCount: number;
      createdAt: string;
      people: Array<{ name?: string; email?: string | null }>;
    }>
  >([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  /** Editable multi-person drafts in the drawer */
  const [editPeople, setEditPeople] = useState<
    Array<{
      key: string;
      name: string;
      role: string;
      email: string;
      linkedin: string;
    }>
  >([]);
  const [savingContact, setSavingContact] = useState(false);

  /** Pack ICP score / why-now — off by default; use dynamic AI columns instead */
  const [showIcpMeta, setShowIcpMeta] = useState(false);
  const [columnDialogOpen, setColumnDialogOpen] = useState(false);
  const [colLabel, setColLabel] = useState("");
  const [colType, setColType] = useState<"text" | "url" | "email" | "boolean" | "number">(
    "text",
  );
  const [colEnrichKind, setColEnrichKind] = useState<"ai" | "people_field" | "none">(
    "ai",
  );
  const [colPrompt, setColPrompt] = useState("");
  const [colPeopleField, setColPeopleField] = useState<
    "linkedin" | "email" | "name" | "role"
  >("linkedin");
  const [colRunNow, setColRunNow] = useState(true);
  const [colBusy, setColBusy] = useState(false);
  const [runningColumnKey, setRunningColumnKey] = useState<string | null>(null);
  const [emailBusyKey, setEmailBusyKey] = useState<string | null>(null);

  const emptyPersonDraft = () => ({
    key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name: "",
    role: "",
    email: "",
    linkedin: "",
  });

  const peopleToDrafts = (ppl: Person[]) => {
    if (ppl.length === 0) return [emptyPersonDraft()];
    return ppl.map((p, i) => ({
      key: p.id ?? `p-${i}-${p.name}`,
      name: p.name ?? "",
      role: p.role ?? "",
      email: p.email ?? "",
      linkedin: p.linkedin ?? "",
    }));
  };

  useEffect(() => {
    supabase?.auth.getSession().then(({ data }) => {
      setToken(data.session?.access_token ?? null);
    });
  }, [supabase]);

  useEffect(() => {
    try {
      const v = localStorage.getItem("research.showIcpMeta");
      if (v === "1") setShowIcpMeta(true);
    } catch {
      // ignore
    }
  }, []);

  // Per-list view preference (people vs companies)
  useEffect(() => {
    if (!tableId) return;
    const t = tables.find((x) => x.id === tableId);
    try {
      const saved = localStorage.getItem(`research.viewMode.${tableId}`);
      if (saved === "people" || saved === "companies") {
        setViewMode(saved);
        return;
      }
    } catch {
      // ignore
    }
    setViewMode(defaultViewMode(t?.name ?? "", t?.slug));
  }, [tableId, tables]);

  const toggleIcpMeta = (on: boolean) => {
    setShowIcpMeta(on);
    try {
      localStorage.setItem("research.showIcpMeta", on ? "1" : "0");
    } catch {
      // ignore
    }
  };

  const changeViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    setSelected(new Set());
    if (tableId) {
      try {
        localStorage.setItem(`research.viewMode.${tableId}`, mode);
      } catch {
        // ignore
      }
    }
  };

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
    const name = `List ${new Date().toLocaleDateString("en-US")}`;
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
    // Always company row ids for API (map from people selection when needed)
    const companyIds =
      selected.size > 0
        ? viewMode === "people"
          ? companyIdsFromPersonSelection(selected, rows)
          : [...selected]
        : undefined;
    const res = await fetch(`/api/research/tables/${tableId}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        kind,
        rowIds: companyIds,
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
    const n = companyIds?.length ?? 0;
    setNotice(
      kind === "people"
        ? n
          ? `Finding people on ${n} compan${n === 1 ? "y" : "ies"}…`
          : "Finding people on all rows…"
        : "Running…",
    );
    void pollUntilDone();
  };

  const openDrawer = async (rowId: string) => {
    if (!token) return;
    setDrawerRowId(rowId);
    setDrawerLoading(true);
    setHistoryOpen(false);
    setPeopleSnapshots([]);
    try {
      const res = await fetch(`/api/research/rows/${rowId}`, {
        headers: headers(),
      });
      if (!res.ok) return;
      const data = await res.json();
      setEvidence(data.evidence ?? []);
      const ppl = (data.people ?? []) as Person[];
      setDrawerPeople(ppl);
      setEditPeople(peopleToDrafts(ppl));
    } finally {
      setDrawerLoading(false);
    }
  };

  const loadPeopleHistory = async () => {
    if (!token || !drawerRowId) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/research/rows/${drawerRowId}/actions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ action: "people_history", limit: 30 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Could not load history");
        return;
      }
      setPeopleSnapshots(
        ((data.snapshots ?? []) as Array<Record<string, unknown>>).map((s) => ({
          id: String(s.id),
          reason: String(s.reason ?? "save"),
          personCount: Number(s.personCount ?? s.person_count ?? 0),
          createdAt: String(s.createdAt ?? s.created_at ?? ""),
          people: (s.people as Array<{ name?: string; email?: string | null }>) ?? [],
        })),
      );
      setHistoryOpen(true);
    } finally {
      setHistoryLoading(false);
    }
  };

  const restorePeopleVersion = async (snapshotId: string) => {
    if (!token || !drawerRowId) return;
    if (
      !confirm(
        "Restore this contacts version? Current list is snapshotted first so you can undo.",
      )
    ) {
      return;
    }
    setRestoringId(snapshotId);
    try {
      const res = await fetch(`/api/research/rows/${drawerRowId}/actions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "people_restore",
          snapshot_id: snapshotId,
          mode: "replace",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Restore failed");
        return;
      }
      const ppl = (data.people ?? []) as Person[];
      setDrawerPeople(ppl);
      setEditPeople(peopleToDrafts(ppl));
      setNotice(`Restored ${data.count ?? ppl.length} contacts from history`);
      await loadRows();
      await loadPeopleHistory();
    } finally {
      setRestoringId(null);
    }
  };

  const saveContacts = async () => {
    if (!token || !drawerRowId) return;
    const cleaned = editPeople
      .map((p) => ({
        name: p.name.trim(),
        role: p.role.trim() || null,
        email: p.email.trim() || null,
        linkedin: p.linkedin.trim() || null,
      }))
      .filter((p) => p.name.length > 0);
    if (cleaned.length === 0) {
      setNotice("Add at least one person with a name");
      return;
    }
    setSavingContact(true);
    try {
      const res = await fetch(`/api/research/rows/${drawerRowId}/actions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "upsert_people",
          people: cleaned,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Failed to save contacts");
        return;
      }
      const ppl = (data.people ?? []) as Person[];
      setDrawerPeople(ppl);
      setEditPeople(peopleToDrafts(ppl));
      setNotice(
        cleaned.length === 1
          ? "Contact saved"
          : `${cleaned.length} contacts saved`,
      );
      await loadRows();
    } finally {
      setSavingContact(false);
    }
  };

  const updateEditPerson = (
    key: string,
    field: "name" | "role" | "email" | "linkedin",
    value: string,
  ) => {
    setEditPeople((prev) =>
      prev.map((p) => (p.key === key ? { ...p, [field]: value } : p)),
    );
  };

  const addEditPerson = () => {
    setEditPeople((prev) => [...prev, emptyPersonDraft()]);
  };

  const removeEditPerson = (key: string) => {
    setEditPeople((prev) => {
      const next = prev.filter((p) => p.key !== key);
      return next.length === 0 ? [emptyPersonDraft()] : next;
    });
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

  /** Find + verify work email for one person (empty email cell shortcut). */
  const findEmailForPerson = async (opts: {
    rowId: string;
    personId?: string;
    personName: string;
    busyKey: string;
  }) => {
    if (!token) return;
    setEmailBusyKey(opts.busyKey);
    try {
      const res = await fetch(`/api/research/rows/${opts.rowId}/actions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "find_email",
          personId: opts.personId,
          personName: opts.personName,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Email lookup failed");
        return;
      }
      setNotice(data.message ?? (data.found ? "Email found" : "No email found"));
      if (drawerRowId === opts.rowId) await openDrawer(opts.rowId);
      await loadRows();
    } finally {
      setEmailBusyKey(null);
    }
  };

  const exportCsv = () => {
    if (!token || !tableId) return;
    if (viewMode === "people") {
      const people =
        selected.size > 0
          ? flattenPeople(rows).filter((p) => selected.has(p.key))
          : flattenPeople(rows);
      const header = [
        "name",
        "role",
        "email",
        "linkedin",
        "company",
        "domain",
      ];
      const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
      const lines = [
        header.join(","),
        ...people.map((p) =>
          [
            p.name,
            p.role ?? "",
            p.email ?? "",
            p.linkedin ?? "",
            p.companyName,
            p.domain ?? "",
          ]
            .map((c) => esc(String(c)))
            .join(","),
        ),
      ];
      const blob = new Blob([lines.join("\n")], {
        type: "text/csv;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `people-${tableId.slice(0, 8)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
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
          ...(r.people ?? []).flatMap((x) => [x.name, x.role, x.email]),
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, contactFilter, query]);

  const flatPeople = useMemo(() => flattenPeople(rows), [rows]);

  const filteredPeople = useMemo(() => {
    const q = query.trim().toLowerCase();
    return flatPeople.filter((p) => {
      if (contactFilter === "has" && !p.email?.trim()) return false;
      if (contactFilter === "missing" && p.email?.trim()) return false;
      if (q) {
        const hay = [p.name, p.role, p.email, p.companyName, p.domain, p.linkedin]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [flatPeople, contactFilter, query]);

  const activeTable = tables.find((t) => t.id === tableId) ?? null;
  const customColumns = useMemo(
    () =>
      [...(activeTable?.columns ?? [])].sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0),
      ),
    [activeTable?.columns],
  );

  /** Company row ids for bulk APIs, regardless of view. */
  const selectedCompanyIds = useMemo(() => {
    if (selected.size === 0) return [] as string[];
    if (viewMode === "companies") return [...selected];
    return companyIdsFromPersonSelection(selected, rows);
  }, [selected, viewMode, rows]);

  /** Move selected companies to a new or existing list. */
  const moveSelectedToList = async () => {
    if (!token || !tableId || !activeTable) return;
    if (selected.size === 0) {
      setNotice(
        viewMode === "people"
          ? "Select people first (their companies will be moved)."
          : "Select the companies you want to move first (checkboxes).",
      );
      return;
    }
    const ids =
      viewMode === "people"
        ? companyIdsFromPersonSelection(selected, rows)
        : [...selected];
    if (ids.length === 0) {
      setNotice("Nothing to move.");
      return;
    }

    const others = tables.filter((t) => t.id !== tableId);
    const peopleNote =
      viewMode === "people" && selected.size !== ids.length
        ? ` (${selected.size} people → ${ids.length} companies)`
        : "";
    const choice = window.prompt(
      `Move ${ids.length} compan${ids.length === 1 ? "y" : "ies"}${peopleNote}:\n\n` +
        `• Type a NEW list name, or\n` +
        `• Existing list slug/id:\n` +
        others
          .slice(0, 12)
          .map((t) => `  - ${t.slug || t.id.slice(0, 8)}  (${t.name})`)
          .join("\n") +
        (others.length > 12 ? "\n  …" : "") +
        `\n\nCancel = empty.`,
      `${activeTable.name} — moved`,
    );
    if (choice == null || !choice.trim()) return;

    const dest = choice.trim();
    const existing = tables.find(
      (t) =>
        t.id === dest ||
        t.slug === dest ||
        t.name.toLowerCase() === dest.toLowerCase(),
    );

    setActionBusy(true);
    try {
      const res = await fetch(`/api/research/tables/${tableId}/split`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify(
          existing
            ? {
                mode: "move",
                row_ids: ids,
                target_table_id: existing.id,
              }
            : {
                mode: "move",
                row_ids: ids,
                new_table_name: dest,
              },
        ),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Move failed");
        return;
      }
      setNotice(
        `Moved ${data.moved ?? 0} → “${data.target?.name ?? dest}”` +
          (data.skipped ? ` (${data.skipped} already there)` : ""),
      );
      setSelected(new Set());
      await loadTables();
      if (data.target?.id) setTableId(data.target.id);
      await loadRows();
    } finally {
      setActionBusy(false);
    }
  };

  const resetColumnForm = () => {
    setColLabel("");
    setColType("text");
    setColEnrichKind("ai");
    setColPrompt("");
    setColPeopleField("linkedin");
    setColRunNow(true);
  };

  const runDynamicColumn = async (
    key: string,
    opts?: { onlyMissing?: boolean; rowIds?: string[] },
  ) => {
    if (!token || !tableId) return;
    setRunningColumnKey(key);
    setActionBusy(true);
    try {
      const res = await fetch(`/api/research/tables/${tableId}/columns`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          action: "run",
          key,
          onlyMissing: opts?.onlyMissing !== false,
          rowIds: opts?.rowIds,
          maxRows: opts?.rowIds?.length
            ? Math.min(opts.rowIds.length, 50)
            : 30,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Column run failed");
        return;
      }
      setNotice(
        `Column “${data.column?.label ?? key}”: ${data.ok ?? 0} filled` +
          (data.failed ? `, ${data.failed} failed` : "") +
          (data.skipped ? `, ${data.skipped} skipped` : ""),
      );
      await loadRows();
    } finally {
      setRunningColumnKey(null);
      setActionBusy(false);
    }
  };

  const createDynamicColumn = async () => {
    if (!token || !tableId) return;
    const label = colLabel.trim();
    if (!label) {
      setNotice("Column name is required");
      return;
    }
    if (colEnrichKind === "ai" && !colPrompt.trim()) {
      setNotice("AI columns need a prompt (what to fill for each company)");
      return;
    }

    setColBusy(true);
    try {
      const enrich =
        colEnrichKind === "ai"
          ? { kind: "ai" as const, prompt: colPrompt.trim() }
          : colEnrichKind === "people_field"
            ? {
                kind: "people_field" as const,
                field: colPeopleField,
                runPeopleIfMissing: true,
              }
            : { kind: "none" as const };

      const res = await fetch(`/api/research/tables/${tableId}/columns`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          label,
          type: colType,
          enrich,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Could not create column");
        return;
      }
      const key = data.column?.key as string | undefined;
      setColumnDialogOpen(false);
      resetColumnForm();
      await loadTables();
      setNotice(`Column “${label}” added`);
      if (colRunNow && key && colEnrichKind !== "none") {
        await runDynamicColumn(key, {
          onlyMissing: true,
          rowIds:
            selectedCompanyIds.length > 0 ? selectedCompanyIds : undefined,
        });
      }
    } finally {
      setColBusy(false);
    }
  };

  const deleteDynamicColumn = async (key: string, label: string) => {
    if (!token || !tableId) return;
    if (
      !window.confirm(
        `Delete column “${label}”? Cell values for this column will be removed.`,
      )
    ) {
      return;
    }
    setActionBusy(true);
    try {
      const res = await fetch(
        `/api/research/tables/${tableId}/columns?key=${encodeURIComponent(key)}`,
        { method: "DELETE", headers: headers() },
      );
      const data = await res.json();
      if (!res.ok) {
        setNotice(data.error ?? "Could not delete column");
        return;
      }
      setNotice(`Deleted column “${label}”`);
      await loadTables();
      await loadRows();
    } finally {
      setActionBusy(false);
    }
  };

  const drawerRow = rows.find((r) => r.id === drawerRowId);
  const withContact = rows.filter((r) => topPerson(r.people)).length;
  const companiesWithoutPeople = rows.filter(
    (r) => !(r.people && r.people.length > 0),
  ).length;
  const allSelected =
    viewMode === "people"
      ? filteredPeople.length > 0 &&
        filteredPeople.every((p) => selected.has(p.key))
      : filteredRows.length > 0 &&
        filteredRows.every((r) => selected.has(r.id));
  const tableColSpan =
    viewMode === "people"
      ? 9 + (showIcpMeta ? 1 : 0)
      : 9 + customColumns.length + (showIcpMeta ? 2 : 0);

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
      {/* List picker — no horizontal tab scroll */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/15 px-4 py-2.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          List
        </span>
        <Select
          value={tableId ?? undefined}
          onValueChange={(v) => {
            setTableId(v);
            setSelected(new Set());
            setDrawerRowId(null);
          }}
        >
          <SelectTrigger className="h-9 w-full max-w-md sm:w-[min(28rem,100%)]">
            <SelectValue placeholder="Select a list…" />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {tables.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                <span className="truncate">
                  {t.name}
                  {typeof t.rowCount === "number" ? (
                    <span className="ml-1.5 text-muted-foreground">
                      ({t.rowCount})
                    </span>
                  ) : null}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setPanel("create")}
          className="shrink-0"
        >
          <Plus className="size-3.5" />
          New list
        </Button>
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
                {viewMode === "people" ? (
                  <>
                    {flatPeople.length} people · {rows.length} companies
                    {companiesWithoutPeople > 0
                      ? ` · ${companiesWithoutPeople} w/o people`
                      : ""}
                    {filteredPeople.length !== flatPeople.length
                      ? ` · ${filteredPeople.length} shown`
                      : ""}
                  </>
                ) : (
                  <>
                    {rows.length} companies · {withContact} with contact
                    {filteredRows.length !== rows.length
                      ? ` · ${filteredRows.length} shown`
                      : ""}
                  </>
                )}
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

        <div className="inline-flex h-8 items-center rounded-md border bg-muted/40 p-0.5">
          <button
            type="button"
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
              viewMode === "people"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => changeViewMode("people")}
          >
            People
          </button>
          <button
            type="button"
            className={cn(
              "rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
              viewMode === "companies"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            onClick={() => changeViewMode("companies")}
          >
            Companies
          </button>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 w-44 pl-8 text-sm md:w-56"
            placeholder={
              viewMode === "people"
                ? "Search name, role, email…"
                : "Search company…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <Select
          value={contactFilter}
          onValueChange={(v) => setContactFilter(v as ContactFilter)}
        >
          <SelectTrigger className="h-8 w-[150px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {viewMode === "people" ? "All people" : "All companies"}
            </SelectItem>
            <SelectItem value="has">
              {viewMode === "people" ? "Has email" : "Has contact"}
            </SelectItem>
            <SelectItem value="missing">
              {viewMode === "people" ? "Missing email" : "Missing contact"}
            </SelectItem>
          </SelectContent>
        </Select>

        <div className="flex flex-wrap gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={!tableId}
            onClick={() => {
              resetColumnForm();
              setColumnDialogOpen(true);
            }}
          >
            <Columns3 className="size-3.5" />
            Add column
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
            <PopoverContent align="end" className="w-64 p-1">
              <button
                type="button"
                className="flex w-full flex-col rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                disabled={running || !tableId || rows.length === 0}
                onClick={() => void runJob("people", { onlyIfPass: false })}
              >
                <span className="inline-flex items-center gap-2">
                  {running ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Users className="size-3.5" />
                  )}
                  Enrich contacts
                  {selectedCompanyIds.length > 0
                    ? ` (${selectedCompanyIds.length} co.)`
                    : companiesWithoutPeople > 0
                      ? ` · ${companiesWithoutPeople} empty`
                      : ""}
                </span>
                <span className="pl-5 text-[11px] text-muted-foreground">
                  Find people on companies (waterfall)
                </span>
              </button>
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
                disabled={
                  actionBusy || running || !tableId || selected.size === 0
                }
                onClick={() => void moveSelectedToList()}
              >
                Move selected
                {selectedCompanyIds.length > 0
                  ? ` (${selectedCompanyIds.length} co.)`
                  : ""}{" "}
                to list…
              </button>
              <div className="my-1 border-t" />
              <div className="flex items-center justify-between gap-2 px-2 py-1.5">
                <label
                  htmlFor="show-icp-meta"
                  className="text-sm leading-tight"
                >
                  Show pack score &amp; why
                </label>
                <Switch
                  id="show-icp-meta"
                  checked={showIcpMeta}
                  onCheckedChange={toggleIcpMeta}
                />
              </div>
              <button
                type="button"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={running || !tableId}
                onClick={() => void runJob("research")}
              >
                Run pack score (pending)
              </button>
              <button
                type="button"
                className="flex w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                disabled={running || !tableId}
                onClick={() => void runJob("research", { force: true })}
              >
                Re-run pack score (all)
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
        ) : viewMode === "people" ? (
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
                      else
                        setSelected(
                          new Set(filteredPeople.map((p) => p.key)),
                        );
                    }}
                    aria-label="Select all people"
                  />
                </TableHead>
                <TableHead className="w-10 text-xs text-muted-foreground">
                  #
                </TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Role</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="w-12">LI</TableHead>
                <TableHead>Company</TableHead>
                <TableHead className="hidden sm:table-cell">Domain</TableHead>
                {showIcpMeta && (
                  <TableHead className="w-16 text-xs text-muted-foreground">
                    Score
                  </TableHead>
                )}
                <TableHead className="w-20 pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={tableColSpan}
                    className="h-24 text-center text-muted-foreground"
                  >
                    <Loader2 className="mr-2 inline size-4 animate-spin" />
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && filteredPeople.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={tableColSpan}
                    className="h-32 text-center text-sm text-muted-foreground"
                  >
                    {rows.length === 0 ? (
                      <div className="space-y-2">
                        <p>Empty list. Import companies first.</p>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setPanel("add")}
                        >
                          Import
                        </Button>
                      </div>
                    ) : flatPeople.length === 0 ? (
                      <div className="space-y-2">
                        <p>
                          No contacts yet. Enrich companies to find people, or
                          switch to Companies view.
                        </p>
                        <div className="flex justify-center gap-2">
                          <Button
                            size="sm"
                            onClick={() =>
                              void runJob("people", { onlyIfPass: false })
                            }
                            disabled={running}
                          >
                            <Users className="size-3.5" />
                            Enrich contacts
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => changeViewMode("companies")}
                          >
                            Companies view
                          </Button>
                        </div>
                      </div>
                    ) : (
                      "No people match filters."
                    )}
                  </TableCell>
                </TableRow>
              )}
              {!loading &&
                filteredPeople.map((p, idx) => (
                  <TableRow
                    key={p.key}
                    className="cursor-pointer"
                    onClick={() => void openDrawer(p.rowId)}
                  >
                    <TableCell
                      className="pl-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5"
                        checked={selected.has(p.key)}
                        onChange={() => {
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (next.has(p.key)) next.delete(p.key);
                            else next.add(p.key);
                            return next;
                          });
                        }}
                        aria-label={`Select ${p.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">
                      {idx + 1}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium leading-tight">{p.name}</div>
                      <div className="text-[11px] text-muted-foreground md:hidden">
                        {p.role ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="hidden max-w-[180px] truncate text-xs text-muted-foreground md:table-cell">
                      {p.role ?? "—"}
                    </TableCell>
                    <TableCell
                      className="max-w-[220px] font-mono text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {p.email ? (
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <a
                            href={`mailto:${p.email}`}
                            className="inline-flex min-w-0 items-center gap-1 text-foreground hover:underline"
                          >
                            <Mail className="size-3 shrink-0 text-muted-foreground" />
                            <span className="truncate">{p.email}</span>
                          </a>
                          {emailStatusHint(p.emailStatus, true) && (
                            <span
                              className={cn(
                                "text-[10px] font-medium uppercase tracking-wide",
                                emailStatusClass(p.emailStatus),
                              )}
                              title={
                                p.emailStatus === "valid"
                                  ? "Mailbox confirmed"
                                  : p.emailStatus === "catchall"
                                    ? "Domain accepts any address — not person-proof"
                                    : p.emailStatus === "bounced"
                                      ? "Hard bounce from a real send"
                                      : "Could not prove this inbox exists"
                              }
                            >
                              {emailStatusHint(p.emailStatus, true)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-foreground/30 hover:bg-muted hover:text-foreground disabled:opacity-50"
                          disabled={
                            emailBusyKey === p.key ||
                            actionBusy ||
                            !p.name.trim()
                          }
                          title="Find work email (only saves when proven valid or strong provider hit)"
                          onClick={() =>
                            void findEmailForPerson({
                              rowId: p.rowId,
                              personId: p.personId,
                              personName: p.name,
                              busyKey: p.key,
                            })
                          }
                        >
                          {emailBusyKey === p.key ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Mail className="size-3" />
                          )}
                          Find email
                        </button>
                      )}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {p.linkedin ? (
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
                    <TableCell>
                      <div className="truncate text-sm font-medium">
                        {p.companyName}
                      </div>
                      <div className="font-mono text-[11px] text-muted-foreground sm:hidden">
                        {p.domain ?? "—"}
                      </div>
                    </TableCell>
                    <TableCell className="hidden font-mono text-xs text-muted-foreground sm:table-cell">
                      {p.domain ? (
                        <a
                          href={`https://${p.domain}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 hover:text-foreground hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.domain}
                          <ExternalLink className="size-3 opacity-50" />
                        </a>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                    {showIcpMeta && (
                      <TableCell>
                        <ScorePill score={p.icpScore} pass={p.pass} />
                      </TableCell>
                    )}
                    <TableCell className="pr-4 text-xs text-muted-foreground">
                      {p.email ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 text-xs",
                            p.emailStatus === "valid"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-muted-foreground",
                          )}
                        >
                          {p.emailStatus === "valid" ? (
                            <Check className="size-3" />
                          ) : null}
                          {emailStatusHint(p.emailStatus, true) ?? "email"}
                        </span>
                      ) : p.linkedin ? (
                        "LI only"
                      ) : (
                        "No email"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
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
                    className="min-w-[140px] max-w-[220px] p-1 text-xs"
                  >
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className="flex w-full max-w-[200px] items-center gap-1 rounded-md px-1.5 py-1 text-left font-medium hover:bg-muted"
                          title={`${col.key} · ${col.enrich?.kind ?? "none"}`}
                        >
                          {col.enrich?.kind === "ai" && (
                            <Sparkles className="size-3 shrink-0 text-amber-600 dark:text-amber-400" />
                          )}
                          <span className="truncate">{col.label}</span>
                          {runningColumnKey === col.key ? (
                            <Loader2 className="ml-auto size-3 shrink-0 animate-spin" />
                          ) : (
                            <MoreHorizontal className="ml-auto size-3 shrink-0 opacity-50" />
                          )}
                        </button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-56 p-1">
                        <p className="truncate px-2 py-1 text-[11px] text-muted-foreground">
                          {col.enrich?.kind === "ai"
                            ? col.enrich.prompt?.slice(0, 80) || "AI column"
                            : col.enrich?.kind === "people_field"
                              ? `People · ${col.enrich.field}`
                              : "Manual column"}
                        </p>
                        {col.enrich?.kind !== "none" && (
                          <>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                              disabled={actionBusy || running}
                              onClick={() =>
                                void runDynamicColumn(col.key, {
                                  onlyMissing: true,
                                })
                              }
                            >
                              <Play className="size-3.5" />
                              Fill empty cells
                            </button>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50"
                              disabled={
                                actionBusy || running || selected.size === 0
                              }
                              onClick={() =>
                                void runDynamicColumn(col.key, {
                                  onlyMissing: false,
                                  rowIds: selectedCompanyIds,
                                })
                              }
                            >
                              <Play className="size-3.5" />
                              Run on selected
                              {selectedCompanyIds.length > 0
                                ? ` (${selectedCompanyIds.length})`
                                : ""}
                            </button>
                          </>
                        )}
                        <div className="my-1 border-t" />
                        <button
                          type="button"
                          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm text-rose-600 hover:bg-accent dark:text-rose-400 disabled:opacity-50"
                          disabled={actionBusy}
                          onClick={() =>
                            void deleteDynamicColumn(col.key, col.label)
                          }
                        >
                          <Trash2 className="size-3.5" />
                          Delete column
                        </button>
                      </PopoverContent>
                    </Popover>
                  </TableHead>
                ))}
                {showIcpMeta && (
                  <>
                    <TableHead
                      className="w-16 text-xs text-muted-foreground"
                      title="From pack rubric score — optional. Prefer AI columns."
                    >
                      Score
                    </TableHead>
                    <TableHead
                      className="hidden max-w-[200px] text-xs text-muted-foreground xl:table-cell"
                      title="From pack research — optional. Prefer AI columns."
                    >
                      Why now
                    </TableHead>
                  </>
                )}
                <TableHead className="w-24 pr-4">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && (
                <TableRow>
                  <TableCell
                    colSpan={tableColSpan}
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
                    colSpan={tableColSpan}
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
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <span className="truncate text-sm font-medium">
                              {p.name}
                            </span>
                            {(r.people?.length ?? 0) > 1 && (
                              <span className="inline-flex w-fit items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                                <Users className="size-2.5" />
                                +{(r.people?.length ?? 1) - 1} more
                              </span>
                            )}
                          </div>
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
                        className="hidden max-w-[200px] font-mono text-xs lg:table-cell"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {p?.email ? (
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <a
                              href={`mailto:${p.email}`}
                              className="inline-flex min-w-0 items-center gap-1 text-foreground hover:underline"
                            >
                              <Mail className="size-3 shrink-0 text-muted-foreground" />
                              <span className="truncate">{p.email}</span>
                            </a>
                            {emailStatusHint(p.emailStatus, true) && (
                              <span
                                className={cn(
                                  "text-[10px] font-medium uppercase tracking-wide",
                                  emailStatusClass(p.emailStatus),
                                )}
                              >
                                {emailStatusHint(p.emailStatus, true)}
                              </span>
                            )}
                          </div>
                        ) : p ? (
                          <button
                            type="button"
                            className="inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:border-foreground/30 hover:bg-muted hover:text-foreground disabled:opacity-50"
                            disabled={
                              emailBusyKey === `${r.id}:${p.id ?? p.name}` ||
                              actionBusy
                            }
                            title="Find work email (saves only when proven)"
                            onClick={() =>
                              void findEmailForPerson({
                                rowId: r.id,
                                personId: p.id,
                                personName: p.name,
                                busyKey: `${r.id}:${p.id ?? p.name}`,
                              })
                            }
                          >
                            {emailBusyKey === `${r.id}:${p.id ?? p.name}` ? (
                              <Loader2 className="size-3 animate-spin" />
                            ) : (
                              <Mail className="size-3" />
                            )}
                            Find email
                          </button>
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
                      {showIcpMeta && (
                        <>
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
                        </>
                      )}
                      <TableCell className="pr-4 text-xs text-muted-foreground">
                        {p ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
                            <Check className="size-3" />
                            {(r.people?.length ?? 0) > 1
                              ? `${r.people!.length} people`
                              : "Contact"}
                          </span>
                        ) : r.status === "researching" ? (
                          "Researching…"
                        ) : r.status === "pending" ? (
                          "Pending"
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

      {/* Add dynamic column (Clay-style) */}
      <Dialog
        open={columnDialogOpen}
        onOpenChange={(open) => {
          setColumnDialogOpen(open);
          if (!open) resetColumnForm();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add column</DialogTitle>
            <DialogDescription>
              Like Clay: name a column and tell AI (or a people field) how to
              fill each row. Also available via MCP{" "}
              <code className="text-xs">researchCreateColumn</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">
                Name
              </label>
              <Input
                placeholder="e.g. Pain de QE, Buying signal…"
                value={colLabel}
                onChange={(e) => setColLabel(e.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Fill with
                </label>
                <Select
                  value={colEnrichKind}
                  onValueChange={(v) =>
                    setColEnrichKind(v as "ai" | "people_field" | "none")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ai">AI prompt</SelectItem>
                    <SelectItem value="people_field">People field</SelectItem>
                    <SelectItem value="none">Manual (empty)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Type
                </label>
                <Select
                  value={colType}
                  onValueChange={(v) =>
                    setColType(
                      v as "text" | "url" | "email" | "boolean" | "number",
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="text">Text</SelectItem>
                    <SelectItem value="url">URL</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="boolean">Yes / no</SelectItem>
                    <SelectItem value="number">Number</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {colEnrichKind === "ai" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Prompt
                </label>
                <Textarea
                  value={colPrompt}
                  onChange={(e) => setColPrompt(e.target.value)}
                  rows={4}
                  placeholder="e.g. Em 1 frase: principal dor de quality engineering. Cite evidência."
                  className="text-sm"
                />
              </div>
            )}
            {colEnrichKind === "people_field" && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">
                  Which contact field
                </label>
                <Select
                  value={colPeopleField}
                  onValueChange={(v) =>
                    setColPeopleField(
                      v as "linkedin" | "email" | "name" | "role",
                    )
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="linkedin">LinkedIn</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="name">Name</SelectItem>
                    <SelectItem value="role">Role</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {colEnrichKind !== "none" && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border"
                  checked={colRunNow}
                  onChange={(e) => setColRunNow(e.target.checked)}
                />
                Fill now
                {selected.size > 0
                  ? ` (${selected.size} selected)`
                  : " (empty cells, up to 30)"}
              </label>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setColumnDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                colBusy ||
                !colLabel.trim() ||
                (colEnrichKind === "ai" && !colPrompt.trim())
              }
              onClick={() => void createDynamicColumn()}
            >
              {colBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              Add column
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
              <strong>⋯ → Enrich contacts</strong> to find people on companies.
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
                Find contacts
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() => void rowAction(drawerRowId, "crm")}
              >
                <Building2 className="size-3.5" />
                To Accounts
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={actionBusy}
                onClick={() =>
                  void rowAction(drawerRowId, "qualify", { force: true })
                }
              >
                Pack score
              </Button>
            </div>
            <div className="min-h-0 flex-1 space-y-5 overflow-auto p-4">
              {drawerLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : (
                <>
                  <section className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Contacts
                        {editPeople.filter((p) => p.name.trim()).length > 0 && (
                          <span className="ml-1.5 font-normal normal-case tabular-nums text-muted-foreground">
                            ({editPeople.filter((p) => p.name.trim()).length})
                          </span>
                        )}
                      </h3>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        row {drawerRowId.slice(0, 8)}…
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Several people per company. First with an email is the
                      primary in the grid. Add/remove, then Save all.
                    </p>

                    <div className="space-y-3">
                      {editPeople.map((person, index) => (
                        <div
                          key={person.key}
                          className="space-y-2 rounded-lg border bg-card p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-[11px] font-medium text-muted-foreground">
                              Person {index + 1}
                              {index === 0 && editPeople.length > 1
                                ? " · primary candidate"
                                : ""}
                            </span>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              className="size-7 text-muted-foreground hover:text-destructive"
                              disabled={editPeople.length <= 1}
                              onClick={() => removeEditPerson(person.key)}
                              aria-label={`Remove person ${index + 1}`}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              Name
                            </label>
                            <Input
                              value={person.name}
                              onChange={(e) =>
                                updateEditPerson(
                                  person.key,
                                  "name",
                                  e.target.value,
                                )
                              }
                              placeholder="Full name"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              Role
                            </label>
                            <Input
                              value={person.role}
                              onChange={(e) =>
                                updateEditPerson(
                                  person.key,
                                  "role",
                                  e.target.value,
                                )
                              }
                              placeholder="CTO, Head of Eng…"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              Email
                            </label>
                            <Input
                              value={person.email}
                              onChange={(e) =>
                                updateEditPerson(
                                  person.key,
                                  "email",
                                  e.target.value,
                                )
                              }
                              placeholder="name@company.com"
                            />
                          </div>
                          <div className="space-y-1">
                            <label className="text-[11px] text-muted-foreground">
                              LinkedIn URL
                            </label>
                            <Input
                              value={person.linkedin}
                              onChange={(e) =>
                                updateEditPerson(
                                  person.key,
                                  "linkedin",
                                  e.target.value,
                                )
                              }
                              placeholder="https://www.linkedin.com/in/…"
                            />
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={addEditPerson}
                      >
                        <Plus className="size-3.5" />
                        Add person
                      </Button>
                      <Button
                        size="sm"
                        className="w-full"
                        disabled={
                          savingContact ||
                          !editPeople.some((p) => p.name.trim())
                        }
                        onClick={() => void saveContacts()}
                      >
                        {savingContact ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Check className="size-3.5" />
                        )}
                        Save all contacts
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="w-full text-muted-foreground"
                        disabled={historyLoading}
                        onClick={() => void loadPeopleHistory()}
                      >
                        {historyLoading ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <History className="size-3.5" />
                        )}
                        Contact history
                      </Button>
                    </div>

                    {historyOpen && (
                      <div className="space-y-2 rounded-lg border border-dashed p-3">
                        <div className="flex items-center justify-between gap-2">
                          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Snapshots
                          </h4>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            onClick={() => setHistoryOpen(false)}
                          >
                            Hide
                          </Button>
                        </div>
                        {peopleSnapshots.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            No snapshots yet. They appear after save, enrich, or
                            agent edits.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {peopleSnapshots.map((s) => (
                              <li
                                key={s.id}
                                className="rounded-md border bg-muted/30 px-2.5 py-2 text-xs"
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                    <p className="font-medium text-foreground">
                                      {s.personCount} people · {s.reason}
                                    </p>
                                    <p className="text-muted-foreground">
                                      {s.createdAt
                                        ? new Date(s.createdAt).toLocaleString()
                                        : "—"}
                                    </p>
                                    <p className="mt-1 truncate text-muted-foreground">
                                      {s.people
                                        .slice(0, 5)
                                        .map((p) => p.name)
                                        .filter(Boolean)
                                        .join(", ") || "—"}
                                      {s.people.length > 5 ? "…" : ""}
                                    </p>
                                  </div>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    className="h-7 shrink-0 gap-1"
                                    disabled={restoringId === s.id}
                                    onClick={() =>
                                      void restorePeopleVersion(s.id)
                                    }
                                  >
                                    {restoringId === s.id ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                      <RotateCcw className="size-3" />
                                    )}
                                    Restore
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </section>

                  {showIcpMeta &&
                    (drawerRow.whyNow || drawerRow.icpScore != null) && (
                      <section>
                        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                          Pack score
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

                  {customColumns.some((col) => {
                    const cell = drawerRow.cells?.[col.key];
                    return (
                      cell &&
                      (cell.value != null ||
                        cell.error ||
                        cell.status === "running")
                    );
                  }) && (
                    <section>
                      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Columns
                      </h3>
                      <ul className="space-y-2">
                        {customColumns.map((col) => {
                          const cell = drawerRow.cells?.[col.key];
                          if (
                            !cell ||
                            (cell.value == null &&
                              !cell.error &&
                              cell.status !== "running")
                          )
                            return null;
                          return (
                            <li
                              key={col.key}
                              className="rounded-md border px-2.5 py-2 text-sm"
                            >
                              <div className="text-[11px] font-medium text-muted-foreground">
                                {col.label}
                              </div>
                              <p className="mt-0.5">{formatCell(cell)}</p>
                              {cell.evidence && (
                                <p className="mt-1 text-xs text-muted-foreground">
                                  {cell.evidence}
                                </p>
                              )}
                            </li>
                          );
                        })}
                      </ul>
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
