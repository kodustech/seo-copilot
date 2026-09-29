/**
 * When a CRM account entered each status. The timeline logs a status_change
 * for every move, but an account created straight into meeting or qualified
 * never moved there: createCompany logs `created` with no status. Without
 * reading creation as an entry, inbound accounts that arrive already in a
 * meeting are invisible to the stages built from these entries.
 */

import { OPPORTUNITY_STATUSES } from "./config";

export type StatusChange = {
  company_id: string;
  kind: string;
  actor: string | null;
  from: string | null;
  to: string | null;
  created_at: string;
};

type CompanyCreation = { id: string; status: string; created_at: string };

/** Accounts created inside [periodStart, nextStart). */
export function createdInPeriod<T extends { created_at: string }>(
  companies: T[],
  periodStart: string,
  nextStart: string,
): T[] {
  // Parsed, not compared as strings: Postgres hands back "+00:00" and a
  // fraction, which sorts before the "Z" of the bound on the same second.
  const from = Date.parse(`${periodStart}T00:00:00Z`);
  const until = Date.parse(`${nextStart}T00:00:00Z`);
  return companies.filter((c) => {
    const t = Date.parse(c.created_at);
    return t >= from && t < until;
  });
}

/**
 * The period's status changes plus one entry per account created in the
 * period, as a move from nothing into the status it was created in, oldest
 * first.
 *
 * The status an account was created in is the `from` of its earliest
 * status_change, or its current status when it never moved. `history` must
 * reach past the period for that: an account created on the 29th in lead and
 * moved to meeting next month is `meeting` today, and reading that as its
 * creation status would count a meeting in the wrong month.
 */
export function stageEntries(input: {
  /** status_change activities inside the period. */
  changes: StatusChange[];
  companies: CompanyCreation[];
  /** Every status_change of the accounts created in the period, at any date. */
  history: StatusChange[];
  periodStart: string;
  nextStart: string;
}): StatusChange[] {
  const first = new Map<string, StatusChange>();
  for (const h of input.history) {
    if (h.kind !== "status_change") continue;
    const seen = first.get(h.company_id);
    if (!seen || Date.parse(h.created_at) < Date.parse(seen.created_at)) first.set(h.company_id, h);
  }
  const created: StatusChange[] = [];
  for (const c of createdInPeriod(input.companies, input.periodStart, input.nextStart)) {
    const moved = first.get(c.id);
    const initial = moved ? moved.from : c.status;
    // A change with no `from` says nothing about where the account started.
    if (!initial) continue;
    // No actor: creation is not a person touching the account.
    created.push({ company_id: c.id, kind: "created", actor: null, from: null, to: initial, created_at: c.created_at });
  }
  // Creation first and a stable sort, so a move logged in the same instant
  // still reads as coming after it.
  return [...created, ...input.changes].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
}

/** The first entry per account that matches, so an account counts once per stage. */
export function firstEntries(
  entries: StatusChange[],
  pred: (c: StatusChange) => boolean,
): StatusChange[] {
  const seen = new Map<string, StatusChange>();
  for (const c of entries) if (pred(c) && !seen.has(c.company_id)) seen.set(c.company_id, c);
  return [...seen.values()];
}

const OPPORTUNITY = new Set<string>(OPPORTUNITY_STATUSES);

/** Into qualified, poc or negotiation from outside them; creation comes from nothing, so it counts. */
export function enteredOpportunity(c: StatusChange): boolean {
  return OPPORTUNITY.has(c.to ?? "") && !OPPORTUNITY.has(c.from ?? "");
}
