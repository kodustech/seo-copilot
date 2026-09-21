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
 * than every few hours plus random jitter, and only when a DM is waiting on
 * the answer. Never a profile read per person: each one is a visible profile
 * view on the sender's account.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  listLinkedInRelations,
  normalizeLinkedInIdentity,
  type UnipileRelation,
} from "@/lib/unipile";

const TABLE = "linkedin_relations_cache";

/** A read is reused for at least this long… */
const REFRESH_MIN_MS = 3 * 60 * 60_000;
/** …plus up to this much, so reads never settle into fixed times. */
const REFRESH_JITTER_MS = 3 * 60 * 60_000;
/** After a failed read, Unipile is not asked again for this long. */
const FAILURE_BACKOFF_MS = 30 * 60_000;
const PAGE_SIZE = 500;
/** 15k connections. A longer list is kept but marked incomplete. */
const MAX_PAGES = 30;
/**
 * A refresh reads back this far past the previous read, so a connection made
 * while that read was paging cannot fall between the two.
 */
const OVERLAP_MS = 60 * 60_000;
/**
 * A hand-sent invite is often marked done days after it went out, so on a
 * partial list the connection may predate the recorded send by this much.
 */
const INVITE_SLACK_MS = 7 * 24 * 60 * 60_000;

export type LinkedInRelationsSnapshot = {
  accountId: string;
  /** Normalized slugs and member ids of every relation read. */
  identities: Set<string>;
  /** The whole list was read, so someone missing from it is not connected. */
  complete: boolean;
  /**
   * On a partial list: every connection made after this (epoch ms) is in
   * `identities`. Null when the order could not be trusted.
   */
  coveredSince: number | null;
  fetchedAt: number;
  nextFetchAfter: number;
};

export type ConnectionState = "connected" | "not_connected" | "unknown";

/**
 * Whether any of `candidates` (normalized slugs / member ids of one person) is
 * a relation. "unknown" when the list read is partial and does not reach back
 * to the invite, so absence proves nothing.
 */
export function connectionState(
  snapshot: LinkedInRelationsSnapshot,
  candidates: readonly string[],
  invitedAt: number | null,
): ConnectionState {
  if (candidates.some((c) => snapshot.identities.has(c))) return "connected";
  if (snapshot.complete) return "not_connected";
  if (
    snapshot.coveredSince !== null &&
    invitedAt !== null &&
    invitedAt - INVITE_SLACK_MS >= snapshot.coveredSince
  ) {
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

function isMissingTable(error: { code?: string; message?: string }): boolean {
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    new RegExp(TABLE, "i").test(error.message ?? "")
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
    coveredSince: ms(r.covered_since),
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
    if (!isMissingTable(error)) throw new Error(error.message);
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
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const { error } = await client.from(TABLE).upsert(
    {
      account_id: snap.accountId,
      identities: [...snap.identities],
      complete: snap.complete,
      covered_since: iso(snap.coveredSince),
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
    .map((v) => normalizeLinkedInIdentity(v))
    .filter((v): v is string => Boolean(v));
}

async function syncRelations(
  client: SupabaseClient,
  accountId: string,
  prev: LinkedInRelationsSnapshot | null,
): Promise<LinkedInRelationsSnapshot> {
  const startedAt = Date.now();
  // A refresh may stop early only when it has something to stop against.
  const incremental = prev !== null && (prev.complete || prev.coveredSince !== null);

  const fetched = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  // Stopping early leans on the newest-first order Unipile documents. It is
  // checked on every item rather than trusted: out of order, or undated, and
  // the read carries on to the end of the list.
  let ordered = true;
  let previousCreatedAt = Infinity;
  let oldest: number | null = null;
  let exhausted = false;
  let caughtUp = false;

  try {
    while (pages < MAX_PAGES) {
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
      if (!res.cursor || res.items.length === 0) {
        exhausted = true;
        break;
      }
      if (
        incremental &&
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

  let snap: LinkedInRelationsSnapshot;
  const base = {
    accountId,
    fetchedAt: startedAt,
    nextFetchAfter: startedAt + REFRESH_MIN_MS + Math.random() * REFRESH_JITTER_MS,
  };
  if (exhausted) {
    // The whole list: replace, so a removed connection stops counting.
    snap = { ...base, identities: fetched, complete: true, coveredSince: null };
  } else if (caughtUp && prev) {
    snap = {
      ...base,
      identities: new Set([...prev.identities, ...fetched]),
      complete: prev.complete,
      coveredSince: prev.coveredSince,
    };
  } else {
    // Page cap hit before the list ended or met the previous read. What was
    // seen still proves "connected"; absence is only trusted as far back as
    // this read reached in order.
    snap = {
      ...base,
      identities: new Set([...(prev?.identities ?? []), ...fetched]),
      complete: false,
      coveredSince: ordered ? oldest : null,
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
 * `initialSync: false` never starts the one-off full read: with nothing stored
 * it returns null, and the caller treats the connection as unknown. That is
 * the send path's mode, so a click in the queue can at most trigger a short
 * refresh, never a sync of the whole network.
 *
 * Throws when Unipile or the store fails; callers decide what a failed check
 * means for them.
 */
export async function getLinkedInRelations(
  client: SupabaseClient,
  accountId: string,
  opts: { initialSync: boolean },
): Promise<LinkedInRelationsSnapshot | null> {
  const cached = await readSnapshot(client, accountId);
  const now = Date.now();
  if (cached && now < cached.nextFetchAfter) return cached;
  if (!cached && !opts.initialSync) return null;

  const failedAt = failures.get(accountId);
  if (failedAt !== undefined && now - failedAt < FAILURE_BACKOFF_MS) {
    throw new Error("LinkedIn relations read failed recently; not retrying yet");
  }

  let pending = inflight.get(accountId);
  if (!pending) {
    pending = syncRelations(client, accountId, cached).finally(() => {
      inflight.delete(accountId);
    });
    inflight.set(accountId, pending);
  }
  return pending;
}
