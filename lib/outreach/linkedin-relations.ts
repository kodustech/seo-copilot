/**
 * Who the connected LinkedIn account is already connected to, cached.
 *
 * A sequence DM only lands once the person has accepted the invite, and the
 * step's delay counts from the invite, not from the acceptance. The sequence
 * engine asks this module before it releases a DM.
 *
 * Unipile's guidance (docs/detecting-accepted-invitations and
 * docs/provider-limits-and-restrictions): an initial sync may page through the
 * whole relations list; after that, read the first page only, a few times a
 * day, at irregular intervals. So: one full sync, then refreshes that stop as
 * soon as they reach connections the previous read already saw, no sooner
 * than every few hours plus random jitter, only when a DM is waiting on the
 * answer, and within a small page budget. Never a profile read per person:
 * each one is a visible profile view on the sender's account.
 *
 * Presence in any read proves a connection. Absence proves the opposite only
 * on a complete, recent read; everything else is "unknown", and the caller
 * falls back to sending as before.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  linkedInPersonIdentity,
  listLinkedInRelations,
  type UnipileRelation,
} from "@/lib/unipile";

const TABLE = "linkedin_relations_cache";

/** A read is reused for at least this long… */
const REFRESH_MIN_MS = 3 * 60 * 60_000;
/** …plus up to this much, so reads never settle into fixed times. */
const REFRESH_JITTER_MS = 3 * 60 * 60_000;
/**
 * Absence is only trusted on a read this recent. Refreshes land well inside
 * it; this guards against a stored read that stopped being refreshed.
 */
const ABSENCE_MAX_AGE_MS = 8 * 60 * 60_000;
/** After a failed read, Unipile is not asked again for this long. */
const FAILURE_BACKOFF_MS = 30 * 60_000;
const PAGE_SIZE = 500;
/** The one full read: 15k connections. A longer list stays incomplete. */
const FULL_SYNC_MAX_PAGES = 30;
/** A refresh of a complete read: past this it gives up and goes partial. */
const REFRESH_MAX_PAGES = 3;
/**
 * A refresh reads back this far past the previous read, so a connection made
 * while that read was paging cannot fall between the two.
 */
const OVERLAP_MS = 60 * 60_000;

export type LinkedInRelationsSnapshot = {
  accountId: string;
  /** Normalized slugs and member ids of every relation read. */
  identities: Set<string>;
  /**
   * The whole list was read (or a complete read was refreshed without a
   * gap), so someone missing from it is not connected.
   */
  complete: boolean;
  fetchedAt: number;
  nextFetchAfter: number;
};

export type ConnectionState = "connected" | "not_connected" | "unknown";

/**
 * Whether any of `candidates` (normalized slugs / member ids of one person) is
 * a relation. "not_connected" needs a complete read no older than
 * ABSENCE_MAX_AGE_MS; a partial or old read gives "unknown".
 */
export function connectionState(
  snapshot: LinkedInRelationsSnapshot,
  candidates: readonly string[],
  now: number = Date.now(),
): ConnectionState {
  if (candidates.some((c) => snapshot.identities.has(c))) return "connected";
  if (snapshot.complete && now - snapshot.fetchedAt <= ABSENCE_MAX_AGE_MS) {
    return "not_connected";
  }
  return "unknown";
}

// Fallback store for when the table is not migrated yet, and the per-process
// guards: one read at a time per account, and a pause after a failed read.
const memory = new Map<string, LinkedInRelationsSnapshot>();
const inflight = new Map<string, Promise<LinkedInRelationsSnapshot>>();
const failures = new Map<string, number>();

/** Test hook: forget everything held in this process. */
export function resetLinkedInRelationsMemo(): void {
  memory.clear();
  inflight.clear();
  failures.clear();
}

/**
 * The table is not there yet: Postgres' undefined_table, PostgREST's "not in
 * the schema cache", or those same messages naming this table. Anything else,
 * a permission or RLS error included, is a real failure and is rethrown.
 */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  if (error.code === "42P01" || error.code === "PGRST205") return true;
  const message = error.message ?? "";
  return (
    new RegExp(`relation "?(public\\.)?${TABLE}"? does not exist`, "i").test(message) ||
    new RegExp(
      `could not find the table '?(public\\.)?${TABLE}'? in the schema cache`,
      "i",
    ).test(message)
  );
}

function fromRow(r: Record<string, unknown>): LinkedInRelationsSnapshot {
  const ms = (v: unknown) => {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  return {
    accountId: r.account_id as string,
    identities: new Set(
      Array.isArray(r.identities) ? (r.identities as string[]) : [],
    ),
    complete: Boolean(r.complete),
    fetchedAt: ms(r.fetched_at) ?? 0,
    nextFetchAfter: ms(r.next_fetch_after) ?? 0,
  };
}

async function readSnapshot(
  client: SupabaseClient,
  accountId: string,
): Promise<LinkedInRelationsSnapshot | null> {
  const { data, error } = await client
    .from(TABLE)
    .select("*")
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) {
    if (!isMissingTable(error)) {
      throw new Error(`LinkedIn relations cache unreadable: ${error.message}`);
    }
    return memory.get(accountId) ?? null;
  }
  return data
    ? fromRow(data as Record<string, unknown>)
    : (memory.get(accountId) ?? null);
}

