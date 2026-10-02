"use client";

/* Hallmark · genre: modern-minimal · macrostructure: Workbench (app page: editorial table + month calendar) · theme: app tokens (dark neutral, violet ≤ 5%) · enrichment: none · nav: app shell · footer: none */

import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown, ListChecks, Pencil, Plus, Trash2, X } from "lucide-react";

import seed from "@/lib/editorial/seed.json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

// Prototype: rows live in localStorage, seeded from the verticals spreadsheet.
// Nothing here talks to Supabase yet.

type Kind = "new" | "update";
// Priority / status / category / owner are ids into the editable option lists below.
type Priority = string;
type Status = string;

type Option = { id: string; label: string };
type OptionKey = "priority" | "status" | "category" | "owner";
type Options = Record<OptionKey, Option[]>;

type EditorialItem = {
  id: string;
  kind: Kind;
  priority: Priority;
  category: string;
  title: string;
  keywordEn: string;
  keywordPt: string;
  secondaryEn: string;
  secondaryPt: string;
  titlePt: string;
  titleEn: string;
  outline: string;
  reference: string;
  cluster: string;
  observations: string;
  trackedPrompt: string;
  why: string;
  owner: string;
  status: Status;
  scheduledFor: string; // YYYY-MM-DD or ""
  note: string;
  publishedUrl: string; // live URL once published
  stageDates: Record<string, string>; // when the item entered each status (ISO date-time, or YYYY-MM-DD)
};

const STORAGE_KEY = "editorial-prototype-v5";
const LEGACY_STORAGE_KEY = "editorial-prototype-v4";
const OPTIONS_KEY = "editorial-options-v1";
const asOptions = (labels: string[]): Option[] => labels.map((l) => ({ id: l, label: l }));
const DEFAULT_OPTIONS: Options = {
  priority: asOptions(["P1", "P2", "P3", "P4"]),
  status: [
    { id: "backlog", label: "Backlog" },
    { id: "writing", label: "Escrevendo" },
    { id: "review", label: "Revisão" },
    { id: "scheduled", label: "Agendado" },
    { id: "published", label: "Publicado" },
  ],
  category: asOptions(["Alternativas", "Guia", "How to", "Lista"]),
  owner: asOptions(["Gabriel", "Junior", "Ed"]),
};
const OPTION_GROUPS: { key: OptionKey; label: string; plural: string }[] = [
  { key: "priority", label: "Prioridade", plural: "prioridades" },
  { key: "status", label: "Status", plural: "status" },
  { key: "category", label: "Categoria", plural: "categorias" },
  { key: "owner", label: "Responsável", plural: "responsáveis" },
];

function labelOf(list: Option[], id: string) {
  return list.find((o) => o.id === id)?.label ?? (id || "—");
}
const WEEKDAYS = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"];
const MONTHS = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
];

function emptyItem(p: Partial<EditorialItem> & { id: string }): EditorialItem {
  return {
    kind: "new",
    priority: "P2",
    category: "Guia",
    title: "",
    keywordEn: "",
    keywordPt: "",
    secondaryEn: "",
    secondaryPt: "",
    titlePt: "",
    titleEn: "",
    outline: "",
    reference: "",
    cluster: "",
    observations: "",
    trackedPrompt: "",
    why: "",
    owner: "",
    status: "backlog",
    scheduledFor: "",
    note: "",
    publishedUrl: "",
    stageDates: {},
    ...p,
  };
}

function seedItems(): EditorialItem[] {
  return (seed as Array<Partial<EditorialItem> & { id: string }>).map((s) => emptyItem(s));
}

// Carry over edits from the previous prototype version (v2) onto the fresh seed:
// workflow fields and anything the user typed, plus rows added by hand.
// Rows dropped from the seed (repeated topics) stay dropped; titles come from the seed.
const CARRIED_FIELDS = [
  "owner", "status", "priority", "scheduledFor", "note", "keywordEn", "category", "kind",
] as const;

function loadItems(): EditorialItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return (JSON.parse(raw) as EditorialItem[]).map((i) => emptyItem(i));
  } catch {}
  const base = seedItems();
  try {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      const old = (JSON.parse(legacy) as EditorialItem[]).map((i) => emptyItem(i));
      const byId = new Map(old.map((o) => [o.id, o]));
      const merged = base.map((b) => {
        const o = byId.get(b.id);
        if (!o) return b;
        const carried: Partial<EditorialItem> = {};
        for (const f of CARRIED_FIELDS) (carried as Record<string, unknown>)[f] = o[f];
        return { ...b, ...carried };
      });
      return [...old.filter((o) => o.id.startsWith("local-")), ...merged];
    }
  } catch {}
  return base;
}

// Once the scheduled day has passed, the item counts as published. The date stays
// on the item as its publish date. Runs when the page loads.
function autoPublishDue(items: EditorialItem[]): EditorialItem[] {
  const today = todayYmd();
  return items.map((it) =>
    it.status === "scheduled" && it.scheduledFor && it.scheduledFor < today
      ? { ...it, status: "published", stageDates: { ...it.stageDates, published: it.scheduledFor } }
      : it,
  );
}

function normTitle(t: string) {
  return t.trim().toLowerCase().replace(/\s+/g, " ");
}

// Priority is a quiet text tone in the table; only P1/P2 carry colour.
function priorityTone(p: Priority) {
  if (p === "P1") return "text-red-300";
  if (p === "P2") return "text-amber-300";
  return "text-neutral-400";
}

// Calendar chips: neutral surface, priority shown as a left stripe.
function priorityStripe(p: Priority) {
  if (p === "P1") return "border-l-red-400";
  if (p === "P2") return "border-l-amber-400";
  if (p === "P3") return "border-l-sky-400";
  return "border-l-neutral-600";
}

const STATUS_DOT: Record<string, string> = {
  backlog: "bg-neutral-600",
  writing: "bg-sky-400",
  review: "bg-amber-400",
  scheduled: "bg-violet-400",
  published: "bg-emerald-400",
};

const focusRing =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/70";

function pad(n: number) {
  return String(n).padStart(2, "0");
}
function ymd(y: number, m: number, d: number) {
  return `${y}-${pad(m + 1)}-${pad(d)}`;
}
function todayYmd() {
  const t = new Date();
  return ymd(t.getFullYear(), t.getMonth(), t.getDate());
}
const selectClass = cn(
  "h-8 rounded-md border border-white/10 bg-neutral-900 px-2 text-xs text-neutral-200 outline-none hover:border-white/20",
  focusRing,
);
const inlineInputClass = cn(
  "w-full rounded border border-transparent bg-transparent px-1.5 py-1 text-xs text-neutral-300 outline-none hover:border-white/10 focus:bg-neutral-900",
  focusRing,
);
// Selects that live inside table rows: borderless until hovered, so the table reads as text.
const rowSelectClass = cn(
  "h-7 cursor-pointer rounded border border-transparent bg-transparent px-1 text-xs text-neutral-300 outline-none hover:border-white/10 hover:bg-neutral-900",
  focusRing,
);

