"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FunnelCell, FunnelData, FunnelNode, FunnelRate } from "@/lib/funnel/metrics";
import { getSupabaseBrowserClient } from "@/lib/supabase-browser";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Layout. Same grid as docs/funil-2026-09-01.excalidraw in kodus-growth, so the
// page and the drawing read the same way.
// ---------------------------------------------------------------------------

const W = 1600;
const H = 1100;
const BW = 300;
const BH = 60;
const C1 = 60;
const C2 = 460;
const C3 = 980;
// Rows are 120 apart: 60 of box and 60 of arrow, enough for two label lines
// plus the 8px a red outline adds above the next box.
const GAP = 60;
const R = [180, 300, 420, 540] as const;
const SY = [680, 800] as const;
const FY = SY[1] + BH + 64;

const INK = "var(--foreground)";
const MUTED = "var(--muted-foreground)";
const CARD = "var(--card)";
const TINT = "var(--accent)";
const CRIT = "var(--destructive)";
const VALUE = "var(--primary)";

type Pt = { x: number; y: number };

function monthOptions(count = 8): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = d.toISOString().slice(0, 7);
    const label = d.toLocaleDateString("pt-BR", { month: "long", year: "numeric", timeZone: "UTC" });
    out.push({ value, label: label.charAt(0).toUpperCase() + label.slice(1) });
  }
  return out;
}

function fmtTarget(n: FunnelNode): string {
  if (n.target == null) return "";
  if (n.id === "closed" || n.id === "arr") return ` → R$ ${Math.round(n.target / 1000)}k`;
  return ` → ${n.target}`;
}

function fmtCell(v: FunnelCell): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "sim" : "não";
  if (typeof v === "number") return Number.isInteger(v) ? v.toLocaleString("pt-BR") : v.toFixed(1);
  return v;
}

// ---------------------------------------------------------------------------
// SVG primitives
// ---------------------------------------------------------------------------

