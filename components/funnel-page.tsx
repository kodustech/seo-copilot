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
// Layout. Three entry lanes on top (self-hosted, inbound, outbound), one
// horizontal commercial band below that every entry drops into. Same grid as
// docs/funil-2026-09-01.excalidraw in kodus-growth.
// ---------------------------------------------------------------------------

const W = 1600;
const H = 960;
const BW = 300;
const BH = 60;
const C1 = 60;
const C2 = 560;
const C3 = 1180;
const R = [150, 250, 350] as const;
/** Self-serve box: paid without a conversation, off to the right of ICP. */
const SSX = 900;
const SSY = 470;
/** Commercial band: y of the boxes and x of each box. Reunião sits below
 *  the Conversa → Oportunidade arrow as a side box: not every account goes
 *  through it, so it cannot be in line. */
const BY = 700;
const BX = [60, 640, 1220] as const;
const BWB = 320;
const MX = 350;
const MY = BY + 110;

const INK = "var(--foreground)";
const MUTED = "var(--muted-foreground)";
const CARD = "var(--card)";
const TINT = "var(--accent)";
const CRIT = "var(--destructive)";
const VALUE = "var(--primary)";
const GOOD = "#1f7a4d";
const WARN = "#a8690f";

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
      <rect x={x} y={y} width={w} height={BH} rx={6} fill={spine ? TINT : CARD} stroke={selected ? VALUE : INK} strokeWidth={selected ? 2.5 : 1.5} />
      <text x={x + 12} y={y + 25} fontSize={15} fontWeight={600} fill={INK}>
        {node.title}
      </text>
      <text x={x + 12} y={y + 47} fontSize={13.5} fontFamily="var(--font-mono), ui-monospace, monospace" fontWeight={500} fill={notMeasured ? MUTED : VALUE}>
        {node.display}
        {notMeasured ? "" : fmtTarget(node)}
      </text>
    </g>
  );
}

function Arrow({ from, to }: { from: Pt; to: Pt }) {
  return <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke={INK} strokeWidth={1.5} markerEnd="url(#funnel-arrow)" />;
}

function Elbow({ points }: { points: Pt[] }) {
  return <polyline points={points.map((p) => `${p.x},${p.y}`).join(" ")} fill="none" stroke={INK} strokeWidth={1.5} markerEnd="url(#funnel-arrow)" />;
}

function Gargalo({ x, y, w = BW, lines, side, dy = 0 }: { x: number; y: number; w?: number; lines: string[]; side: "left" | "right" | "bottom" | "top"; dy?: number }) {
  const tx = side === "left" ? x - 18 : side === "right" ? x + w + 18 : x + w / 2;
  const anchor = side === "left" ? "end" : side === "right" ? "start" : "middle";
  const ty =
    side === "bottom" ? y + BH + 22 + dy : side === "top" ? y - 14 - 18 * (lines.length - 1) - dy : y + BH / 2 - 8;
  return (
    <>
      <rect x={x - 8} y={y - 8} width={w + 16} height={BH + 16} rx={9} fill="none" stroke={CRIT} strokeWidth={2.5} />
      {lines.map((t, i) => (
        <text key={i} x={tx} y={ty + i * 18} fontSize={13} fontWeight={i === 0 ? 600 : 500} fill={CRIT} textAnchor={anchor}>
          {i === 0 ? `GARGALO · ${t}` : t}
        </text>
      ))}
    </>
  );
}

function statusColor(status: FunnelRate["status"]): string {
  if (status === "good") return GOOD;
  if (status === "warn") return WARN;
  if (status === "crit") return CRIT;
  return MUTED;
}