/** Never throws: failing to store a read only costs reading it again. */
async function writeSnapshot(
  client: SupabaseClient,
  snap: LinkedInRelationsSnapshot,
): Promise<void> {
  memory.set(snap.accountId, snap);
  const iso = (ms: number) => new Date(ms).toISOString();
  const { error } = await client.from(TABLE).upsert(
    {
      account_id: snap.accountId,
      identities: [...snap.identities],
      complete: snap.complete,
      fetched_at: iso(snap.fetchedAt),
      next_fetch_after: iso(snap.nextFetchAfter),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "account_id" },
  );
  if (error) {
    console.warn(
      `[linkedin-relations] could not store the relations read${
        isMissingTable(error) ? " (table not migrated yet, kept in memory)" : ""
      }: ${error.message}`,
    );
  }
}

function relationIdentities(rel: UnipileRelation): string[] {
  return [rel.publicIdentifier, rel.memberId, rel.profileUrl]
    .map((v) => linkedInPersonIdentity(v))
    .filter((v): v is string => Boolean(v));
}

async function syncRelations(
  client: SupabaseClient,
  accountId: string,
  prev: LinkedInRelationsSnapshot | null,
  maxPages: number,
): Promise<LinkedInRelationsSnapshot> {
  const startedAt = Date.now();

  const fetched = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  // Stopping early leans on the newest-first order Unipile documents. It is
  // checked on every item rather than trusted: out of order, or undated, and
  // the refresh cannot prove it caught up.
  let ordered = true;
  let previousCreatedAt = Infinity;
  let oldest: number | null = null;
  let exhausted = false;
  let caughtUp = false;

  try {
    while (pages < maxPages) {
      const res: { items: UnipileRelation[]; cursor: string | null } =
        await listLinkedInRelations({ accountId, limit: PAGE_SIZE, cursor });
      pages += 1;
      for (const rel of res.items) {
        for (const id of relationIdentities(rel)) fetched.add(id);
        if (rel.createdAt === null || rel.createdAt > previousCreatedAt) {
          ordered = false;
        } else {
          previousCreatedAt = rel.createdAt;
          oldest = oldest === null ? rel.createdAt : Math.min(oldest, rel.createdAt);
        }
      }
      // Only a missing cursor proves the list ended.
      if (!res.cursor) {
        exhausted = true;
        break;
      }
      // An empty page that still carries a cursor proves nothing: stop, and
      // keep the read partial.
      if (res.items.length === 0) break;
      // Only a complete read can be carried forward from its newest end.
      if (
        prev?.complete &&
        ordered &&
        oldest !== null &&
        oldest <= prev.fetchedAt - OVERLAP_MS
      ) {
        caughtUp = true;
        break;
      }
      cursor = res.cursor;
    }
  } catch (err) {
    failures.set(accountId, Date.now());
    throw err;
  }
  failures.delete(accountId);

  const base = {
    accountId,
    fetchedAt: startedAt,
    nextFetchAfter: startedAt + REFRESH_MIN_MS + Math.random() * REFRESH_JITTER_MS,
  };
  let snap: LinkedInRelationsSnapshot;
  if (exhausted) {
    // The whole list: replace, so a removed connection stops counting.
    snap = { ...base, identities: fetched, complete: true };
  } else if (caughtUp && prev) {
    snap = {
      ...base,
      identities: new Set([...prev.identities, ...fetched]),
      complete: true,
    };
  } else {
    // Page budget spent, or a page that proves nothing. What was seen still
    // proves "connected"; absence proves nothing until a later full read.
    snap = {
      ...base,
      identities: new Set([...(prev?.identities ?? []), ...fetched]),
      complete: false,
    };
  }
  console.info(
    `[linkedin-relations] ${accountId}: ${pages} page(s), ${fetched.size} identities read, ` +
      `${snap.identities.size} known, complete=${snap.complete}`,
  );
  await writeSnapshot(client, snap);
  return snap;
}

/**
 * The account's relations, read from Unipile only when the stored read is due
 * for a refresh.
 *
 * With nothing stored, `initialSync: false` returns null instead of starting
 * the one-off full read. `maxPages` caps the pages this call may read on top
 * of the built-in budgets (FULL_SYNC_MAX_PAGES for a read from scratch,
 * REFRESH_MAX_PAGES for refreshing a complete one); the send path passes 1 so
 * a click in the queue costs at most one request.
 *
 * Throws when Unipile or the store fails; callers treat that as "unknown".
 */
export async function getLinkedInRelations(
  client: SupabaseClient,
  accountId: string,
  opts: { initialSync: boolean; maxPages?: number },
): Promise<LinkedInRelationsSnapshot | null> {
  const cached = await readSnapshot(client, accountId);
  const now = Date.now();
  if (cached && now < cached.nextFetchAfter) return cached;
  if (!cached && !opts.initialSync) return null;

  const failedAt = failures.get(accountId);
  if (failedAt !== undefined && now - failedAt < FAILURE_BACKOFF_MS) {
    throw new Error("LinkedIn relations read failed recently; not retrying yet");
  }

  const budget = Math.max(
    1,
    Math.min(
      opts.maxPages ?? Infinity,
      cached?.complete ? REFRESH_MAX_PAGES : FULL_SYNC_MAX_PAGES,
    ),
  );
  let pending = inflight.get(accountId);
  if (!pending) {
    pending = syncRelations(client, accountId, cached, budget).finally(() => {
      inflight.delete(accountId);
    });
    inflight.set(accountId, pending);
  }
  return pending;
}
