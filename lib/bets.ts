import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Bets: what we run to move a goal. Not tasks. A bet names a hypothesis, the
 * action that tests it, the metric that proves it and the date the verdict
 * is due. Any number can be active; the queue is for what has not started.
 *
 * The measure is the machine-readable half of "the metric that proves it":
 * which number, compared how, against what threshold, over which window.
 * With it, the page and the agent can say whether the hypothesis held
 * without a human re-reading the funnel.
 */

export type BetStatus = "queued" | "active" | "won" | "lost" | "operation";
export const BET_STATUSES: BetStatus[] = ["queued", "active", "won", "lost", "operation"];

export type MeasureKind = "funnel_stage" | "funnel_rate" | "ai_share" | "outbound_tag" | "manual";
export const MEASURE_KINDS: MeasureKind[] = ["funnel_stage", "funnel_rate", "ai_share", "outbound_tag", "manual"];
export type OutboundSubmetric = "contacts" | "replies" | "reply_rate" | "meetings";
export type Comparator = ">=" | "<=";

export type BetMeasure = {
  kind: MeasureKind;
  /**
   * funnel_stage: a stage id (opportunities, icp, sh_trial...).
   * funnel_rate: a rate id (cold_reply, reply_to_meeting, touch_48h...).
   * ai_share: an engine id (perplexity, chat_gpt, google_ai, claude, gemini) or "all".
   * outbound_tag: a sequence tag; `submetric` says which number.
   * manual: a free label; the value comes from current_value.
   */
  id: string;
  submetric?: OutboundSubmetric;
  comparator: Comparator;
  /** Rates and shares as fractions (0.03 = 3%). */
  threshold: number;
  /** ISO dates. Defaults to the bet's creation date .. its decision date. */
  window?: { start: string; end: string } | null;
};

