/**
 * A sequence's LinkedIn DM used to reach the queue when its delay ran out,
 * counted from the invite rather than from the acceptance. Sent to someone who
 * had not accepted yet, LinkedIn refuses it. These tests pin the gate: a due
 * DM is released only once the person shows up in the account's relations
 * (matched by slug, since invites sent by hand leave no member id), waits
 * about a day otherwise, and the enrollment is dropped after 14 days. Invites
 * and email are released as before, and the relations list is read once per
 * refresh window, not once per DM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const unipile = vi.hoisted(() => ({
  isUnipileConfigured: vi.fn(() => true),
  listLinkedInAccounts: vi.fn(async () => [{ id: "acc-1" }]),
  listLinkedInRelations: vi.fn(
    async (): Promise<{
      items: Array<{
        publicIdentifier: string | null;
        memberId: string | null;
        profileUrl: string | null;
        createdAt: number | null;
      }>;
      cursor: string | null;
    }> => ({ items: [], cursor: null }),
  ),
  getUnipileUserProfile: vi.fn(async () => ({ providerId: "ACoAAjane" })),
  sendLinkedInInvitation: vi.fn(async () => ({ invitationId: "inv-1" })),
  findUnipileChatByAttendee: vi.fn(async () => null),
  sendUnipileChatMessage: vi.fn(async () => ({ messageId: "msg-1" })),
  startUnipileChat: vi.fn(async () => ({ chatId: "chat-1", messageId: "msg-1" })),
}));
vi.mock("@/lib/unipile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/unipile")>()),
  ...unipile,
}));

import { resetLinkedInRelationsMemo } from "@/lib/outreach/linkedin-relations";
import {
  processDueSequenceTasks,
  promoteDueHumanQueue,
  sendTaskNow,
} from "@/lib/outreach/sequences";

type Row = Record<string, unknown>;

/** Thursday afternoon UTC: a sending day in the default Mon–Fri window. */
const NOW = "2026-09-24T17:00:00.000Z";
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString();

/**
 * In-memory tables behind the query-builder calls the sequence engine makes.
 * Filters apply when the chain resolves, so an update narrowed by status only
 * touches rows still in that status.
 */
