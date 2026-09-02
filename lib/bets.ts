import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Bets: what we run to move a goal. Not tasks. A bet names a hypothesis, the
 * action that tests it, the metric that proves it and the date the verdict
 * is due. At most MAX_ACTIVE_BETS are active at once; the rest queue.
 */

export type BetStatus = "queued" | "active" | "won" | "lost" | "operation";
export const BET_STATUSES: BetStatus[] = ["queued", "active", "won", "lost", "operation"];
export const MAX_ACTIVE_BETS = 3;

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
  createdByEmail?: string | null;
};

export type UpdateBetInput = Partial<Omit<CreateBetInput, "goalId" | "createdByEmail">> & {
  verdict?: string | null;
};

type Row = Record<string, unknown>;

function rowToBet(r: Row): Bet {
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
  filters: { goalId?: string; status?: BetStatus | BetStatus[]; limit?: number } = {},
): Promise<Bet[]> {
  let q = client.from("bets").select("*").order("decision_at", { ascending: true });
  if (filters.goalId) q = q.eq("goal_id", filters.goalId);
  if (filters.status) {
    q = Array.isArray(filters.status) ? q.in("status", filters.status) : q.eq("status", filters.status);
  }
  q = q.limit(filters.limit ?? 200);
  const { data, error } = await q;
  if (error) throw new Error(`bets: ${error.message}`);
  return (data ?? []).map((r) => rowToBet(r as Row));
}

export async function countActiveBets(client: SupabaseClient): Promise<number> {
  const { count, error } = await client
    .from("bets")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (error) throw new Error(`bets: ${error.message}`);
  return count ?? 0;
}

async function assertActiveSlot(client: SupabaseClient, excludeId?: string): Promise<void> {
  let q = client.from("bets").select("id", { count: "exact", head: true }).eq("status", "active");
  if (excludeId) q = q.neq("id", excludeId);
  const { count, error } = await q;
  if (error) throw new Error(`bets: ${error.message}`);
  if ((count ?? 0) >= MAX_ACTIVE_BETS) {
    throw new Error(
      `Já existem ${MAX_ACTIVE_BETS} apostas ativas. Decida uma (ganhou, perdeu ou virou operação) antes de ativar outra; esta pode ficar na fila.`,
    );
  }
}

export async function createBet(client: SupabaseClient, input: CreateBetInput): Promise<Bet> {
  const status: BetStatus = input.status ?? "active";
  if (status === "active") await assertActiveSlot(client);
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
    if (updates.status === "active") await assertActiveSlot(client, id);
    patch.status = updates.status;
  }
  if ("verdict" in updates) patch.verdict = updates.verdict?.trim() || null;
  if ("notes" in updates) patch.notes = updates.notes?.trim() || null;
  if ("kanbanItemId" in updates) patch.kanban_item_id = updates.kanbanItemId ?? null;
  const { data, error } = await client.from("bets").update(patch).eq("id", id).select("*").single();
  if (error) throw new Error(`bets: ${error.message}`);
  return rowToBet(data as Row);
}

export async function deleteBet(client: SupabaseClient, id: string): Promise<void> {
  const { error } = await client.from("bets").delete().eq("id", id);
  if (error) throw new Error(`bets: ${error.message}`);
}