function Box({
  x,
  y,
  w = BW,
  node,
  spine = false,
  selected,
  onSelect,
}: {
  x: number;
  y: number;
  w?: number;
  node: FunnelNode | undefined;
  spine?: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  if (!node) return null;
  const notMeasured = node.value == null;
  return (
    <g
      role="button"
      tabIndex={0}
      onClick={() => onSelect(node.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelect(node.id);
      }}
      style={{ cursor: "pointer" }}
    >
      <rect
        x={x}
        y={y}
        width={w}
        height={BH}
        rx={6}
        fill={spine ? TINT : CARD}
        stroke={selected ? VALUE : INK}
        strokeWidth={selected ? 2.5 : 1.5}
      />
      <text x={x + 12} y={y + 25} fontSize={15} fontWeight={600} fill={INK}>
        {node.title}
      </text>
      <text
        x={x + 12}
        y={y + 47}
        fontSize={13.5}
        fontFamily="var(--font-mono), ui-monospace, monospace"
        fontWeight={500}
        fill={notMeasured ? MUTED : VALUE}
      >
        {node.display}
        {notMeasured ? "" : fmtTarget(node)}
      </text>
    </g>
  );
}

function Arrow({ from, to, label, lx, ly }: { from: Pt; to: Pt; label?: string; lx?: number; ly?: number }) {
  return (
    <>
      <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={INK} strokeWidth={1.5} markerEnd="url(#funnel-arrow)" />
      {label ? (
        <text x={lx ?? (from.x + to.x) / 2 + 10} y={ly ?? (from.y + to.y) / 2 + 4} fontSize={12.5} fill={MUTED}>
          {label}
        </text>
      ) : null}
    </>
  );
}

function Down({ x, y, label, second }: { x: number; y: number; label?: string; second?: string }) {
  return (
    <>
      <Arrow from={{ x: x + BW / 2, y: y + BH }} to={{ x: x + BW / 2, y: y + BH + GAP }} />
      {label ? (
        <text x={x + BW / 2 + 10} y={y + BH + (second ? 20 : 34)} fontSize={12.5} fill={MUTED}>
          {label}
        </text>
      ) : null}
      {second ? (
        <text x={x + BW / 2 + 10} y={y + BH + 38} fontSize={12} fill={MUTED}>
          {second}
        </text>
      ) : null}
    </>
  );
}

function Gargalo({
  x,
  y,
  w = BW,
  lines,
  side,
}: {
  x: number;
  y: number;
  w?: number;
  lines: string[];
  side: "left" | "right";
}) {
  const tx = side === "left" ? x - 18 : x + w + 18;
  const anchor = side === "left" ? "end" : "start";
  return (
    <>
      <rect x={x - 8} y={y - 8} width={w + 16} height={BH + 16} rx={9} fill="none" stroke={CRIT} strokeWidth={2.5} />
      {lines.map((t, i) => (
        <text key={i} x={tx} y={y + BH / 2 - 8 + i * 18} fontSize={13} fontWeight={i === 0 ? 600 : 500} fill={CRIT} textAnchor={anchor}>
          {i === 0 ? `GARGALO · ${t}` : t}
        </text>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

const GOOD = "#1f7a4d";
const WARN = "#a8690f";

/** Where a red marker goes for each stage, and which side has room for text. */
const MARKER_SLOTS: Record<string, { x: number; y: number; w?: number; side: "left" | "right" }> = {
  signups: { x: C2, y: R[1], side: "left" },
  connected: { x: C2, y: R[2], side: "right" },
  icp: { x: C2, y: R[3], side: "right" },
  conversations: { x: C2, y: SY[0], side: "left" },
  opportunities: { x: C2, y: SY[1], side: "left" },
  closed: { x: C2, y: FY, side: "left" },
  ob_replies: { x: C3, y: R[1], side: "right" },
};

function statusColor(status: FunnelRate["status"]): string {
  if (status === "good") return GOOD;
  if (status === "warn") return WARN;
  if (status === "crit") return CRIT;
  return MUTED;
}

/** Arrow label built from a rate: text plus a dot when it sits outside the market band. */
function RateLabel({ rate, x, y, size = 12.5 }: { rate: FunnelRate | undefined; x: number; y: number; size?: number }) {
  if (!rate) return null;
  const flagged = rate.status === "good" || rate.status === "warn" || rate.status === "crit";
  const text = rate.value == null ? `${rate.label}: não medido` : rate.label;
  return (
    <>
      {flagged ? <circle cx={x + 4} cy={y - 4} r={4} fill={statusColor(rate.status)} /> : null}
      <text x={flagged ? x + 12 : x} y={y} fontSize={size} fill={rate.value == null ? CRIT : MUTED}>
        {text}
        {flagged && rate.note ? ` · ${rate.note}` : ""}
      </text>
    </>
  );
}

export function Diagram({
  data,
  selected,
  onSelect,
}: {
  data: FunnelData;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const n = data.nodes;
  const f = data.facts;
  const rate = (id: string) => data.rates.find((r) => r.id === id);
  const box = (id: string, x: number, y: number, extra: { w?: number; spine?: boolean } = {}) => (
    <Box x={x} y={y} w={extra.w} spine={extra.spine} node={n[id]} selected={selected === id} onSelect={onSelect} />
  );

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Funil Kodus com números do mês" className="h-auto w-full min-w-[960px]">
      <defs>
        <marker id="funnel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={INK} />
        </marker>
      </defs>

      {/* headers */}
      <text x={C2} y={22} fontSize={12.5} fill={MUTED}>
        INBOUND CLOUD · tudo por mês · % na seta = corte da etapa
        {data.elapsed < 1 ? ` · mês em curso: metas pró-rata (${Math.round(data.elapsed * 100)}%)` : ""}
      </text>
      <text x={C1} y={148} fontSize={12.5} fill={MUTED}>
        SELF-HOSTED
      </text>
      <text x={C3} y={132} fontSize={12.5} fill={MUTED}>
        OUTBOUND · só empresa nova (não cadastrada)
      </text>

      {/* top sources */}
      {box("impressions", C2 - 150, 40, { w: 340 })}
      <Arrow from={{ x: C2 - 150 + 170, y: 100 }} to={{ x: C2 + BW / 2 - 40, y: R[0] - 2 }} />
      <RateLabel rate={rate("ctr")} x={C2 - 40} y={130} />
      {box("llm_referral", C2 + 220, 40, { w: 380 })}
      <Arrow from={{ x: C2 + 220 + 190, y: 100 }} to={{ x: C2 + BW / 2 + 40, y: R[0] - 2 }} />
      <text x={C2 + BW / 2 + 70} y={130} fontSize={12.5} fill={MUTED}>
        fora dos cliques (GSC conta só Google)
      </text>

      {/* inbound spine */}
      {box("visits", C2, R[0])}
      <Arrow from={{ x: C2 + BW / 2, y: R[0] + BH }} to={{ x: C2 + BW / 2, y: R[0] + BH + GAP }} />
      <RateLabel rate={rate("visit_to_signup")} x={C2 + BW / 2 + 10} y={R[0] + BH + 20} />
      <RateLabel rate={rate("survey")} x={C2 + BW / 2 + 10} y={R[0] + BH + 38} size={12} />

      {box("signups", C2, R[1])}
      <Down x={C2} y={R[1]} />
      <RateLabel rate={rate("connected")} x={C2 + BW / 2 + 10} y={R[1] + BH + 34} />

      {box("connected", C2, R[2])}
      <Down x={C2} y={R[2]} />
      <RateLabel rate={rate("icp_share")} x={C2 + BW / 2 + 10} y={R[2] + BH + 20} />
      <text x={C2 + BW / 2 + 10} y={R[2] + BH + 38} fontSize={12} fill={MUTED}>
        {[f.platform_split, f.icp_free_mail].filter(Boolean).join(" · ")}
      </text>

      {box("icp", C2, R[3], { spine: true })}
      <Arrow from={{ x: C2 + BW / 2, y: R[3] + BH }} to={{ x: C2 + BW / 2, y: SY[0] }} />
      <RateLabel rate={rate("touch_48h")} x={C2 + BW / 2 + 10} y={R[3] + BH + 34} />

      {box("conversations", C2, SY[0], { spine: true })}
      <Down x={C2} y={SY[0]} />
      <RateLabel rate={rate("conv_to_opp")} x={C2 + BW / 2 + 10} y={SY[0] + BH + 34} />

      {box("opportunities", C2, SY[1], { spine: true })}
      <Arrow from={{ x: C2 + BW / 2, y: SY[1] + BH }} to={{ x: C2 + BW / 2, y: FY }} />
      <RateLabel rate={rate("opp_active")} x={C2 + BW / 2 + 10} y={SY[1] + BH + 34} />

      {box("closed", C2, FY, { spine: true })}
      <Arrow from={{ x: C2 + BW / 2, y: FY + BH }} to={{ x: C2 + BW / 2, y: FY + 100 }} />
      {box("arr", C2, FY + 100, { spine: true })}

      {/* self-hosted */}
      {box("sh_instances", C1, R[0])}
      <Arrow from={{ x: C1 + 50, y: R[0] + BH }} to={{ x: C1 + 50, y: R[3] }} />
      <text x={C1 + 60} y={R[0] + BH + 34} fontSize={12.5} fill={MUTED}>
        pedidos de trial: {n.sh_trial?.value ?? "?"}
      </text>
      {box("sh_trial", C1, R[3])}
      <Arrow from={{ x: C1 + BW, y: R[3] + BH / 2 }} to={{ x: C2 - 2, y: R[3] + BH / 2 }} />
      <polyline
        points={`${C1 + BW / 2},${R[0]} ${C1 + BW / 2},${R[0] - 12} ${C3 + BW / 2},${R[0] - 12} ${C3 + BW / 2},${R[0] - 2}`}
        fill="none"
        stroke={INK}
        strokeWidth={1.5}
        markerEnd="url(#funnel-arrow)"
      />
      <g
        role="button"
        tabIndex={0}
        onClick={() => onSelect("sh_found")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect("sh_found");
        }}
        style={{ cursor: "pointer" }}
      >
        <text x={C1 + BW / 2 + 12} y={R[0] - 18} fontSize={12.5} fill={selected === "sh_found" ? VALUE : MUTED} textDecoration="underline">
          {f.sh_found ?? ""}
        </text>
      </g>

      {/* outbound */}
      {box("ob_contacts", C3, R[0])}
      <Down x={C3} y={R[0]} />
      <RateLabel rate={rate("cold_bounce")} x={C3 + BW / 2 + 10} y={R[0] + BH + 20} />
      <RateLabel rate={rate("cold_reply")} x={C3 + BW / 2 + 10} y={R[0] + BH + 38} size={12} />
      {box("ob_replies", C3, R[1])}
      <polyline
        points={`${C3 + BW / 2},${R[1] + BH} ${C3 + BW / 2},${SY[0] + BH / 2} ${C2 + BW + 2},${SY[0] + BH / 2}`}
        fill="none"
        stroke={INK}
        strokeWidth={1.5}
        markerEnd="url(#funnel-arrow)"
      />
      <RateLabel rate={rate("reply_to_opp")} x={C3 + BW / 2 + 10} y={R[1] + BH + 26} />
      <text x={C3 + BW / 2 + 10} y={R[1] + BH + 43} fontSize={12.5} fill={MUTED}>
        {f.ob_new_conversations ?? ""} · + rede
      </text>

      {/* red markers: computed, never hard-coded */}
      {data.bottlenecks.map((b) => {
        const slot = MARKER_SLOTS[b.nodeId];
        if (!slot) return null;
        return <Gargalo key={b.nodeId} x={slot.x} y={slot.y} w={slot.w} side={slot.side} lines={b.lines} />;
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

function Drawer({ node, onClose }: { node: FunnelNode; onClose: () => void }) {
  return (
    <aside className="flex h-full min-h-0 w-full flex-col rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-3 border-b p-4">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">{node.title}</h2>
          <p className="mt-1 font-mono text-sm">{node.display}{node.value == null ? "" : fmtTarget(node)}</p>
          {node.definition ? <p className="mt-2 text-sm text-muted-foreground">{node.definition}</p> : null}
          {node.source ? <p className="mt-1 text-xs text-muted-foreground">Fonte: {node.source}</p> : null}
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Fechar">
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {node.rows.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nenhuma linha no período.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                {node.columns.map((c) => (
                  <TableHead key={c} className="whitespace-nowrap text-xs">
                    {c}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {node.rows.map((row, i) => (
                <TableRow key={i}>
                  {node.columns.map((c) => (
                    <TableCell key={c} className="whitespace-nowrap text-xs">
                      {fmtCell(row[c] ?? null)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="border-t p-3 text-xs text-muted-foreground">{node.rows.length} linha{node.rows.length === 1 ? "" : "s"}</div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function FunnelPage() {
  const supabase = useMemo(() => getSupabaseBrowserClient(), []);
  const months = useMemo(() => monthOptions(), []);
  const [token, setToken] = useState<string | null>(null);
  const [month, setMonth] = useState(months[0].value);
  const [data, setData] = useState<FunnelData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data: s }) => setToken(s.session?.access_token ?? null));
  }, [supabase]);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/funnel?month=${month}`, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Falha ao montar o funil");
      setData(json.funnel as FunnelData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao montar o funil");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token, month]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedNode = selected && data ? data.nodes[selected] : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Funil</h1>
          <p className="text-sm text-muted-foreground">
            Só números medidos. &quot;Não medido&quot; onde não há fonte. Clique numa caixa pra ver as contas por trás.
            {data ? ` Período ${data.periodStart} a ${data.periodEnd}.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={month} onValueChange={setMonth}>
            <SelectTrigger className="w-[190px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {months.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading} aria-label="Atualizar">
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">{error}</div> : null}
      {data?.errors.length ? (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
          Fontes com erro (as caixas ficam como &quot;não medido&quot;): {data.errors.join(" · ")}
        </div>
      ) : null}

      <div className={cn("grid min-h-0 flex-1 gap-4", selectedNode ? "grid-cols-1 xl:grid-cols-[minmax(0,1fr)_480px]" : "grid-cols-1")}>
        <div className="min-h-0 overflow-auto rounded-lg border bg-card p-3">
          {loading && !data ? (
            <Skeleton className="h-[600px] w-full" />
          ) : data ? (
            <Diagram data={data} selected={selected} onSelect={(id) => setSelected((cur) => (cur === id ? null : id))} />
          ) : null}
        </div>
        {selectedNode ? <Drawer node={selectedNode} onClose={() => setSelected(null)} /> : null}
      </div>
    </div>
  );
}