function fakeSupabase(tables: Record<string, Row[]>) {
  let nextId = 1;
  const client = {
    from(table: string) {
      tables[table] ??= [];
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      let inserted: Row[] | null = null;
      let limit: number | null = null;
      const run = () => {
        if (inserted) return inserted.map((r) => ({ ...r }));
        let rows = tables[table].filter((r) => filters.every((f) => f(r)));
        if (patch) for (const r of rows) Object.assign(r, patch);
        if (limit !== null) rows = rows.slice(0, limit);
        return rows.map((r) => ({ ...r }));
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        limit: (n: number) => {
          limit = n;
          return builder;
        },
        eq: (col: string, v: unknown) => {
          filters.push((r) => r[col] === v);
          return builder;
        },
        in: (col: string, vs: readonly unknown[]) => {
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        lte: (col: string, v: string) => {
          filters.push((r) => typeof r[col] === "string" && (r[col] as string) <= v);
          return builder;
        },
        update: (p: Row) => {
          patch = p;
          return builder;
        },
        insert: (p: Row | Row[]) => {
          inserted = (Array.isArray(p) ? p : [p]).map((r) => ({
            id: `row-${nextId++}`,
            ...r,
          }));
          tables[table].push(...inserted);
          return builder;
        },
        upsert: (p: Row, opts: { onConflict: string }) => {
          const key = opts.onConflict;
          const existing = tables[table].find((r) => r[key] === p[key]);
          if (existing) Object.assign(existing, p);
          else tables[table].push({ ...p });
          inserted = [p];
          return builder;
        },
        maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
        single: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
          resolve({ data: run(), error: null }),
      };
      return builder;
    },
    rpc: async () => ({ error: null }),
  };
  return { client: client as never, tables };
}

const STEPS: Row[] = [
  { id: "step-invite", sequence_id: "seq-1", position: 1, channel: "linkedin", mode: "semi", delay_hours: 0, linkedin_action: "connect_note", body_template: "" },
  { id: "step-dm", sequence_id: "seq-1", position: 2, channel: "linkedin", mode: "semi", delay_hours: 72, linkedin_action: "message", body_template: "Hi Jane" },
  { id: "step-email", sequence_id: "seq-1", position: 3, channel: "email", mode: "semi", delay_hours: 48, linkedin_action: null, body_template: "Hi" },
];

function enrollment(id: string, linkedin: string | null): Row {
  return {
    id,
    sequence_id: "seq-1",
    source: "manual",
    company_name: `Company ${id}`,
    contact_name: `Person ${id}`,
    contact_email: `${id}@example.com`,
    contact_linkedin: linkedin,
    status: "active",
    current_step_position: 2,
  };
}

/** The invite, marked done by hand: no member id recorded. */
function sentInvite(enrollmentId: string, sentAt: string, meta: Row = {}): Row {
  return {
    id: `invite-${enrollmentId}`,
    enrollment_id: enrollmentId,
    step_id: "step-invite",
    channel: "linkedin",
    mode: "semi",
    status: "sent",
    scheduled_for: sentAt,
    sent_at: sentAt,
    rendered_body: "",
    error: null,
    meta: { linkedin_action: "connect_note", ...meta },
  };
}

function dueTask(id: string, enrollmentId: string, stepId: string, extra: Row = {}): Row {
  const step = STEPS.find((s) => s.id === stepId)!;
  return {
    id,
    enrollment_id: enrollmentId,
    step_id: stepId,
    channel: step.channel,
    mode: step.mode,
    status: "scheduled",
    scheduled_for: ago(10 * 60_000),
    rendered_body: step.body_template,
    error: null,
    meta: { linkedin_action: step.linkedin_action },
    ...extra,
  };
}

function world(opts: {
  enrollments: Row[];
  tasks: Row[];
  relationsCache?: Row[];
}) {
  return fakeSupabase({
    outreach_sequences: [{ id: "seq-1", name: "Job signal", status: "active", mailbox_id: null }],
    outreach_sequence_steps: STEPS.map((s) => ({ ...s })),
    outreach_enrollments: opts.enrollments,
    outreach_send_tasks: opts.tasks,
    outreach_sequence_snapshots: [],
    linkedin_relations_cache: opts.relationsCache ?? [],
  });
}

function relation(publicIdentifier: string, createdAt: string, memberId = "ACoAAother") {
  return {
    publicIdentifier,
    memberId,
    profileUrl: `https://www.linkedin.com/in/${publicIdentifier}/`,
    createdAt: Date.parse(createdAt),
  };
}

const find = (rows: Row[], id: string) => rows.find((r) => r.id === id)!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  resetLinkedInRelationsMemo();
  for (const fn of Object.values(unipile)) fn.mockClear();
  unipile.listLinkedInRelations.mockImplementation(async () => ({ items: [], cursor: null }));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("releasing a due LinkedIn DM", () => {
  it("keeps a DM to someone who has not accepted yet scheduled, and looks again in about a day", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "https://www.linkedin.com/in/jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm")],
    });
    unipile.listLinkedInRelations.mockResolvedValue({
      items: [relation("someone-else", ago(1 * DAY))],
      cursor: null,
    });

    const res = await processDueSequenceTasks(client);

    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("scheduled");
    const pushedBy = Date.parse(dm.scheduled_for as string) - Date.parse(NOW);
    expect(pushedBy).toBeGreaterThanOrEqual(21 * HOUR);
    expect(pushedBy).toBeLessThanOrEqual(27 * HOUR);
    expect(dm.meta).toMatchObject({
      waiting_on_connection: true,
      waiting_on_connection_since: NOW,
      connection_check: "not_connected",
      invite_sent_at: ago(3 * DAY),
    });
    expect(dm.error).toBe("Waiting for the LinkedIn connection request to be accepted");
    expect(find(tables.outreach_enrollments, "enr-1").next_run_at).toBe(dm.scheduled_for);
    expect(res).toMatchObject({ promoted: 0, linkedinWaiting: 1, linkedinCancelled: 0 });
    // One list read, never a profile view per person.
    expect(unipile.getUnipileUserProfile).not.toHaveBeenCalled();
  });

  it("releases a DM once the person is a connection, matched by slug with no member id", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "https://www.linkedin.com/in/jane-doe/")],
      tasks: [
        sentInvite("enr-1", ago(3 * DAY)),
        // It waited once already; the waiting note must not stay on the queue.
        dueTask("dm-1", "enr-1", "step-dm", {
          error: "Waiting for the LinkedIn connection request to be accepted",
          meta: { linkedin_action: "message", waiting_on_connection: true, waiting_on_connection_since: ago(DAY) },
        }),
      ],
    });
    // Different case from the enrollment's URL: matching is case-insensitive.
    unipile.listLinkedInRelations.mockResolvedValue({
      items: [relation("Jane-Doe", ago(2 * DAY))],
      cursor: null,
    });

    const res = await processDueSequenceTasks(client);

    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("ready");
    expect(dm.error).toBeNull();
    expect(dm.meta).toMatchObject({ waiting_on_connection: false, connection_check: "connected" });
    expect(res).toMatchObject({ promoted: 1, linkedinWaiting: 0 });
  });

  it("also matches on a member id a Unipile send already resolved", async () => {
    const { client, tables } = world({
      // The vanity on file no longer matches the relation's.
      enrollments: [enrollment("enr-1", "https://www.linkedin.com/in/jane-old-vanity")],
      tasks: [
        sentInvite("enr-1", ago(3 * DAY), { linkedin_provider_id: "ACoAAjane" }),
        dueTask("dm-1", "enr-1", "step-dm"),
      ],
    });
    unipile.listLinkedInRelations.mockResolvedValue({
      items: [relation("jane-new-vanity", ago(2 * DAY), "ACoAAjane")],
      cursor: null,
    });

    await processDueSequenceTasks(client);

    expect(find(tables.outreach_send_tasks, "dm-1").status).toBe("ready");
  });

  it("cancels the enrollment once the invite has gone 14 days unaccepted", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(15 * DAY)), dueTask("dm-1", "enr-1", "step-dm")],
    });

    const res = await processDueSequenceTasks(client);

    const enr = find(tables.outreach_enrollments, "enr-1");
    expect(enr.status).toBe("cancelled");
    expect(enr.last_error).toBe("Invite not accepted after 14 days");
    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("cancelled");
    expect(dm.error).toBe("Invite not accepted after 14 days");
    // History is kept: the invite stays sent and the campaign is snapshotted.
    expect(find(tables.outreach_send_tasks, "invite-enr-1").status).toBe("sent");
    expect(tables.outreach_sequence_snapshots).toHaveLength(1);
    expect(res).toMatchObject({ promoted: 0, linkedinCancelled: 1 });
  });

  it("releases a DM with no readable LinkedIn as before, flagged, instead of waiting forever", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", null)],
      tasks: [dueTask("dm-1", "enr-1", "step-dm")],
    });

    await processDueSequenceTasks(client);

    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("ready");
    expect(dm.meta).toMatchObject({ connection_check: "no_linkedin_identity" });
    expect(unipile.listLinkedInRelations).not.toHaveBeenCalled();
  });

  it("holds DMs about an hour when the relations read fails, without counting toward the 14 days", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm")],
    });
    unipile.listLinkedInRelations.mockRejectedValue(new Error("Unipile 503"));

    await processDueSequenceTasks(client);

    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("scheduled");
    const pushedBy = Date.parse(dm.scheduled_for as string) - Date.parse(NOW);
    expect(pushedBy).toBeGreaterThanOrEqual(HOUR);
    expect(pushedBy).toBeLessThan(2 * HOUR);
    expect(dm.meta).toMatchObject({ connection_check: "error" });
    expect((dm.meta as Row).waiting_on_connection_since).toBeUndefined();
  });
});