/** Arrow label built from a rate: a dot when it sits outside the market band. */
function RateLabel({ rate, x, y, size = 12.5, anchor = "start", compact = false }: { rate: FunnelRate | undefined; x: number; y: number; size?: number; anchor?: "start" | "middle" | "end"; compact?: boolean }) {
  if (!rate) return null;
  const flagged = rate.status === "good" || rate.status === "warn" || rate.status === "crit";
  const text = rate.value == null ? `${rate.label}: não medido` : rate.label;
  // The market band always rides along when there is one; the colour says
  // which side of it we are on. Compact only drops the note when the rate
  // has no band.
  const full = `${text}${rate.note && rate.value != null && (!compact || flagged || rate.status === "ok") ? ` · ${rate.note}` : ""}`;
  // Right-anchored labels get colour instead of a dot: the dot would need the
  // rendered text width, which SVG does not give us before layout.
  const showDot = flagged && anchor !== "end";
  const dotX = anchor === "middle" ? x - 8 - full.length * 3.1 : x + 4;
  const fill = rate.value == null ? CRIT : anchor === "end" && flagged ? statusColor(rate.status) : MUTED;
  return (
    <>
      {showDot ? <circle cx={dotX} cy={y - 4} r={4} fill={statusColor(rate.status)} /> : null}
      <text x={anchor === "start" && flagged ? x + 12 : x} y={y} fontSize={size} fill={fill} textAnchor={anchor}>
        {full}
      </text>
    </>
  );
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

/** Where a red marker goes for each stage, and which side has room for text. */
const MARKER_SLOTS: Record<string, { x: number; y: number; w?: number; side: "left" | "right" | "bottom" | "top"; dy?: number }> = {
  signups: { x: C2, y: R[1], side: "left" },
  icp: { x: C2, y: R[2], side: "right" },
  ob_contacts: { x: C3, y: R[0], side: "left" },
  ob_replies: { x: C3, y: R[1], side: "bottom" },
  conversations: { x: BX[0], y: BY, w: BWB, side: "top" },
  meetings: { x: MX, y: MY, w: BWB, side: "bottom" },
  opportunities: { x: BX[1], y: BY, w: BWB, side: "top" },
  closed: { x: BX[2], y: BY, w: BWB, side: "top" },
};

/** Position of the platform pages, read from the impressions rows. */
function platformLever(n: Record<string, FunnelNode>): string {
  const rows = n.impressions?.rows ?? [];
  const pos = (needle: string) => {
    const r = rows.find((row) => String(row.page ?? "").includes(needle));
    return r ? Number(r.position).toFixed(0) : null;
  };
  const parts = [
    ["gitlab", pos("gitlab-code-review")],
    ["azure", pos("azure-devops")],
    ["bitbucket", pos("bitbucket")],
    ["self-hosted", pos("self-hosted-ai")],
  ].filter(([, v]) => v != null);
  return parts.length ? `posição: ${parts.map(([k, v]) => `${k} ${v}`).join(" · ")}` : "";
}

export function Diagram({ data, selected, onSelect }: { data: FunnelData; selected: string | null; onSelect: (id: string) => void }) {
  const n = data.nodes;
  const f = data.facts;
  const rate = (id: string) => data.rates.find((r) => r.id === id);
  const box = (id: string, x: number, y: number, extra: { w?: number; spine?: boolean } = {}) => (
    <Box x={x} y={y} w={extra.w} spine={extra.spine} node={n[id]} selected={selected === id} onSelect={onSelect} />
  );
  const lever = platformLever(n);
  const convTop = { x: BX[0] + BWB / 2, y: BY - 2 };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Funil Kodus: três entradas que caem numa faixa comercial única" className="h-auto w-full min-w-[960px]">
      <defs>
        <marker id="funnel-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill={INK} />
        </marker>
      </defs>

      {/* headers */}
      <text x={C1} y={52} fontSize={12.5} fill={MUTED}>SELF-HOSTED</text>
      <text x={C2} y={26} fontSize={12.5} fill={MUTED}>
        INBOUND CLOUD · por mês{data.elapsed < 1 ? ` · mês em curso (${Math.round(data.elapsed * 100)}%)` : ""}
      </text>
      <text x={C3} y={52} fontSize={12.5} fill={MUTED}>OUTBOUND · empresa nova, cold</text>

      {/* inbound sources */}
      {box("impressions", C2 - 160, 40, { w: 300 })}
      {box("llm_referral", C2 + 180, 40, { w: 300 })}
      <Arrow from={{ x: C2 - 10, y: 100 }} to={{ x: C2 + BW / 2 - 30, y: R[0] - 2 }} />
      <Arrow from={{ x: C2 + 330, y: 100 }} to={{ x: C2 + BW / 2 + 30, y: R[0] - 2 }} />
      <RateLabel rate={rate("ctr")} x={C2 - 150} y={122} size={12} />
      {lever ? (
        <>
          <text x={C1} y={78} fontSize={13} fontWeight={600} fill={CRIT}>ALAVANCA · páginas de plataforma</text>
          <text x={C1} y={96} fontSize={12.5} fill={CRIT}>{lever}</text>
        </>
      ) : null}

      {/* inbound lane */}
      {box("visits", C2, R[0])}
      <Arrow from={{ x: C2 + BW / 2, y: R[0] + BH }} to={{ x: C2 + BW / 2, y: R[1] }} />
      <RateLabel rate={rate("visit_to_signup")} x={C2 + BW / 2 + 10} y={R[0] + BH + 16} size={12} compact />
      <RateLabel rate={rate("survey")} x={C2 + BW / 2 + 10} y={R[0] + BH + 32} size={12} compact />
      {box("signups", C2, R[1])}
      <Arrow from={{ x: C2 + BW / 2, y: R[1] + BH }} to={{ x: C2 + BW / 2, y: R[2] }} />
      <RateLabel rate={rate("connected")} x={C2 + BW / 2 + 10} y={R[1] + BH + 13} size={11} compact />
      <RateLabel rate={rate("icp_share")} x={C2 + BW / 2 + 10} y={R[1] + BH + 26} size={11} compact />
      {box("icp", C2, R[2], { spine: true })}

      {/* self-hosted lane */}
      {box("sh_instances", C1, R[0])}
      <Arrow from={{ x: C1 + BW / 2, y: R[0] + BH }} to={{ x: C1 + BW / 2, y: R[2] }} />
      <text x={C1 + BW / 2 + 10} y={R[0] + BH + 18} fontSize={12.5} fill={MUTED}>pedidos de trial: {n.sh_trial?.value ?? "?"}</text>
      <g
        role="button"
        tabIndex={0}
        onClick={() => onSelect("sh_found")}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onSelect("sh_found");
        }}
        style={{ cursor: "pointer" }}
      >
        <text x={C1 + BW / 2 + 10} y={R[0] + BH + 36} fontSize={12} fill={selected === "sh_found" ? VALUE : MUTED} textDecoration="underline">
          {f.sh_found_short ?? ""}
        </text>
      </g>
      {box("sh_trial", C1, R[2])}
      <Arrow from={{ x: C1 + BW, y: R[2] + BH / 2 }} to={{ x: C2 - 2, y: R[2] + BH / 2 }} />

      {/* outbound lane */}
      {box("ob_contacts", C3, R[0])}
      <Arrow from={{ x: C3 + BW / 2, y: R[0] + BH }} to={{ x: C3 + BW / 2, y: R[1] }} />
      <RateLabel rate={rate("cold_reply")} x={C3 + BW / 2 - 10} y={R[0] + BH + 22} size={11} anchor="end" compact />
      <RateLabel rate={rate("cold_bounce")} x={C3 + BW / 2 - 10} y={R[0] + BH + 35} size={11} anchor="end" compact />
      {box("ob_replies", C3, R[1])}

      {/* commercial band */}
      <rect x={30} y={BY - 100} width={W - 60} height={340} rx={10} fill="none" stroke={MUTED} strokeWidth={1} strokeDasharray="6 5" />
      <text x={48} y={BY - 82} fontSize={12.5} fill={MUTED}>COMERCIAL</text>
      {box("conversations", BX[0], BY, { w: BWB, spine: true })}
      {box("opportunities", BX[1], BY, { w: BWB, spine: true })}
      {box("closed", BX[2], BY, { w: BWB, spine: true })}
      {[0, 1].map((i) => (
        <Arrow key={i} from={{ x: BX[i] + BWB, y: BY + BH / 2 }} to={{ x: BX[i + 1] - 2, y: BY + BH / 2 }} />
      ))}
      <RateLabel rate={rate("conv_to_opp")} x={(BX[0] + BWB + BX[1]) / 2} y={BY - 16} size={11.5} anchor="middle" compact />
      <RateLabel rate={rate("opp_active")} x={(BX[1] + BWB + BX[2]) / 2} y={BY - 16} size={11.5} anchor="middle" compact />

      {/* Reunião: a side box, not a mandatory stop */}
      {box("meetings", MX, MY, { w: BWB, spine: true })}
      <Elbow points={[{ x: BX[0] + BWB - 60, y: BY + BH }, { x: BX[0] + BWB - 60, y: MY + BH / 2 }, { x: MX - 2, y: MY + BH / 2 }]} />
      <Elbow points={[{ x: MX + BWB, y: MY + BH / 2 }, { x: BX[1] + 60, y: MY + BH / 2 }, { x: BX[1] + 60, y: BY + BH + 2 }]} />
      <RateLabel rate={rate("conv_to_meeting")} x={MX - 10} y={MY + BH / 2 - 10} size={11.5} anchor="end" compact />
      <RateLabel rate={rate("meeting_to_opp")} x={MX + BWB + 10} y={MY + BH / 2 - 10} size={11.5} compact />

      {/* entries dropping into Conversa */}
      <Elbow points={[{ x: C2 + BW / 2, y: R[2] + BH }, { x: C2 + BW / 2, y: BY - 72 }, { x: convTop.x, y: BY - 72 }, convTop]} />
      <RateLabel rate={rate("touch_48h")} x={C2 + BW / 2 - 10} y={R[2] + BH + 24} size={12} anchor="end" compact />

      {/* self-serve: paid without a conversation, straight to Fechado */}
      <Elbow points={[{ x: C2 + BW - 30, y: R[2] + BH }, { x: C2 + BW - 30, y: SSY + BH / 2 }, { x: SSX - 2, y: SSY + BH / 2 }]} />
      {box("self_serve", SSX, SSY, { w: 300 })}
      <Elbow points={[{ x: SSX + 150, y: SSY + BH }, { x: SSX + 150, y: BY - 60 }, { x: BX[2] + BWB / 2, y: BY - 60 }, { x: BX[2] + BWB / 2, y: BY - 2 }]} />

      <Elbow points={[{ x: C3 + BW / 2, y: R[1] + BH + 80 }, { x: C3 + BW / 2, y: BY - 72 }, { x: convTop.x, y: BY - 72 }, convTop]} />
      <RateLabel rate={rate("reply_to_conversation")} x={C3 + BW / 2 - 10} y={BY - 118} size={11.5} anchor="end" compact />

      {/* red markers: computed, never hard-coded */}
      {data.bottlenecks.map((b) => {
        const slot = MARKER_SLOTS[b.nodeId];
        if (!slot) return null;
        return <Gargalo key={b.nodeId} x={slot.x} y={slot.y} w={slot.w} side={slot.side} dy={slot.dy} lines={b.lines} />;
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
      {node.goal ? (
        <div className="border-t px-4 py-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">Meta</p>
          <p>
            {node.goal.title}: {node.value == null ? "?" : fmtCell(node.value)} de {fmtCell(node.goal.target)}
          </p>
          {node.bets && node.bets.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {node.bets.map((b) => (
                <li key={b.id} className="text-xs">
                  <span className={cn("mr-2 rounded px-1.5 py-0.5", b.status === "active" ? "bg-emerald-500/20 text-emerald-300" : b.status === "queued" ? "bg-neutral-500/20 text-neutral-300" : b.status === "won" ? "bg-sky-500/20 text-sky-300" : b.status === "lost" ? "bg-red-500/20 text-red-300" : "bg-violet-500/20 text-violet-300")}>
                    {b.status}
                  </span>
                  <span className="font-medium">{b.title}</span>
                  <span className="text-muted-foreground"> · decide em {b.decisionAt} · prova: {b.metric}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-xs text-muted-foreground">Sem apostas nesta meta.</p>
          )}
        </div>
      ) : null}
      {node.extra?.map((section) => (
        <div key={section.title} className="border-t">
          <p className="px-4 pt-3 text-xs font-medium text-muted-foreground">{section.title}</p>
          <div className="overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  {section.columns.map((c) => (
                    <TableHead key={c} className="whitespace-nowrap text-xs">
                      {c}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {section.rows.map((row, i) => (
                  <TableRow key={i}>
                    {section.columns.map((c) => (
                      <TableCell key={c} className="whitespace-nowrap text-xs">
                        {fmtCell(row[c] ?? null)}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
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
            {data ? `Período ${data.periodStart} a ${data.periodEnd}. ` : ""}Clique numa caixa pra ver as contas por trás.
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