export function EditorialPage() {
  const [items, setItems] = useState<EditorialItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"table" | "calendar" | "published" | "metrics">("table");
  const [q, setQ] = useState("");
  const [fKind, setFKind] = useState("");
  const [fPriority, setFPriority] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fOwner, setFOwner] = useState("");
  const [adding, setAdding] = useState(false);
  // Priority sort follows the order of the priority list (P1 first). Click: asc → desc → off.
  const [prioritySort, setPrioritySort] = useState<"asc" | "desc" | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);

  useEffect(() => {
    setItems(autoPublishDue(loadItems()));
    try {
      const raw = localStorage.getItem(OPTIONS_KEY);
      if (raw) setOptions({ ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<Options>) });
    } catch {}
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
    } catch {}
  }, [options, loaded]);

  // Saved lists plus any value still used by an item (e.g. categories from the spreadsheet seed).
  const opts = useMemo<Options>(() => {
    const next = { ...options };
    for (const g of OPTION_GROUPS) {
      const list = [...options[g.key]];
      for (const it of items) {
        const v = it[g.key];
        if (v && !list.some((o) => o.id === v)) list.push({ id: v, label: v });
      }
      next[g.key] = list;
    }
    return next;
  }, [options, items]);

  const addOption = (key: OptionKey, label: string) => {
    const l = label.trim();
    if (!l || opts[key].some((o) => o.label.toLowerCase() === l.toLowerCase())) return false;
    setOptions({ ...opts, [key]: [...opts[key], { id: `opt-${Date.now()}`, label: l }] });
    return true;
  };
  const renameOption = (key: OptionKey, id: string, label: string) => {
    const l = label.trim();
    if (!l || opts[key].some((o) => o.id !== id && o.label.toLowerCase() === l.toLowerCase())) return false;
    setOptions({ ...opts, [key]: opts[key].map((o) => (o.id === id ? { ...o, label: l } : o)) });
    return true;
  };
  const deleteOption = (key: OptionKey, id: string) => {
    setOptions({ ...opts, [key]: opts[key].filter((o) => o.id !== id) });
    setItems((prev) => prev.map((it) => (it[key] === id ? { ...it, [key]: "" } : it)));
    const clear = { priority: setFPriority, status: setFStatus, category: setFCategory, owner: setFOwner }[key];
    clear((cur) => (cur === id ? "" : cur));
  };
  const optionCounts = useMemo(() => {
    const c: Record<OptionKey, Record<string, number>> = { priority: {}, status: {}, category: {}, owner: {} };
    for (const it of items) for (const g of OPTION_GROUPS) c[g.key][it[g.key]] = (c[g.key][it[g.key]] ?? 0) + 1;
    return c;
  }, [items]);

  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }, [items, loaded]);

  const duplicates = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const k = normTitle(it.title);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (fKind && it.kind !== fKind) return false;
      if (fPriority && it.priority !== fPriority) return false;
      if (fCategory && it.category !== fCategory) return false;
      if (fStatus && it.status !== fStatus) return false;
      if (fOwner === "__none" ? it.owner !== "" : fOwner && it.owner !== fOwner) return false;
      if (needle && !`${it.title} ${it.keywordEn} ${it.keywordPt}`.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [items, q, fKind, fPriority, fCategory, fStatus, fOwner]);

  // Setting a date moves the item to "Agendado" unless it is already published
  // or the status is being set explicitly in the same patch.
  const patch = (id: string, p: Partial<EditorialItem>) =>
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const next = { ...it, ...p };
        // Moving back to any status other than "Agendado" / "Publicado" clears the date
        // (a published item keeps its date as the publish date).
        if (p.status !== undefined && p.status !== "scheduled" && p.status !== "published" && p.scheduledFor === undefined) {
          next.scheduledFor = "";
        }
        if (p.scheduledFor && p.status === undefined && it.status !== "published" && opts.status.some((o) => o.id === "scheduled")) {
          next.status = "scheduled";
        }
        if (next.status !== it.status && next.status) {
          next.stageDates = { ...it.stageDates, [next.status]: new Date().toISOString() };
        }
        return next;
      }),
    );

  const counts = useMemo(() => {
    const c = { new: 0, update: 0, dup: 0, scheduled: 0 };
    for (const it of items) {
      c[it.kind] += 1;
      if (it.scheduledFor) c.scheduled += 1;
      if ((duplicates.get(normTitle(it.title)) ?? 0) > 1) c.dup += 1;
    }
    return c;
  }, [items, duplicates]);

  // The working table hides published items (unless Status is filtered to Publicado);
  // they live in the Publicados view, newest publish date first.
  const tableRows = useMemo(() => {
    const rows = filtered.filter((it) => it.status !== "published" || fStatus === "published");
    if (!prioritySort) return rows;
    // Items without a priority always go last.
    const rank = (id: string) => {
      const i = opts.priority.findIndex((o) => o.id === id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    const dir = prioritySort === "asc" ? 1 : -1;
    return rows
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => {
        const ra = rank(a.it.priority);
        const rb = rank(b.it.priority);
        if (ra === rb) return a.idx - b.idx;
        if (ra === Number.MAX_SAFE_INTEGER) return 1;
        if (rb === Number.MAX_SAFE_INTEGER) return -1;
        return (ra - rb) * dir;
      })
      .map((x) => x.it);
  }, [filtered, fStatus, prioritySort, opts.priority]);
  const publishedRows = useMemo(
    () =>
      filtered
        .filter((it) => it.status === "published")
        .sort((a, b) => (b.scheduledFor || "").localeCompare(a.scheduledFor || "") || a.title.localeCompare(b.title)),
    [filtered],
  );

  const filtersActive = q || fKind || fPriority || fCategory || fStatus || fOwner;
  const openItem = items.find((i) => i.id === openId) ?? null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-neutral-100">
            <ListChecks className="size-5 text-violet-400" /> Editorial
          </h1>
          <p className="mt-1 text-sm text-neutral-500">
            Content plan for the Kodus blog: tracking what we&apos;ll produce and what we&apos;ll update.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            {items.length} conteúdos · {items.filter((i) => i.status === "published").length} publicados · {counts.new} novos · {counts.update} atualizações · {counts.scheduled} com data
            {counts.dup > 0 && ` · ${counts.dup} linhas com título repetido`}
          </p>
          <p className="mt-1 text-[11px] text-amber-300/80">
            Protótipo local: dados salvos só neste navegador.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-white/10 p-0.5">
            {(["table", "calendar", "published", "metrics"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={cn(
                  "rounded px-3 py-1 text-xs",
                  focusRing,
                  view === v ? "bg-white/10 text-neutral-100" : "text-neutral-400 hover:text-neutral-200",
                )}
              >
                {v === "table" ? "Tabela" : v === "calendar" ? "Calendário" : v === "published" ? `Publicados (${publishedRows.length})` : "Métricas"}
              </button>
            ))}
          </div>
          <Button onClick={() => setAdding(true)} className={cn("gap-1.5 bg-violet-600 text-white hover:bg-violet-500", focusRing)}>
            <Plus className="size-4" /> Adicionar
          </Button>
        </div>
      </div>

      <div className={cn("flex flex-wrap items-center gap-2", view === "metrics" && "hidden")}>
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Buscar título ou keyword…"
          className="h-8 w-64 text-xs"
        />
        <select className={selectClass} value={fKind} onChange={(e) => setFKind(e.target.value)}>
          <option value="">Tipo: todos</option>
          <option value="new">Novo</option>
          <option value="update">Atualização</option>
        </select>
        <select className={selectClass} value={fPriority} onChange={(e) => setFPriority(e.target.value)}>
          <option value="">Prioridade: todas</option>
          {opts.priority.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select className={selectClass} value={fCategory} onChange={(e) => setFCategory(e.target.value)}>
          <option value="">Categoria: todas</option>
          {opts.category.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select className={selectClass} value={fStatus} onChange={(e) => setFStatus(e.target.value)}>
          <option value="">Status: todos</option>
          {opts.status.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <select className={selectClass} value={fOwner} onChange={(e) => setFOwner(e.target.value)}>
          <option value="">Responsável: todos</option>
          <option value="__none">Sem responsável</option>
          {opts.owner.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
        <FiltersPopover
          options={opts}
          counts={optionCounts}
          onAdd={addOption}
          onRename={renameOption}
          onDelete={deleteOption}
        />
        {filtersActive ? (
          <button
            onClick={() => {
              setQ(""); setFKind(""); setFPriority(""); setFCategory(""); setFStatus(""); setFOwner("");
            }}
            className="inline-flex items-center gap-1 text-xs text-neutral-400 hover:text-neutral-200"
          >
            <X className="size-3" /> limpar
          </button>
        ) : null}
        <span className="ml-auto text-xs text-neutral-500">{view === "table" ? tableRows.length : view === "published" ? publishedRows.length : filtered.length} exibidos</span>
      </div>

      {view === "table" ? (
        <div className="overflow-x-auto rounded-lg border border-white/10">
          <table className="w-full min-w-[1100px] text-left text-sm">
            <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wider text-neutral-500">
              <tr>
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">
                  <button
                    onClick={() => setPrioritySort((cur) => (cur === null ? "asc" : cur === "asc" ? "desc" : null))}
                    aria-label="Ordenar por prioridade"
                    className={cn(
                      "inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-neutral-300",
                      focusRing,
                      prioritySort && "text-neutral-200",
                    )}
                  >
                    Prior.
                    {prioritySort === "asc" ? (
                      <ArrowUp className="size-3" />
                    ) : prioritySort === "desc" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ChevronsUpDown className="size-3 opacity-60" />
                    )}
                  </button>
                </th>
                <th className="px-3 py-2 font-medium">Categoria</th>
                <th className="px-3 py-2 font-medium">Título</th>
                <th className="px-3 py-2 font-medium">Keyword foco</th>
                <th className="px-3 py-2 font-medium">Responsável</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Agendado para</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.06]">
              {tableRows.map((it) => {
                const dup = (duplicates.get(normTitle(it.title)) ?? 0) > 1;
                return (
                  <tr
                    key={it.id}
                    className="cursor-pointer align-top hover:bg-white/[0.04]"
                    onClick={(e) => {
                      // Selects/inputs/buttons inside the row keep their own behavior.
                      if ((e.target as HTMLElement).closest("select, input, button, a")) return;
                      setOpenId(it.id);
                    }}
                  >
                    <td className="px-3 py-2">
                      <span className={cn("text-xs", it.kind === "update" ? "font-medium text-violet-300" : "text-neutral-500")}>
                        {it.kind === "update" ? "Atualização" : "Novo"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <select
                        value={it.priority}
                        onChange={(e) => patch(it.id, { priority: e.target.value as Priority })}
                        className={cn(rowSelectClass, "w-12 font-medium", priorityTone(it.priority))}
                      >
                        <option value="" className="bg-neutral-900 text-neutral-200">—</option>
                        {opts.priority.map((o) => (
                          <option key={o.id} value={o.id} className="bg-neutral-900 text-neutral-200">{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2 text-xs text-neutral-400">{labelOf(opts.category, it.category)}</td>
                    <td className="max-w-[360px] px-3 py-2">
                      <button
                        onClick={() => setOpenId(it.id)}
                        className={cn("rounded text-left text-neutral-100 hover:text-violet-300 hover:underline", focusRing)}
                      >
                        {it.title || "(sem título)"}
                      </button>
                      {dup && (
                        <span className="ml-2 rounded border border-amber-500/40 bg-amber-500/10 px-1 text-[10px] text-amber-200">
                          título repetido
                        </span>
                      )}
                      {it.note && <span className="ml-2 text-[10px] text-neutral-500">· com nota</span>}
                    </td>
                    <td className="min-w-[220px] px-2 py-1.5">
                      <input
                        className={inlineInputClass}
                        value={it.keywordEn}
                        onChange={(e) => patch(it.id, { keywordEn: e.target.value })}
                        placeholder="keyword foco"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <select className={rowSelectClass} value={it.owner} onChange={(e) => patch(it.id, { owner: e.target.value })}>
                        <option value="">—</option>
                        {opts.owner.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-1.5 rounded-full", (STATUS_DOT[it.status] ?? "bg-neutral-600"))} aria-hidden />
                        <select className={rowSelectClass} value={it.status} onChange={(e) => patch(it.id, { status: e.target.value as Status })}>
                          <option value="">—</option>
                          {opts.status.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))}
                        </select>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <input
                        type="date"
                        value={it.scheduledFor}
                        onChange={(e) => patch(it.id, { scheduledFor: e.target.value })}
                        className={cn(rowSelectClass, "[color-scheme:dark]")}
                      />
                    </td>
                    <td className="px-2 py-2">
                      <button
                        aria-label="Remover"
                        onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}
                        className={cn("grid size-8 place-items-center rounded text-neutral-600 hover:text-red-300", focusRing)}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {loaded && tableRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-3 py-10 text-center text-sm text-neutral-500">
                    Nenhum conteúdo com esses filtros.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      ) : view === "calendar" ? (
        <CalendarView items={filtered} onOpen={setOpenId} />
      ) : view === "published" ? (
        <PublishedTable
          rows={publishedRows}
          opts={opts}
          onOpen={setOpenId}
          onPatch={patch}
        />
      ) : (
        <MetricsView items={items} opts={opts} />
      )}

      <AddDialog
        opts={opts}
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(it) => setItems((prev) => [it, ...prev])}
      />
      <CardDialog
        opts={opts}
        item={openItem}
        onClose={() => setOpenId(null)}
        onPatch={(p) => openItem && patch(openItem.id, p)}
      />
    </div>
  );
}

function CalendarView({
  items,
  onOpen,
}: {
  items: EditorialItem[];
  onOpen: (id: string) => void;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());
  const today = todayYmd();

  const byDate = useMemo(() => {
    const m = new Map<string, EditorialItem[]>();
    for (const it of items) {
      if (!it.scheduledFor) continue;
      const list = m.get(it.scheduledFor) ?? [];
      list.push(it);
      m.set(it.scheduledFor, list);
    }
    return m;
  }, [items]);

  const unscheduled = items.filter((i) => !i.scheduledFor).length;
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // monday-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: Array<number | null> = [
    ...Array(lead).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setYear(d.getFullYear());
    setMonth(d.getMonth());
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <button onClick={() => shift(-1)} className="rounded border border-white/10 p-1 text-neutral-300 hover:bg-white/5" aria-label="Mês anterior">
          <ChevronLeft className="size-4" />
        </button>
        <h2 className="w-44 text-center text-sm font-medium text-neutral-100">
          {MONTHS[month]} {year}
        </h2>
        <button onClick={() => shift(1)} className="rounded border border-white/10 p-1 text-neutral-300 hover:bg-white/5" aria-label="Próximo mês">
          <ChevronRight className="size-4" />
        </button>
        <button
          onClick={() => { setYear(now.getFullYear()); setMonth(now.getMonth()); }}
          className="text-xs text-neutral-400 hover:text-neutral-200"
        >
          hoje
        </button>
        <span className="ml-auto text-xs text-neutral-500">{unscheduled} sem data (ficam só na tabela)</span>
      </div>
      <div className="grid grid-cols-7 overflow-hidden rounded-lg border border-white/10 text-xs">
        {WEEKDAYS.map((w) => (
          <div key={w} className="border-b border-white/10 bg-white/[0.03] px-2 py-1 uppercase tracking-wider text-neutral-500">
            {w}
          </div>
        ))}
        {cells.map((day, idx) => {
          const key = day ? ymd(year, month, day) : "";
          const list = day ? byDate.get(key) ?? [] : [];
          return (
            <div
              key={idx}
              className={cn(
                "min-h-[104px] border-b border-r border-white/[0.06] p-1.5",
                !day && "bg-white/[0.015]",
                key === today && "bg-violet-500/[0.07]",
              )}
            >
              {day && (
                <>
                  <div className={cn("mb-1 text-[11px]", key === today ? "font-semibold text-violet-300" : "text-neutral-500")}>
                    {day}
                  </div>
                  <div className="space-y-1">
                    {list.map((it) => (
                      <button
                        key={it.id}
                        onClick={() => onOpen(it.id)}
                        title={it.title}
                        className={cn(
                          "block w-full truncate rounded border px-1.5 py-0.5 text-left text-[11px]",
                          "border-l-2 border-white/[0.06] bg-white/[0.04] text-neutral-200 hover:bg-white/[0.08]",
                          priorityStripe(it.priority),
                          it.status === "published" && "opacity-50",
                          focusRing,
                        )}
                      >
                        {it.kind === "update" && "↻ "}
                        {it.title}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-neutral-500">
        Para agendar, defina a data na coluna “Agendado para” da tabela ou dentro do card.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

 type MonthRow = { key: string; label: string; created: number; updated: number };

// Every month from the first to the last one that has a dated published item (gaps show as 0).
function buildMonthRows(published: EditorialItem[]): MonthRow[] {
  const dated = published.filter((i) => /^\d{4}-\d{2}/.test(i.scheduledFor));
  if (dated.length === 0) return [];
  const counts = new Map<string, { created: number; updated: number }>();
  for (const it of dated) {
    const key = it.scheduledFor.slice(0, 7);
    const c = counts.get(key) ?? { created: 0, updated: 0 };
    if (it.kind === "update") c.updated += 1;
    else c.created += 1;
    counts.set(key, c);
  }
  const keys = [...counts.keys()].sort();
  const [fy, fm] = keys[0].split("-").map(Number);
  const [ly, lm] = keys[keys.length - 1].split("-").map(Number);
  const rows: MonthRow[] = [];
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    const key = `${y}-${pad(m)}`;
    const c = counts.get(key) ?? { created: 0, updated: 0 };
    rows.push({ key, label: `${MONTHS[m - 1].slice(0, 3)} ${String(y).slice(2)}`, ...c });
  }
  return rows;
}

function monthName(key: string) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// Chart colors validated with the dataviz validator (dark surface, 2 categorical slots).
const VIZ_NEW = "#8b7cf0";
const VIZ_UPDATE = "#cf7a2a";

function niceMax(n: number) {
  if (n <= 2) return 2;
  if (n <= 4) return 4;
  const step = n <= 10 ? 2 : n <= 20 ? 5 : 10;
  return Math.ceil(n / step) * step;
}

// A period is any set of months (sorted keys "YYYY-MM"). Empty period = every month.
type MonthSet = string[];

const keyOf = (y: number, m: number) => `${y}-${pad(m + 1)}`;
function addMonths(key: string, n: number) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return keyOf(d.getFullYear(), d.getMonth());
}
function shortMonth(key: string) {
  const [y, m] = key.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${String(y).slice(2)}`;
}
const sortedSet = (keys: string[]) => [...new Set(keys)].sort();

function setLabel(set: MonthSet, empty = "Todos os meses") {
  if (set.length === 0) return empty;
  if (set.length === 1) return monthName(set[0]);
  const contiguous = set.every((k, idx) => idx === 0 || addMonths(set[idx - 1], 1) === k);
  if (contiguous) return `${shortMonth(set[0])} – ${shortMonth(set[set.length - 1])}`;
  return set.length <= 3 ? set.map(shortMonth).join(", ") : `${set.length} meses`;
}

// One control for the metrics view. Two tabs on the same month grid:
// "Período" (the months you look at) and "Comparar" (any months to compare against).
// Months toggle one by one, so any combination works; presets are shortcuts.
function PeriodPicker({
  period,
  compare,
  withData,
  onApply,
}: {
  period: MonthSet;
  compare: MonthSet;
  withData: Set<string>;
  onApply: (period: MonthSet, compare: MonthSet) => void;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(new Date().getFullYear());
  const [tab, setTab] = useState<"period" | "compare">("period");
  const [a, setA] = useState<MonthSet>([]);
  const [b, setB] = useState<MonthSet>([]);

  const now = new Date();
  const thisMonth = keyOf(now.getFullYear(), now.getMonth());
  const yearKeys = (y: number) => Array.from({ length: 12 }, (_, m) => keyOf(y, m));

  const periodPresets: { label: string; set: MonthSet }[] = [
    { label: "Todos os meses", set: [] },
    { label: "Este mês", set: [thisMonth] },
    { label: "Mês passado", set: [addMonths(thisMonth, -1)] },
    { label: "Últimos 3 meses", set: [addMonths(thisMonth, -2), addMonths(thisMonth, -1), thisMonth] },
    { label: "Este ano", set: yearKeys(now.getFullYear()) },
    { label: "Ano passado", set: yearKeys(now.getFullYear() - 1) },
  ];
  // Compare shortcuts are built from the period, so they need one.
  const comparePresets: { label: string; set: MonthSet | null }[] = [
    { label: "Sem comparação", set: [] },
    { label: "Período anterior", set: a.length ? sortedSet(a.map((k) => addMonths(k, -a.length))) : null },
    { label: "Mesmo período, ano passado", set: a.length ? sortedSet(a.map((k) => addMonths(k, -12))) : null },
  ];

  const openWith = () => {
    setA(period);
    setB(compare);
    setTab("period");
    setYear(Number((period[period.length - 1] ?? thisMonth).slice(0, 4)));
  };
  const toggle = (key: string) => {
    const setter = tab === "period" ? setA : setB;
    setter((cur) => sortedSet(cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]));
  };
  const apply = () => {
    onApply(a, b);
    setOpen(false);
  };

  const summary = compare.length
    ? `${setLabel(period)} vs ${setLabel(compare)}`
    : setLabel(period);

  const cell = (key: string) => {
    const inA = a.includes(key);
    const inB = b.includes(key);
    return cn(
      "relative rounded-md border py-2 text-sm",
      focusRing,
      inA ? "bg-violet-500/30 text-violet-50" : "text-neutral-300 hover:bg-white/[0.05]",
      inB ? "border-dashed border-amber-300/70" : "border-transparent",
      !inA && inB && "text-neutral-100",
    );
  };

  const tabClass = (active: boolean) =>
    cn(
      "flex-1 whitespace-nowrap rounded px-2 py-1 text-xs",
      focusRing,
      active ? "bg-white/10 text-neutral-100" : "text-neutral-400 hover:text-neutral-200",
    );
  const presetClass = (active: boolean, disabled = false) =>
    cn(
      "w-full rounded-md px-3 py-1.5 text-left text-sm",
      focusRing,
      disabled
        ? "cursor-not-allowed text-neutral-600"
        : active
          ? "bg-white/10 text-neutral-100"
          : "text-neutral-300 hover:bg-white/[0.05]",
    );
  const same = (x: MonthSet, y: MonthSet) => x.length === y.length && x.every((k, idx) => k === y[idx]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        if (o) openWith();
        setOpen(o);
      }}
    >
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-lg border border-white/10 bg-neutral-900 px-3 text-sm hover:border-white/20",
            focusRing,
          )}
        >
          <span className="text-neutral-100">Período</span>
          <span className="text-neutral-400">{summary}</span>
          <ChevronsUpDown className="size-3.5 text-neutral-500" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto border-white/10 bg-neutral-950 p-0">
        <div className="flex">
          <ul className="w-52 space-y-0.5 border-r border-white/[0.06] p-2">
            {tab === "period"
              ? periodPresets.map((pr) => (
                  <li key={pr.label}>
                    <button
                      onClick={() => {
                        setA(pr.set);
                        if (pr.set.length) setYear(Number(pr.set[pr.set.length - 1].slice(0, 4)));
                      }}
                      className={presetClass(same(a, pr.set))}
                    >
                      {pr.label}
                    </button>
                  </li>
                ))
              : comparePresets.map((pr) => (
                  <li key={pr.label}>
                    <button
                      disabled={!pr.set}
                      onClick={() => {
                        if (!pr.set) return;
                        setB(pr.set);
                        if (pr.set.length) setYear(Number(pr.set[pr.set.length - 1].slice(0, 4)));
                      }}
                      className={presetClass(!!pr.set && same(b, pr.set), !pr.set)}
                      title={!pr.set ? "Escolha primeiro os meses do período" : undefined}
                    >
                      {pr.label}
                    </button>
                  </li>
                ))}
          </ul>

          <div className="w-72 space-y-3 p-3">
            <div className="flex rounded-md border border-white/10 p-0.5">
              <button onClick={() => setTab("period")} className={tabClass(tab === "period")}>
                <span className="mr-1.5 inline-block size-2 rounded-sm bg-violet-400" /> Período
              </button>
              <button onClick={() => setTab("compare")} className={tabClass(tab === "compare")}>
                <span className="mr-1.5 inline-block size-2 rounded-sm border border-dashed border-amber-300" /> Comparar com
              </button>
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <button onClick={() => setYear((y) => y - 1)} aria-label="Ano anterior" className={cn("rounded p-1 text-neutral-400 hover:text-neutral-100", focusRing)}>
                  <ChevronLeft className="size-4" />
                </button>
                <span className="text-sm font-medium text-neutral-100">{year}</span>
                <button onClick={() => setYear((y) => y + 1)} aria-label="Próximo ano" className={cn("rounded p-1 text-neutral-400 hover:text-neutral-100", focusRing)}>
                  <ChevronRight className="size-4" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-1">
                {MONTHS.map((name, m) => {
                  const key = keyOf(year, m);
                  return (
                    <button key={key} onClick={() => toggle(key)} className={cell(key)}>
                      {name.slice(0, 3)}
                      {withData.has(key) && (
                        <span className="absolute bottom-1 left-1/2 size-1 -translate-x-1/2 rounded-full bg-neutral-400" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-neutral-500">
                {tab === "period"
                  ? "Clique nos meses que quer ver (sem nenhum = todos). O ponto marca meses com publicações."
                  : "Clique nos meses que quer comparar. Pode ser qualquer combinação, até de outros anos."}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-3 py-2">
          <span className="text-xs text-neutral-400">
            {setLabel(a)}
            {b.length > 0 && ` vs ${setLabel(b)}`}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" className="h-8 px-3 text-xs" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button className="h-8 bg-violet-600 px-3 text-xs text-white hover:bg-violet-500" onClick={apply}>
              Aplicar
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function Strip({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-neutral-300">{title}</h3>
        {hint && <span className="text-xs text-neutral-500">{hint}</span>}
        <div className="h-px flex-1 bg-white/[0.07]" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">{children}</div>
    </section>
  );
}

function Tile({
  label,
  value,
  caption,
  extra,
  progress,
}: {
  label: string;
  value: React.ReactNode;
  caption?: React.ReactNode;
  extra?: React.ReactNode;
  progress?: number; // 0-100
}) {
  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-4">
      <div className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="mt-2 text-3xl font-semibold text-neutral-100">{value}</div>
      {caption && <div className="mt-1 text-xs text-neutral-500">{caption}</div>}
      {extra && <div className="mt-1 text-xs text-neutral-400">{extra}</div>}
      {progress !== undefined && (
        <div className="mt-3 h-1 overflow-hidden rounded-full bg-white/[0.07]">
          <div className="h-full rounded-full" style={{ width: `${progress}%`, background: VIZ_NEW }} />
        </div>
      )}
    </div>
  );
}

const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
const fmt1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}`;

function MetricsView({ items, opts }: { items: EditorialItem[]; opts: Options }) {
  const [period, setPeriod] = useState<MonthSet>([]); // empty = all months
  const [compare, setCompare] = useState<MonthSet>([]);
  const [hover, setHover] = useState<string | null>(null);

  const published = items.filter((i) => i.status === "published");
  const rows = buildMonthRows(published);
  const withData = new Set(rows.filter((r) => r.created + r.updated > 0).map((r) => r.key));
  const rowFor = (key: string): MonthRow => {
    const list = published.filter((i) => i.scheduledFor.startsWith(key));
    return {
      key,
      label: shortMonth(key),
      created: list.filter((i) => i.kind !== "update").length,
      updated: list.filter((i) => i.kind === "update").length,
    };
  };
  // With a period picked, the chart shows only the chosen months (period + comparison);
  // with none, every month that has data.
  const chartRows = period.length ? sortedSet([...period, ...compare]).map(rowFor) : rows;
  // Bars are grouped (novos | atualizações), so the scale follows the tallest single bar.
  const top = niceMax(Math.max(0, ...chartRows.flatMap((r) => [r.created, r.updated])));
  const ticks = [top, top / 2, 0];
  // Period figures use the period's own months; the comparison months only widen the chart.
  const periodRows = period.length ? chartRows.filter((r) => period.includes(r.key)) : chartRows;
  const best = periodRows.length ? periodRows.reduce((a, b) => (b.created + b.updated > a.created + a.updated ? b : a)) : null;
  const undated = published.filter((i) => !i.scheduledFor).length;

  const comparing = compare.length > 0;
  const scopeOf = (set: MonthSet) =>
    set.length ? published.filter((i) => i.scheduledFor && set.includes(i.scheduledFor.slice(0, 7))) : published;
  const statsOf = (list: EditorialItem[]) => ({
    total: list.length,
    created: list.filter((i) => i.kind === "new").length,
    updated: list.filter((i) => i.kind === "update").length,
  });

  const scope = scopeOf(period);
  const statA = statsOf(scope);
  const statB = comparing ? statsOf(scopeOf(compare)) : null;
  const scopeLabel = setLabel(period);
  const readout = chartRows.find((r) => r.key === hover) ?? null;

  // ---- today's state (ignores the period) ----
  const today = todayYmd();
  const label = (id: string) =>
    opts.status.find((o) => o.id === id)?.label ?? DEFAULT_OPTIONS.status.find((o) => o.id === id)?.label ?? id;
  const countStatus = (id: string) => items.filter((i) => i.status === id).length;
  const topPriorities = opts.priority.slice(0, 2);
  const isTop = (i: EditorialItem) => topPriorities.some((o) => o.id === i.priority);
  const upcoming = items
    .filter((i) => i.status === "scheduled" && i.scheduledFor && i.scheduledFor >= today)
    .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor));
  const pendingTop = items.filter((i) => isTop(i) && i.status !== "published");
  const ownerless = pendingTop.filter((i) => !i.owner).length;

  if (rows.length === 0) {
    return (
      <p className="rounded-lg border border-white/10 px-3 py-12 text-center text-sm text-neutral-500">
        Nenhum conteúdo publicado com data ainda. Agende um conteúdo na Tabela e, passada a data, ele aparece aqui.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <PeriodPicker
            period={period}
            compare={compare}
            withData={withData}
            onApply={(p, c) => {
              setPeriod(p);
              setCompare(c);
            }}
          />
          <div className="ml-auto flex items-center gap-4 text-[11px] text-neutral-400">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: VIZ_NEW }} /> Novos
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: VIZ_UPDATE }} /> Atualizações
            </span>
            {comparing && (
              <>
                <span className="flex items-center gap-1.5">
                  <span className="grid size-4 place-items-center rounded bg-violet-500/30 text-[10px] text-violet-100">A</span> Período
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="grid size-4 place-items-center rounded border border-dashed border-amber-300/70 text-[10px] text-neutral-100">B</span> Comparação
                </span>
              </>
            )}
          </div>
        </div>

        <Strip
          title="Volume"
          hint={`O que saiu · ${scopeLabel}${comparing ? ` vs ${setLabel(compare)}` : ""}`}
        >
          <Tile
            label="Publicados"
            value={statA.total}
            caption={`${statA.created} novos · ${statA.updated} atualizações`}
            extra={statB && `B: ${statB.total} · ${signed(statA.total - statB.total)}`}
          />
          <Tile
            label="Média por mês"
            value={fmt1(periodRows.length ? statA.total / periodRows.length : 0)}
            caption={`em ${periodRows.length} ${periodRows.length === 1 ? "mês" : "meses"}`}
            extra={statB && compare.length > 0 && `B: ${fmt1(statB.total / compare.length)}`}
          />
          <Tile
            label="Mês mais produtivo"
            value={best ? shortMonth(best.key) : "—"}
            caption={best ? `${best.created + best.updated} publicados` : undefined}
          />
          <Tile
            label="Atualizações"
            value={statA.updated}
            caption={statA.total ? `${Math.round((statA.updated / statA.total) * 100)}% dos publicados` : "—"}
            extra={statB && `B: ${statB.updated} · ${signed(statA.updated - statB.updated)}`}
          />
        </Strip>

        <div className="rounded-lg border border-white/10 p-4">
          <div className="mb-3 h-5 text-xs text-neutral-400">
            {readout ? (
              <>
                <span className="text-neutral-200">{monthName(readout.key)}</span>
                {" · "}
                <span className="font-medium text-neutral-100">{readout.created}</span> novos
                {" · "}
                <span className="font-medium text-neutral-100">{readout.updated}</span> atualizações
              </>
            ) : (
              <>
                Passe o mouse numa coluna para ver o mês
                {best && periodRows.length > 1 && ` · mais produtivo: ${monthName(best.key)} (${best.created + best.updated})`}
              </>
            )}
          </div>

          <div className="flex gap-3 overflow-x-auto">
            <div className="flex h-44 w-6 shrink-0 flex-col justify-between text-right text-[11px] tabular-nums text-neutral-500">
              {ticks.map((t) => (
                <span key={t} className="leading-none">{t}</span>
              ))}
            </div>
            <div className="relative min-w-0 flex-1" style={{ minWidth: chartRows.length * 56 }}>
              <div className="pointer-events-none absolute inset-x-0 top-0 flex h-44 flex-col justify-between">
                {ticks.map((t) => (
                  <div key={t} className="h-px w-full bg-white/[0.07]" />
                ))}
              </div>
              <div className="relative flex h-44">
                {chartRows.map((r) => {
                  const bars = [
                    { v: r.created, color: VIZ_NEW, name: "novos" },
                    { v: r.updated, color: VIZ_UPDATE, name: "atualizações" },
                  ];
                  return (
                    <button
                      key={r.key}
                      onClick={() => setPeriod((cur) => (cur.length === 1 && cur[0] === r.key ? [] : [r.key]))}
                      onPointerEnter={() => setHover(r.key)}
                      onPointerLeave={() => setHover((h) => (h === r.key ? null : h))}
                      onFocus={() => setHover(r.key)}
                      onBlur={() => setHover((h) => (h === r.key ? null : h))}
                      aria-label={`${monthName(r.key)}: ${r.created} novos, ${r.updated} atualizações`}
                      className={cn(
                        "flex h-full min-w-0 flex-1 items-end justify-center rounded-sm",
                        focusRing,
                        hover === r.key && "bg-white/[0.04]",
                      )}
                    >
                      {/* bars grow with the slot: wide with a few months, slimmer with many */}
                      <div className="flex h-full w-[72%] max-w-44 items-end gap-1.5">
                        {bars.map((b) => (
                          <div key={b.name} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
                            <span className={cn("mb-1 text-xs tabular-nums", b.v ? "text-neutral-200" : "text-neutral-600")}>{b.v}</span>
                            <div
                              className="w-full rounded-t-[4px]"
                              style={{ height: `${(b.v / top) * 88}%`, background: b.color }}
                            />
                          </div>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-2 flex">
                {chartRows.map((r) => (
                  <div key={r.key} className="min-w-0 flex-1 text-center">
                    <div className={cn("text-[11px]", period.includes(r.key) ? "text-neutral-100" : "text-neutral-500")}>{r.label}</div>
                    <div className="mt-1 flex h-4 items-center justify-center gap-1">
                      {comparing && period.includes(r.key) && (
                        <span className="grid size-4 place-items-center rounded bg-violet-500/30 text-[10px] text-violet-100">A</span>
                      )}
                      {comparing && compare.includes(r.key) && (
                        <span className="grid size-4 place-items-center rounded border border-dashed border-amber-300/70 text-[10px] text-neutral-100">B</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
        {undated > 0 && (
          <p className="text-[11px] text-neutral-500">{undated} publicados sem data não entram nos meses.</p>
        )}
      </section>

      <Strip title="Pipeline" hint="Em andamento hoje">
        <Tile
          label={label("backlog")}
          value={countStatus("backlog")}
          caption={`${items.filter((i) => i.status === "backlog" && isTop(i)).length} são ${topPriorities.map((o) => o.label).join("/")}`}
        />
        <Tile label={label("writing")} value={countStatus("writing")} />
        <Tile label={label("review")} value={countStatus("review")} />
        <Tile
          label={label("scheduled")}
          value={upcoming.length}
          caption={upcoming[0] ? `próximo: ${ddmm(upcoming[0].scheduledFor)}` : "nada com data futura"}
        />
      </Strip>

      <Strip title="Backlog" hint="O que falta, por prioridade">
        {opts.priority.map((o) => {
          const all = items.filter((i) => i.priority === o.id);
          const done = all.filter((i) => i.status === "published").length;
          return (
            <Tile
              key={o.id}
              label={`${o.label} restantes`}
              value={all.length - done}
              caption={`${done} de ${all.length} publicados`}
              progress={all.length ? Math.round((done / all.length) * 100) : 0}
            />
          );
        })}
        <Tile
          label="Sem responsável"
          value={ownerless}
          caption={`de ${pendingTop.length} ${topPriorities.map((o) => o.label).join("/")} pendentes`}
        />
      </Strip>
    </div>
  );
}

function PublishedTable({
  rows,
  opts,
  onOpen,
  onPatch,
}: {
  rows: EditorialItem[];
  opts: Options;
  onOpen: (id: string) => void;
  onPatch: (id: string, p: Partial<EditorialItem>) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead className="bg-white/[0.03] text-[11px] uppercase tracking-wider text-neutral-500">
          <tr>
            <th className="px-3 py-2 font-medium">Publicado em</th>
            <th className="px-3 py-2 font-medium">Título</th>
            <th className="px-3 py-2 font-medium">Tipo</th>
            <th className="px-3 py-2 font-medium">Categoria</th>
            <th className="px-3 py-2 font-medium">Responsável</th>
            <th className="px-3 py-2 font-medium">URL do post</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/[0.06]">
          {rows.map((it) => (
            <tr
              key={it.id}
              className="cursor-pointer align-top hover:bg-white/[0.04]"
              onClick={(e) => {
                if ((e.target as HTMLElement).closest("select, input, button, a")) return;
                onOpen(it.id);
              }}
            >
              <td className="px-3 py-2">
                <input
                  type="date"
                  value={it.scheduledFor}
                  onChange={(e) => onPatch(it.id, { scheduledFor: e.target.value })}
                  className={cn(rowSelectClass, "[color-scheme:dark]")}
                />
              </td>
              <td className="max-w-[380px] px-3 py-2 text-neutral-100">{it.title}</td>
              <td className={cn("px-3 py-2 text-xs", it.kind === "update" ? "font-medium text-violet-300" : "text-neutral-500")}>
                {it.kind === "update" ? "Atualização" : "Novo"}
              </td>
              <td className="px-3 py-2 text-xs text-neutral-400">{labelOf(opts.category, it.category)}</td>
              <td className="px-3 py-2 text-xs text-neutral-400">{labelOf(opts.owner, it.owner)}</td>
              <td className="min-w-[240px] px-2 py-1.5">
                <input
                  className={inlineInputClass}
                  value={it.publishedUrl}
                  onChange={(e) => onPatch(it.id, { publishedUrl: e.target.value })}
                  placeholder="https://…"
                />
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-10 text-center text-sm text-neutral-500">
                Nada publicado ainda.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t border-white/[0.06] pt-4">
      <h3 className="text-xs font-medium text-neutral-300">{title}</h3>
      {children}
    </section>
  );
}

function CardDialog({
  opts,
  item,
  onClose,
  onPatch,
}: {
  opts: Options;
  item: EditorialItem | null;
  onClose: () => void;
  onPatch: (p: Partial<EditorialItem>) => void;
}) {
  return (
    <Dialog open={!!item} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        {item && (
          <>
            <DialogHeader>
              <DialogTitle className="sr-only">{item.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <Field label="Título">
                <Input value={item.title} onChange={(e) => onPatch({ title: e.target.value })} className="text-base font-medium" />
              </Field>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Field label="Tipo">
                  <select className={cn(selectClass, "w-full")} value={item.kind} onChange={(e) => onPatch({ kind: e.target.value as Kind })}>
                    <option value="new">Novo</option>
                    <option value="update">Atualização</option>
                  </select>
                </Field>
                <Field label="Prioridade">
                  <select className={cn(selectClass, "w-full")} value={item.priority} onChange={(e) => onPatch({ priority: e.target.value as Priority })}>
                    <option value="">—</option>
                    {opts.priority.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Categoria">
                  <select className={cn(selectClass, "w-full")} value={item.category} onChange={(e) => onPatch({ category: e.target.value })}>
                    <option value="">—</option>
                    {opts.category.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Responsável">
                  <select className={cn(selectClass, "w-full")} value={item.owner} onChange={(e) => onPatch({ owner: e.target.value })}>
                    <option value="">—</option>
                    {opts.owner.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Status">
                  <select className={cn(selectClass, "w-full")} value={item.status} onChange={(e) => onPatch({ status: e.target.value as Status })}>
                    <option value="">—</option>
                    {opts.status.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </Field>
                <Field label="Agendado para">
                  <input
                    type="date"
                    value={item.scheduledFor}
                    onChange={(e) => onPatch({ scheduledFor: e.target.value })}
                    className={cn(selectClass, "w-full [color-scheme:dark]")}
                  />
                </Field>
              </div>

              <Field label="Anotações">
                <Textarea
                  value={item.note}
                  onChange={(e) => onPatch({ note: e.target.value })}
                  placeholder="Decisões, links, pendências…"
                  rows={4}
                />
              </Field>

              {item.status === "published" && (
                <Field label="URL do post publicado">
                  <Input
                    value={item.publishedUrl}
                    onChange={(e) => onPatch({ publishedUrl: e.target.value })}
                    placeholder="https://kodus.io/en/…"
                  />
                </Field>
              )}

              <Section title="SEO">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Keyword foco (EN)">
                  <Input value={item.keywordEn} onChange={(e) => onPatch({ keywordEn: e.target.value })} />
                </Field>
                <Field label="Keywords secundárias (EN)">
                  <Textarea value={item.secondaryEn} onChange={(e) => onPatch({ secondaryEn: e.target.value })} rows={2} />
                </Field>
                <Field label="Sugestão de título (EN)">
                  <Textarea value={item.titleEn} onChange={(e) => onPatch({ titleEn: e.target.value })} rows={2} />
                </Field>
              </div>
              </Section>

              <Section title="Briefing">
              <Field label="O que abordar">
                <Textarea value={item.outline} onChange={(e) => onPatch({ outline: e.target.value })} rows={5} />
              </Field>

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Página existente relacionada (referência)">
                  <Textarea value={item.reference} onChange={(e) => onPatch({ reference: e.target.value })} rows={2} />
                </Field>
                <Field label="Cluster com volume medido (EUA/mês)">
                  <Textarea value={item.cluster} onChange={(e) => onPatch({ cluster: e.target.value })} rows={2} />
                </Field>
                <Field label="Observações">
                  <Textarea value={item.observations} onChange={(e) => onPatch({ observations: e.target.value })} rows={3} />
                </Field>
                <Field label="Prompt rastreado relacionado">
                  <Textarea value={item.trackedPrompt} onChange={(e) => onPatch({ trackedPrompt: e.target.value })} rows={3} />
                </Field>
              </div>

              <Field label="Por que">
                <Textarea value={item.why} onChange={(e) => onPatch({ why: e.target.value })} rows={3} />
              </Field>
              </Section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddDialog({
  opts,
  open,
  onClose,
  onAdd,
}: {
  opts: Options;
  open: boolean;
  onClose: () => void;
  onAdd: (it: EditorialItem) => void;
}) {
  const [kind, setKind] = useState<Kind>("new");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<Priority>("");
  const [category, setCategory] = useState("");
  const [keyword, setKeyword] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const reset = () => {
    setKind("new"); setTitle(""); setPriority(""); setCategory(""); setKeyword(""); setReference(""); setNote("");
  };

  const defaultPriority = opts.priority.find((o) => o.id === "P2")?.id ?? opts.priority[0]?.id ?? "";
  // New items start in "backlog" if that status still exists, otherwise the first status
  // in the list, so deleting a status never brings it back through Add.
  const defaultStatus = opts.status.find((o) => o.id === "backlog")?.id ?? opts.status[0]?.id ?? "";

  const submit = () => {
    if (!title.trim()) return;
    onAdd(
      emptyItem({
        id: `local-${Date.now()}`,
        kind,
        priority: priority || defaultPriority,
        category: category || opts.category[0]?.id || "",
        title: title.trim(),
        keywordEn: keyword.trim(),
        reference: reference.trim(),
        note: note.trim(),
        status: defaultStatus,
        stageDates: defaultStatus ? { [defaultStatus]: new Date().toISOString() } : {},
      }),
    );
    reset();
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Adicionar conteúdo</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="flex gap-2">
            {(["new", "update"] as Kind[]).map((k) => (
              <button
                key={k}
                onClick={() => setKind(k)}
                className={cn(
                  "flex-1 rounded-md border px-3 py-1.5 text-sm",
                  focusRing,
                  kind === k
                    ? "border-violet-400/60 bg-violet-500/10 text-violet-100"
                    : "border-white/10 text-neutral-400 hover:text-neutral-200",
                )}
              >
                {k === "new" ? "Novo" : "Atualização"}
              </button>
            ))}
          </div>
          <Field label="Título">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Best AI code review tools for monorepos" autoFocus />
          </Field>
          <Field label="Keyword foco (EN)">
            <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </Field>
          <Field label={kind === "update" ? "URL do post a atualizar" : "Página relacionada"}>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder={kind === "update" ? "/en/post-slug/" : "Opcional"}
            />
          </Field>
          <Field label="Anotações">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
          </Field>
          <div className="flex gap-2">
            <div className="flex-1">
              <Field label="Prioridade">
                <select className={cn(selectClass, "w-full")} value={priority || defaultPriority} onChange={(e) => setPriority(e.target.value)}>
                  {opts.priority.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="flex-1">
              <Field label="Categoria">
                <select className={cn(selectClass, "w-full")} value={category || opts.category[0]?.id || ""} onChange={(e) => setCategory(e.target.value)}>
                  {opts.category.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </Field>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onClose}>Cancelar</Button>
            <Button onClick={submit} disabled={!title.trim()} className="bg-violet-600 text-white hover:bg-violet-500">Adicionar</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FiltersPopover({
  options,
  counts,
  onAdd,
  onRename,
  onDelete,
}: {
  options: Options;
  counts: Record<OptionKey, Record<string, number>>;
  onAdd: (key: OptionKey, label: string) => boolean;
  onRename: (key: OptionKey, id: string, label: string) => boolean;
  onDelete: (key: OptionKey, id: string) => void;
}) {
  const [tab, setTab] = useState<OptionKey>("priority");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const group = OPTION_GROUPS.find((g) => g.key === tab)!;

  const switchTab = (k: OptionKey) => {
    setTab(k); setNewName(""); setError(""); setConfirming(null);
  };
  const add = () => {
    if (!newName.trim()) return;
    if (onAdd(tab, newName)) {
      setNewName("");
      setError("");
    } else {
      setError("Já existe uma opção com esse nome.");
    }
  };

  return (
    <Popover onOpenChange={() => { setError(""); setConfirming(null); }}>
      <PopoverTrigger asChild>
        <button className={cn(selectClass, "inline-flex items-center gap-1.5 hover:bg-white/5")}>
          <Pencil className="size-3" /> Editar filtros
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2 border-white/10 bg-neutral-950 p-3">
        <div className="flex rounded-md border border-white/10 p-0.5">
          {OPTION_GROUPS.map((g) => (
            <button
              key={g.key}
              onClick={() => switchTab(g.key)}
              className={cn(
                "flex-1 truncate rounded px-1.5 py-1 text-[11px]",
                focusRing,
                tab === g.key ? "bg-white/10 text-neutral-100" : "text-neutral-400 hover:text-neutral-200",
              )}
            >
              {g.label}
            </button>
          ))}
        </div>
        <ul className="space-y-1">
          {options[tab].map((o) => (
            <OptionRow
              key={`${tab}-${o.id}-${o.label}`}
              label={o.label}
              count={counts[tab][o.id] ?? 0}
              confirming={confirming === o.id}
              onAskDelete={() => setConfirming(o.id)}
              onCancelDelete={() => setConfirming(null)}
              onDelete={() => { onDelete(tab, o.id); setConfirming(null); }}
              onRename={(label) => onRename(tab, o.id, label)}
              onError={setError}
            />
          ))}
          {options[tab].length === 0 && <li className="px-1 text-xs text-neutral-500">Nenhuma opção.</li>}
        </ul>
        <div className="flex gap-1.5 border-t border-white/[0.06] pt-2">
          <Input
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setError(""); }}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder={`Nova opção de ${group.label.toLowerCase()}`}
            className="h-7 text-xs"
          />
          <Button onClick={add} disabled={!newName.trim()} className="h-7 bg-violet-600 px-2.5 text-xs text-white hover:bg-violet-500">
            Adicionar
          </Button>
        </div>
        {error && <p className="text-[11px] text-red-300">{error}</p>}
        <p className="text-[11px] text-neutral-500">
          Renomear muda só o nome. Excluir deixa os itens dessa opção sem valor.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function OptionRow({
  label,
  count,
  confirming,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onRename,
  onError,
}: {
  label: string;
  count: number;
  confirming: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onRename: (label: string) => boolean;
  onError: (m: string) => void;
}) {
  const [value, setValue] = useState(label);

  const commit = () => {
    if (value.trim() === label) return;
    if (onRename(value)) onError("");
    else {
      setValue(label);
      if (value.trim()) onError("Já existe uma opção com esse nome.");
    }
  };

  if (confirming) {
    return (
      <li className="flex items-center gap-2 rounded border border-red-500/30 bg-red-500/[0.06] px-2 py-1 text-xs">
        <span className="min-w-0 flex-1 truncate text-red-100">
          Excluir “{label}”?{count > 0 && ` ${count} itens ficam sem valor.`}
        </span>
        <button onClick={onDelete} className={cn("rounded text-red-200 hover:underline", focusRing)}>Excluir</button>
        <button onClick={onCancelDelete} className={cn("rounded text-neutral-400 hover:text-neutral-200", focusRing)}>Cancelar</button>
      </li>
    );
  }

  return (
    <li className="flex items-center gap-1.5">
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className={inlineInputClass}
      />
      <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-neutral-500">{count}</span>
      <button
        aria-label={`Excluir ${label}`}
        onClick={onAskDelete}
        className={cn("grid size-7 place-items-center rounded text-neutral-600 hover:text-red-300", focusRing)}
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
  );
}