describe("what the gate leaves alone", () => {
  it("releases connection requests and email as before, without reading relations", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe"), enrollment("enr-2", "john-roe")],
      tasks: [
        dueTask("invite-due", "enr-1", "step-invite"),
        dueTask("email-due", "enr-2", "step-email"),
      ],
    });

    const res = await processDueSequenceTasks(client);

    expect(find(tables.outreach_send_tasks, "invite-due").status).toBe("ready");
    expect(find(tables.outreach_send_tasks, "email-due").status).toBe("ready");
    expect(res.promoted).toBe(2);
    expect(unipile.listLinkedInAccounts).not.toHaveBeenCalled();
    expect(unipile.listLinkedInRelations).not.toHaveBeenCalled();
  });

  it("the Today page releases a due invite but leaves a due DM to the cron's check", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe"), enrollment("enr-2", "john-roe")],
      tasks: [
        dueTask("invite-due", "enr-1", "step-invite"),
        sentInvite("enr-2", ago(3 * DAY)),
        dueTask("dm-due", "enr-2", "step-dm"),
      ],
    });

    await promoteDueHumanQueue(client);

    expect(find(tables.outreach_send_tasks, "invite-due").status).toBe("ready");
    expect(find(tables.outreach_send_tasks, "dm-due").status).toBe("scheduled");
    expect(unipile.listLinkedInRelations).not.toHaveBeenCalled();
  });
});