export type Bet = {
  id: string;
  goalId: string;
  title: string;
  hypothesis: string;
  action: string;
  metric: string;
  decisionAt: string; // YYYY-MM-DD
  status: BetStatus;
  verdict: string | null;
  notes: string | null;
  kanbanItemId: string | null;
  lever: string | null;
  ownerEmail: string | null;
  measure: BetMeasure | null;
  currentValue: number | null;
  actionDoneAt: string | null;
  createdByEmail: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CreateBetInput = {
  goalId: string;
  title: string;
  hypothesis: string;
  action: string;
  metric: string;
  decisionAt: string;
  status?: BetStatus;
  notes?: string | null;
  kanbanItemId?: string | null;
  lever?: string | null;
  ownerEmail?: string | null;
  measure?: BetMeasure | null;
  currentValue?: number | null;
  actionDoneAt?: string | null;
  createdByEmail?: string | null;
};

export type UpdateBetInput = Partial<Omit<CreateBetInput, "goalId" | "createdByEmail">> & {
  verdict?: string | null;
};

type Row = Record<string, unknown>;

function isMeasureKind(v: unknown): v is MeasureKind {
  return typeof v === "string" && (MEASURE_KINDS as string[]).includes(v);
}

/** Validate a measure coming from the API or the agent; throws on nonsense. */
export function normalizeMeasure(input: unknown): BetMeasure | null {
  if (input == null) return null;
  const m = input as Partial<BetMeasure> & Record<string, unknown>;
  if (!isMeasureKind(m.kind)) throw new Error(`measure.kind must be one of ${MEASURE_KINDS.join(", ")}`);
  const id = typeof m.id === "string" ? m.id.trim() : "";
  if (!id) throw new Error("measure.id is required (stage id, rate id, engine id, sequence tag or a label)");
  const comparator: Comparator = m.comparator === "<=" ? "<=" : ">=";
  const threshold = Number(m.threshold);
  if (!Number.isFinite(threshold)) throw new Error("measure.threshold must be a number");
  const submetric = m.kind === "outbound_tag" ? ((["contacts", "replies", "reply_rate", "meetings"] as const).find((s) => s === m.submetric) ?? "replies") : undefined;
  let window: BetMeasure["window"] = null;
  if (m.window && typeof m.window === "object") {
    const w = m.window as { start?: unknown; end?: unknown };
    if (typeof w.start === "string" && typeof w.end === "string" && /^\d{4}-\d{2}-\d{2}$/.test(w.start) && /^\d{4}-\d{2}-\d{2}$/.test(w.end)) {
      if (w.end < w.start) throw new Error("measure.window.end must not be before start");
      window = { start: w.start, end: w.end };
    } else {
      throw new Error("measure.window must be { start: YYYY-MM-DD, end: YYYY-MM-DD }");
    }
  }
  return { kind: m.kind, id, ...(submetric ? { submetric } : {}), comparator, threshold, window };
}

function rowToBet(r: Row): Bet {
  let measure: BetMeasure | null = null;
  try {
    measure = normalizeMeasure(r.measure ?? null);
  } catch {
    measure = null;
  }
  return {
    id: r.id as string,
    goalId: r.goal_id as string,
    title: r.title as string,
    hypothesis: r.hypothesis as string,
    action: r.action as string,
    metric: r.metric as string,
    decisionAt: String(r.decision_at).slice(0, 10),
    status: r.status as BetStatus,
    verdict: (r.verdict as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    kanbanItemId: (r.kanban_item_id as string | null) ?? null,
    lever: (r.lever as string | null) ?? null,
    ownerEmail: (r.owner_email as string | null) ?? null,
    measure,
    currentValue: r.current_value == null ? null : Number(r.current_value),
    actionDoneAt: (r.action_done_at as string | null) ?? null,
    createdByEmail: (r.created_by_email as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}

function need(v: string | undefined, name: string): string {
  const t = v?.trim();
  if (!t) throw new Error(`${name} is required`);
  return t;
}

export async function listBets(
  client: SupabaseClient,
  filters: { goalId?: string; goalIds?: string[]; status?: BetStatus | BetStatus[]; lever?: string; limit?: number } = {},
): Promise<Bet[]> {
  let q = client.from("bets").select("*").order("decision_at", { ascending: true });
  if (filters.goalId) q = q.eq("goal_id", filters.goalId);
  if (filters.goalIds) {
    if (filters.goalIds.length === 0) return [];
    q = q.in("goal_id", filters.goalIds);
  }
  if (filters.status) {
    q = Array.isArray(filters.status) ? q.in("status", filters.status) : q.eq("status", filters.status);
  }
  if (filters.lever) q = q.eq("lever", filters.lever);
  q = q.limit(filters.limit ?? 200);
  const { data, error } = await q;
  if (error) throw new Error(`bets: ${error.message}`);
  return (data ?? []).map((r) => rowToBet(r as Row));
}

export async function getBet(client: SupabaseClient, id: string): Promise<Bet | null> {
  const { data, error } = await client.from("bets").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`bets: ${error.message}`);
  return data ? rowToBet(data as Row) : null;
}

export async function countActiveBets(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("bets")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (error) throw new Error(`bets: ${error.message}`);
  return count ?? 0;
}

export async function createBet(client: SupabaseClient, input: CreateBetInput): Promise<Bet> {
  const status: BetStatus = input.status ?? "active";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.decisionAt)) throw new Error("decisionAt must be YYYY-MM-DD");
  const { data, error } = await client
    .from("bets")
    .insert({
      goal_id: input.goalId,
      title: need(input.title, "title"),
      hypothesis: need(input.hypothesis, "hypothesis"),
      action: need(input.action, "action"),
      metric: need(input.metric, "metric"),
      decision_at: input.decisionAt,
      status,
      notes: input.notes?.trim() || null,
      kanban_item_id: input.kanbanItemId ?? null,
      lever: input.lever?.trim() || null,
      owner_email: input.ownerEmail?.trim() || null,
      measure: normalizeMeasure(input.measure ?? null),
      current_value: input.currentValue ?? null,
      action_done_at: input.actionDoneAt ?? null,
      created_by_email: input.createdByEmail ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`bets: ${error.message}`);
  return rowToBet(data as Row);
}

export async function updateBet(client: SupabaseClient, id: string, updates: UpdateBetInput): Promise<Bet> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (updates.title !== undefined) patch.title = need(updates.title, "title");
  if (updates.hypothesis !== undefined) patch.hypothesis = need(updates.hypothesis, "hypothesis");
  if (updates.action !== undefined) patch.action = need(updates.action, "action");
  if (updates.metric !== undefined) patch.metric = need(updates.metric, "metric");
  if (updates.decisionAt !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(updates.decisionAt)) throw new Error("decisionAt must be YYYY-MM-DD");
    patch.decision_at = updates.decisionAt;
  }
  if (updates.status !== undefined) {
    if (!BET_STATUSES.includes(updates.status)) throw new Error(`invalid status: ${updates.status}`);
    patch.status = updates.status;
  }
  if ("verdict" in updates) patch.verdict = updates.verdict?.trim() || null;
  if ("notes" in updates) patch.notes = updates.notes?.trim() || null;
  if ("kanbanItemId" in updates) patch.kanban_item_id = updates.kanbanItemId ?? null;
  if ("lever" in updates) patch.lever = updates.lever?.trim() || null;
  if ("ownerEmail" in updates) patch.owner_email = updates.ownerEmail?.trim() || null;
  if ("measure" in updates) patch.measure = normalizeMeasure(updates.measure ?? null);
  if ("currentValue" in updates) patch.current_value = updates.currentValue ?? null;
  if ("actionDoneAt" in updates) patch.action_done_at = updates.actionDoneAt ?? null;
  const { data, error } = await client.from("bets").update(patch).eq("id", id).select("*").single();
  if (error) throw new Error(`bets: ${error.message}`);
  return rowToBet(data as Row);
}

