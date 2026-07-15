"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Building2,
  CheckCircle2,
  Download,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
  Users,
  XCircle,
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

function scoreBadge(score: number | null, pass: boolean | null) {
  if (score == null) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-mono tabular-nums",
        pass === true && "border-emerald-500/50 text-emerald-700 dark:text-emerald-400",
        pass === false && "border-rose-500/40 text-rose-700 dark:text-rose-400",
      )}
    >
      {score}
    </Badge>
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
  const [showImport, setShowImport] = useState(false);
  const [newTableName, setNewTableName] = useState("");
  const [newRubric, setNewRubric] = useState("qe-kodus-v1");
  const [drawerRowId, setDrawerRowId] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");

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
      setNotice((await res.json()).error ?? "Failed to load tables");
      return;
    }
    const data = await res.json();
    setTables(data.tables ?? []);
    setRubrics(data.rubrics ?? []);
    if (!tableId && data.tables?.[0]?.id) {
      setTableId(data.tables[0].id);
    }
  }, [token, headers, tableId]);

  const loadRows = useCallback(async () => {
    if (!token || !tableId) return;
    setLoading(true);
    try {
      const qs = passOnly ? "?passOnly=1" : "";
      const res = await fetch(`/api/research/tables/${tableId}${qs}`, {
        headers: headers(),
      });
      if (!res.ok) {
        setNotice((await res.json()).error ?? "Failed to load rows");
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
        const res = await fetch(
          `/api/research/status?tableId=${tableId}`,
          { headers: headers() },
        );
        if (!res.ok) continue;
        const state = await res.json();
        if (state.running) {
          setNotice(
            `Job running (${state.kind ?? "research"}) since ${
              state.startedAt
                ? new Date(state.startedAt).toLocaleTimeString()
                : "…"
            }…`,
          );
          continue;
        }
        if (state.lastError) {
          setNotice(`Failed: ${state.lastError}`);
        } else if (state.lastSummary) {
          setNotice(state.lastSummary);
        } else {
          setNotice("Job finished");
        }
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
      setNotice(data.error ?? "Create failed");
      return;
    }
    setNewTableName("");
    setTableId(data.table.id);
    await loadTables();
    setNotice(`Created table “${data.table.name}”`);
  };

  const importDomains = async () => {
    if (!token || !tableId || !importText.trim()) return;
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
    setShowImport(false);
    setNotice(`Added ${data.added}, skipped ${data.skipped}`);
    await loadRows();
    await loadTables();
  };

  const importSource = async (source: string) => {
    if (!token || !tableId) return;
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
    setNotice(`Imported ${data.added} (skipped ${data.skipped}) from ${source}`);
    await loadRows();
  };

  const runJob = async (kind: "research" | "people" | "full", force = false) => {
    if (!token || !tableId) return;
    const rowIds = selected.size > 0 ? [...selected] : undefined;
    const res = await fetch(`/api/research/tables/${tableId}/run`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ kind, rowIds, force, enrichPeople: kind === "full" }),
    });
    if (res.status === 409) {
      setNotice("Job already running — attaching…");
      void pollUntilDone();
      return;
    }
    if (!res.ok) {
      const data = await res.json();
      setNotice(data.error ?? "Failed to start");
      return;
    }
    setNotice(`Started ${kind}…`);
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

  const rowAction = async (rowId: string, action: string, extra: Record<string, unknown> = {}) => {
    if (!token) return;
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
      action === "qualify"
        ? `Qualified → CRM + outreach`
        : action === "people"
          ? `Found ${(data.people ?? []).length} people`
          : action === "ai_column"
            ? `AI: ${data.answer}`
            : `${action} ok`,
    );
    if (drawerRowId === rowId) await openDrawer(rowId);
    await loadRows();
  };

  const exportCsv = () => {
    if (!token || !tableId) return;
    void (async () => {
      const res = await fetch(
        `/api/research/tables/${tableId}/export${passOnly ? "?passOnly=1" : ""}`,
        { headers: headers() },
      );
      if (!res.ok) {
        setNotice("CSV export failed");
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

  const activeTable = tables.find((t) => t.id === tableId);
  const drawerRow = rows.find((r) => r.id === drawerRowId);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Research</h1>
          <p className="text-sm text-muted-foreground">
            Clay-style ICP research: import domains, multi-source search, score
            against a rubric, then people/email waterfall.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={tableId ?? undefined}
            onValueChange={(v) => {
              setTableId(v);
              setSelected(new Set());
              setDrawerRowId(null);
            }}
          >
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select table" />
            </SelectTrigger>
            <SelectContent>
              {tables.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name} ({t.rowCount ?? 0})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card/40 p-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">New table</span>
          <Input
            placeholder="QE pipeline Jul"
            value={newTableName}
            onChange={(e) => setNewTableName(e.target.value)}
            className="w-[180px]"
          />
        </div>
        <Select value={newRubric} onValueChange={setNewRubric}>
          <SelectTrigger className="w-[200px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {rubrics.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
            {rubrics.length === 0 && (
              <>
                <SelectItem value="qe-kodus-v1">QE / E2E (Kodus)</SelectItem>
                <SelectItem value="generic-b2b-v1">Generic B2B</SelectItem>
              </>
            )}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => void createTable()} disabled={!newTableName.trim()}>
          <Plus className="mr-1 h-4 w-4" />
          Create
        </Button>
      </div>

      {notice && (
        <div className="rounded-md border bg-muted/40 px-3 py-2 text-sm">
          {notice}
        </div>
      )}

      {activeTable && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{activeTable.rubricId}</Badge>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowImport((v) => !v)}
          >
            <Upload className="mr-1 h-4 w-4" />
            Import
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void importSource("watchlist")}
          >
            From watchlist
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void importSource("icp_signals")}
          >
            Strong signals
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void importSource("crm")}
          >
            From CRM
          </Button>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button
            size="sm"
            onClick={() => void runJob("research")}
            disabled={running || !tableId}
          >
            {running ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Search className="mr-1 h-4 w-4" />
            )}
            Research{selected.size ? ` (${selected.size})` : ""}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void runJob("full")}
            disabled={running || !tableId}
          >
            <Sparkles className="mr-1 h-4 w-4" />
            Research + people
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void runJob("people")}
            disabled={running || !tableId}
          >
            <Users className="mr-1 h-4 w-4" />
            People (pass only)
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void runJob("research", true)}
            disabled={running || !tableId}
          >
            <RefreshCw className="mr-1 h-4 w-4" />
            Force re-research
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download className="mr-1 h-4 w-4" />
            CSV
          </Button>
          <label className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={passOnly}
              onChange={(e) => setPassOnly(e.target.checked)}
            />
            Pass only
          </label>
        </div>
      )}

      {showImport && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            One per line: <code>domain.com</code> or{" "}
            <code>Company Name, domain.com</code>
          </p>
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={6}
            placeholder={"acme.com\nOmie, omie.com.br"}
          />
          <Button size="sm" onClick={() => void importDomains()}>
            Add rows
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Company</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Score</TableHead>
              <TableHead>Pass</TableHead>
              <TableHead>Anti</TableHead>
              <TableHead>Why now</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Source</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!loading && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No rows. Create a table and import domains.
                </TableCell>
              </TableRow>
            )}
            {rows.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer"
                onClick={() => void openDrawer(r.id)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggleSelect(r.id)}
                  />
                </TableCell>
                <TableCell className="font-medium">{r.companyName}</TableCell>
                <TableCell className="font-mono text-xs">{r.domain ?? "—"}</TableCell>
                <TableCell>{scoreBadge(r.icpScore, r.pass)}</TableCell>
                <TableCell>
                  {r.pass === true && (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  )}
                  {r.pass === false && (
                    <XCircle className="h-4 w-4 text-rose-500" />
                  )}
                  {r.pass == null && "—"}
                </TableCell>
                <TableCell className="max-w-[120px] truncate text-xs text-muted-foreground">
                  {(r.antiFlags ?? []).join(", ") || "—"}
                </TableCell>
                <TableCell className="max-w-[220px] truncate text-xs">
                  {r.whyNow ?? "—"}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="text-xs">
                    {r.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {r.source}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {drawerRowId && drawerRow && (
        <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-xl">
          <div className="flex items-center justify-between border-b px-4 py-3">
            <div>
              <div className="font-semibold">{drawerRow.companyName}</div>
              <div className="font-mono text-xs text-muted-foreground">
                {drawerRow.domain}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDrawerRowId(null)}
            >
              Close
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 border-b px-4 py-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => void rowAction(drawerRowId, "people", { onlyIfPass: false })}
            >
              <Users className="mr-1 h-3 w-3" />
              Find people
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void rowAction(drawerRowId, "crm")}
            >
              <Building2 className="mr-1 h-3 w-3" />
              CRM
            </Button>
            <Button
              size="sm"
              onClick={() => void rowAction(drawerRowId, "qualify", { force: true })}
            >
              Qualify
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            {drawerLoading && (
              <div className="text-sm text-muted-foreground">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Loading…
              </div>
            )}
            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Score
              </div>
              <div className="flex items-center gap-2 text-sm">
                {scoreBadge(drawerRow.icpScore, drawerRow.pass)}
                <span className="text-muted-foreground">
                  trigger {drawerRow.triggerScore ?? "—"} · fit{" "}
                  {drawerRow.fitScore ?? "—"}
                </span>
              </div>
              {drawerRow.whyNow && (
                <p className="mt-2 text-sm">{drawerRow.whyNow}</p>
              )}
              {drawerRow.error && (
                <p className="mt-2 text-sm text-rose-600">{drawerRow.error}</p>
              )}
            </div>

            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Rubric checklist
              </div>
              <ul className="space-y-2">
                {evidence.map((e) => (
                  <li
                    key={e.criterionId}
                    className="rounded-md border px-2 py-1.5 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          e.status === "pass" && "border-emerald-500/50",
                          e.status === "fail" && "border-rose-500/40",
                        )}
                      >
                        {e.kind}/{e.status}
                      </Badge>
                      <span className="font-mono text-xs">{e.criterionId}</span>
                    </div>
                    {e.evidence && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {e.evidence}
                      </p>
                    )}
                    {e.sources?.[0]?.url && (
                      <a
                        href={e.sources[0].url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1 block truncate text-[11px] text-blue-600 underline"
                      >
                        {e.sources[0].url}
                      </a>
                    )}
                  </li>
                ))}
                {!drawerLoading && evidence.length === 0 && (
                  <li className="text-xs text-muted-foreground">
                    No evidence yet — run research.
                  </li>
                )}
              </ul>
            </div>

            <div>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                People
              </div>
              <ul className="space-y-1 text-sm">
                {people.map((p, i) => (
                  <li key={`${p.name}-${i}`} className="rounded border px-2 py-1">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.role ?? "—"} · {p.email ?? "no email"}{" "}
                      {p.emailStatus ? `(${p.emailStatus})` : ""}
                    </div>
                  </li>
                ))}
                {people.length === 0 && (
                  <li className="text-xs text-muted-foreground">None yet</li>
                )}
              </ul>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                AI column
              </div>
              <Input
                placeholder="Does this company use Playwright?"
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!aiPrompt.trim()}
                onClick={() =>
                  void rowAction(drawerRowId, "ai_column", {
                    prompt: aiPrompt.trim(),
                  })
                }
              >
                <Sparkles className="mr-1 h-3 w-3" />
                Run AI research
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