describe("the relations read", () => {
  it("is cached: a second DM check inside the refresh window does not read again", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe"), enrollment("enr-2", "john-roe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm")],
    });
    unipile.listLinkedInRelations.mockResolvedValue({
      items: [relation("jane-doe", ago(DAY)), relation("john-roe", ago(2 * DAY))],
      cursor: null,
    });

    await processDueSequenceTasks(client);
    expect(unipile.listLinkedInRelations).toHaveBeenCalledTimes(1);
    const [cache] = tables.linkedin_relations_cache;
    expect(cache).toMatchObject({ account_id: "acc-1", complete: true, fetched_at: NOW });
    const refreshIn = Date.parse(cache.next_fetch_after as string) - Date.parse(NOW);
    expect(refreshIn).toBeGreaterThanOrEqual(3 * HOUR);
    expect(refreshIn).toBeLessThanOrEqual(6 * HOUR);

    // Two hours later another DM comes due. The stored read answers it, and
    // it survives a restart because it lives in the table, not in memory.
    resetLinkedInRelationsMemo();
    vi.setSystemTime(new Date(Date.parse(NOW) + 2 * HOUR));
    tables.outreach_send_tasks.push(
      sentInvite("enr-2", ago(3 * DAY)),
      dueTask("dm-2", "enr-2", "step-dm"),
    );
    await processDueSequenceTasks(client);

    expect(unipile.listLinkedInRelations).toHaveBeenCalledTimes(1);
    expect(find(tables.outreach_send_tasks, "dm-2").status).toBe("ready");
  });

  it("after the first full read, a refresh stops at connections it has already seen", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm")],
      relationsCache: [
        {
          account_id: "acc-1",
          identities: ["old-friend"],
          complete: true,
          covered_since: null,
          fetched_at: ago(7 * HOUR),
          next_fetch_after: ago(HOUR),
        },
      ],
    });
    // Newest first: Jane accepted this morning, then older connections.
    unipile.listLinkedInRelations.mockResolvedValue({
      items: [relation("jane-doe", ago(4 * HOUR)), relation("old-friend", ago(30 * DAY))],
      cursor: "next-page",
    });

    await processDueSequenceTasks(client);

    expect(unipile.listLinkedInRelations).toHaveBeenCalledTimes(1);
    expect(find(tables.outreach_send_tasks, "dm-1").status).toBe("ready");
    const [cache] = tables.linkedin_relations_cache;
    expect(cache.complete).toBe(true);
    expect(cache.identities).toEqual(expect.arrayContaining(["old-friend", "jane-doe"]));
  });
});

describe("sending a DM from the queue", () => {
  const stored = (identities: string[]) => [
    {
      account_id: "acc-1",
      identities,
      complete: true,
      covered_since: null,
      fetched_at: ago(HOUR),
      next_fetch_after: new Date(Date.parse(NOW) + 3 * HOUR).toISOString(),
    },
  ];

  it("puts the DM back to wait, unsent, when the person is known not to be connected", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm", { status: "ready" })],
      relationsCache: stored(["someone-else"]),
    });

    const result = await sendTaskNow(client, "dm-1");

    expect(result).toMatchObject({
      ok: false,
      status: "skipped",
      error: "Waiting for the LinkedIn connection request to be accepted",
    });
    const dm = find(tables.outreach_send_tasks, "dm-1");
    expect(dm.status).toBe("scheduled");
    expect(dm.meta).toMatchObject({ waiting_on_connection: true });
    expect(unipile.startUnipileChat).not.toHaveBeenCalled();
    expect(unipile.sendUnipileChatMessage).not.toHaveBeenCalled();
    expect(unipile.listLinkedInRelations).not.toHaveBeenCalled();
  });

  it("sends as before when the person is connected", async () => {
    const { client, tables } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm", { status: "ready" })],
      relationsCache: stored(["jane-doe"]),
    });

    const result = await sendTaskNow(client, "dm-1");

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(unipile.startUnipileChat).toHaveBeenCalledTimes(1);
    expect(find(tables.outreach_send_tasks, "dm-1").status).toBe("sent");
  });

  it("sends as before when nothing is stored yet, rather than syncing the network on a click", async () => {
    const { client } = world({
      enrollments: [enrollment("enr-1", "jane-doe")],
      tasks: [sentInvite("enr-1", ago(3 * DAY)), dueTask("dm-1", "enr-1", "step-dm", { status: "ready" })],
    });

    const result = await sendTaskNow(client, "dm-1");

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(unipile.listLinkedInRelations).not.toHaveBeenCalled();
  });
});