export async function deleteBet(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("bets").delete().eq("id", id);
  if (error) throw new Error(`bets: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Journal: what was actually done, entry by entry
// ---------------------------------------------------------------------------

export type BetEntryKind = "note" | "artifact" | "result" | "decision";
export const BET_ENTRY_KINDS: BetEntryKind[] = ["note", "artifact", "result", "decision"];

export type BetEntry = {
  id: string;
  betId: string;
  kind: BetEntryKind;
  text: string;
  url: string | null;
  authorEmail: string | null;
  happenedOn: string; // YYYY-MM-DD
  createdAt: string;
};

function rowToEntry(r: Row): BetEntry {
  return {
    id: r.id as string,
    betId: r.bet_id as string,
    kind: (BET_ENTRY_KINDS as string[]).includes(String(r.kind)) ? (r.kind as BetEntryKind) : "note",
    text: r.text as string,
    url: (r.url as string | null) ?? null,
    authorEmail: (r.author_email as string | null) ?? null,
    happenedOn: String(r.happened_on).slice(0, 10),
    createdAt: r.created_at as string,
  };
}

/** Entries of one bet, or of many bets at once (keyed by bet id), oldest first. */
export async function listBetEntries(client: SupabaseClient, betIds: string[], maxRows = 20000): Promise<Record<string, BetEntry[]>> {
  const out: Record<string, BetEntry[]> = {};
  if (betIds.length === 0) return out;
  // Paged over a stable order, so a busy bet never loses its newest entries
  // to a cap shared with the others.
  const PAGE = 1000;
  for (let from = 0; from < maxRows; from += PAGE) {
    const { data, error } = await client
      .from("bet_entries")
      .select("*")
      .in("bet_id", betIds)
      .order("bet_id", { ascending: true })
      .order("happened_on", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`bet_entries: ${error.message}`);
    for (const r of data ?? []) {
      const e = rowToEntry(r as Row);
      out[e.betId] = [...(out[e.betId] ?? []), e];
    }
    if ((data ?? []).length < PAGE) break;
  }
  return out;
}

export async function addBetEntry(
  client: SupabaseClient,
  input: { betId: string; text: string; kind?: BetEntryKind; url?: string | null; happenedOn?: string | null; authorEmail?: string | null },
): Promise<BetEntry> {
  const text = input.text.trim();
  if (!text) throw new Error("text is required");
  if (input.happenedOn && !/^\d{4}-\d{2}-\d{2}$/.test(input.happenedOn)) throw new Error("happenedOn must be YYYY-MM-DD");
  const url = input.url?.trim() || null;
  if (url && !/^https?:\/\//i.test(url)) throw new Error("url must start with http:// or https://");
  const { data, error } = await client
    .from("bet_entries")
    .insert({
      bet_id: input.betId,
      kind: input.kind && BET_ENTRY_KINDS.includes(input.kind) ? input.kind : url ? "artifact" : "note",
      text,
      url,
      author_email: input.authorEmail ?? null,
      ...(input.happenedOn ? { happened_on: input.happenedOn } : {}),
    })
    .select("*")
    .single();
  if (error) throw new Error(`bet_entries: ${error.message}`);
  return rowToEntry(data as Row);
}

export async function deleteBetEntry(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("bet_entries").delete().eq("id", id);
  if (error) throw new Error(`bet_entries: ${error.message}`);
}
