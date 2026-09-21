/**
 * A LinkedIn connect_note step with no note is a blank connection request, and
 * sequences often open that way. The send path used to refuse every empty
 * LinkedIn body with "Empty message body" before it knew the step's action, so
 * the first step of those sequences could not go out through the queue,
 * outreachSendQueuedTask or the one-off tool, and the task was marked failed.
 * These tests pin the split: an empty body is a plain invite on a connection
 * request and still an error on a DM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const unipile = vi.hoisted(() => ({
  isUnipileConfigured: vi.fn(() => true),
  listLinkedInAccounts: vi.fn(async () => [{ id: "acc-1" }]),
  getUnipileUserProfile: vi.fn(async () => ({
    providerId: "ACoAAjane",
    profileUrl: "https://www.linkedin.com/in/jane-doe",
    firstName: "Jane",
    lastName: "Doe",
  })),
  sendLinkedInInvitation: vi.fn(async () => ({ invitationId: "inv-1" })),
  findUnipileChatByAttendee: vi.fn(async () => null),
  sendUnipileChatMessage: vi.fn(async () => ({ messageId: "msg-1" })),
  startUnipileChat: vi.fn(async () => ({ chatId: "chat-1", messageId: "msg-1" })),
}));
vi.mock("@/lib/unipile", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/unipile")>()),
  ...unipile,
}));

const db = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/supabase-server")>()),
  getSupabaseServiceClient: () => db.client,
}));

import { outreachSendLinkedInMessage, outreachSendQueuedTask } from "@/lib/ai/tools";
import { resolveLinkedInSendAction, sendTaskNow } from "@/lib/outreach/sequences";

type Row = Record<string, unknown>;

/**
 * In-memory tables behind the handful of query-builder calls the send path
 * makes. Filters apply when the chain resolves, so an update narrowed by
 * `.in("status", claimFrom)` only touches rows still in that status, which is
 * what makes the claim assertions below mean something. Reads from a table in
 * `failReads` come back as a Supabase error, the way a dropped connection does.
 */
function fakeSupabase(
  tables: Record<string, Row[]>,
  failReads: ReadonlySet<string> = new Set(),
) {
  const writes: { table: string; patch: Row }[] = [];
  const client = {
    from(table: string) {
      const filters: Array<(r: Row) => boolean> = [];
      let patch: Row | null = null;
      const readError = () =>
        !patch && failReads.has(table) ? { message: "read failed" } : null;
      const run = () => {
        const rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        if (patch) {
          writes.push({ table, patch });
          for (const r of rows) Object.assign(r, patch);
        }
        return rows.map((r) => ({ ...r }));
      };
      const builder = {
        select: () => builder,
        order: () => builder,
        eq: (col: string, v: unknown) => {
          filters.push((r) => r[col] === v);
          return builder;
        },
        in: (col: string, vs: readonly unknown[]) => {
          filters.push((r) => vs.includes(r[col]));
          return builder;
        },
        update: (p: Row) => {
          patch = p;
          return builder;
        },
        maybeSingle: async () =>
          readError()
            ? { data: null, error: readError() }
            : { data: run()[0] ?? null, error: null },
        single: async () => ({ data: run()[0] ?? null, error: null }),
        then: (resolve: (v: { data: Row[] | null; error: unknown }) => unknown) =>
          resolve(
            readError()
              ? { data: null, error: readError() }
              : { data: run(), error: null },
          ),
      };
      return builder;
    },
    rpc: async () => ({ error: null }),
  };
  return { client: client as never, tables, writes };
}

function linkedInTask(opts: {
  action: "connect_note" | "message" | null;
  body: string;
  /** How the step read goes: the row is there, gone, or the read errors. */
  step?: "present" | "missing" | "unreadable";
}) {
  const step = opts.step ?? "present";
  return fakeSupabase(
    {
    outreach_send_tasks: [
      {
        id: "task-1",
        enrollment_id: "enr-1",
        step_id: "step-1",
        channel: "linkedin",
        mode: "semi",
        status: "ready",
        scheduled_for: "2026-09-21T12:00:00.000Z",
        rendered_subject: null,
        rendered_body: opts.body,
        error: null,
        meta: {},
      },
    ],
    outreach_enrollments: [
      {
        id: "enr-1",
        sequence_id: "seq-1",
        source: "manual",
        company_name: "Example Co",
        contact_name: "Jane Doe",
        contact_email: null,
        contact_linkedin: "https://www.linkedin.com/in/jane-doe",
        status: "active",
        current_step_position: 1,
      },
    ],
    outreach_sequence_steps:
      step === "missing"
        ? []
        : [
            {
              id: "step-1",
              sequence_id: "seq-1",
              position: 1,
              channel: "linkedin",
              mode: "semi",
              delay_hours: 0,
              linkedin_action: opts.action,
              body_template: opts.body,
            },
          ],
    },
    new Set(step === "unreadable" ? ["outreach_sequence_steps"] : []),
  );
}

const task = (tables: Record<string, Row[]>) => tables.outreach_send_tasks[0];
const claimed = (writes: { patch: Row }[]) =>
  writes.some((w) => w.patch.status === "sending");

beforeEach(() => {
  for (const fn of Object.values(unipile)) fn.mockClear();
});

describe("resolveLinkedInSendAction", () => {
  it.each([
    ["connect_note", "", "connect_note"],
    ["connect_note", "Hi Jane", "connect_note"],
    ["message", "Hi Jane", "message"],
    ["message", "  ", null],
    [null, "", null],
    // Backward compatibility: a body with no readable action is an invite.
    [null, "Hi Jane", "connect_note"],
  ] as const)("%s with body %j sends as %s", (action, body, expected) => {
    expect(resolveLinkedInSendAction(action, body)).toBe(expected);
  });
});

describe("sendTaskNow on a LinkedIn step with an empty body", () => {
  it("sends a connect_note as an invitation with no note", async () => {
    const { client, tables } = linkedInTask({ action: "connect_note", body: "" });

    const result = await sendTaskNow(client, "task-1");

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(unipile.sendLinkedInInvitation).toHaveBeenCalledTimes(1);
    expect(unipile.sendLinkedInInvitation).toHaveBeenCalledWith({
      accountId: "acc-1",
      providerId: "ACoAAjane",
      message: "",
    });
    expect(task(tables).status).toBe("sent");
    expect(task(tables).error).toBeNull();
  });

  it("still fails a DM, before the claim and without touching Unipile", async () => {
    const { client, tables, writes } = linkedInTask({ action: "message", body: "" });

    const result = await sendTaskNow(client, "task-1");

    expect(result).toMatchObject({ ok: false, status: "failed", error: "Empty message body" });
    expect(task(tables).status).toBe("failed");
    expect(claimed(writes)).toBe(false);
    expect(unipile.listLinkedInAccounts).not.toHaveBeenCalled();
    expect(unipile.startUnipileChat).not.toHaveBeenCalled();
  });

  // Only an explicit connect_note makes a blank invite deliberate. Anything the
  // step does not say keeps the old refusal, because guessing wrong sends a
  // connection request in place of a DM and cannot be taken back.
  it.each([
    ["an unset action", { action: null }],
    ["a missing step", { action: "connect_note", step: "missing" }],
    ["a step read that fails", { action: "connect_note", step: "unreadable" }],
  ] as const)("fails with %s instead of sending a blank invite", async (_label, setup) => {
    const { client, tables, writes } = linkedInTask({ ...setup, body: "" });

    const result = await sendTaskNow(client, "task-1");

    expect(result).toMatchObject({ ok: false, status: "failed", error: "Empty message body" });
    expect(task(tables).status).toBe("failed");
    expect(claimed(writes)).toBe(false);
    expect(unipile.sendLinkedInInvitation).not.toHaveBeenCalled();
  });

  it("still sends a note as a connection request when the action is unset", async () => {
    // Backward compatibility with the send path before the action could be
    // unknown: a body and no readable action went out as an invite.
    const { client, tables } = linkedInTask({ action: null, body: "Hi Jane" });

    const result = await sendTaskNow(client, "task-1");

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(unipile.sendLinkedInInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Hi Jane" }),
    );
    expect(task(tables).meta).toMatchObject({ linkedin_action: "connect_note" });
  });

  it("sends a connect_note blank when the edit clears its note, and records the blank", async () => {
    const { client, tables } = linkedInTask({ action: "connect_note", body: "Hi Jane" });

    const result = await sendTaskNow(client, "task-1", { body: "   " });

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(unipile.sendLinkedInInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ message: "" }),
    );
    // The row is the record of what left; the old note did not.
    expect(task(tables).rendered_body).toBe("");
  });

  it.each([
    ["a DM", { action: "message" }],
    ["a step with an unset action", { action: null }],
    ["a step that cannot be read", { action: "connect_note", step: "unreadable" }],
  ] as const)("refuses an edit that clears %s and leaves the task as it was", async (_label, setup) => {
    const { client, tables, writes } = linkedInTask({ ...setup, body: "Hi Jane" });

    await expect(sendTaskNow(client, "task-1", { body: "" })).rejects.toThrow(
      "The message body is empty",
    );
    expect(task(tables).status).toBe("ready");
    expect(writes).toHaveLength(0);
  });

  it("keeps the unfilled-token guard on a connect_note that has a note", async () => {
    const { client, tables, writes } = linkedInTask({
      action: "connect_note",
      body: "Hi {{first_name}}",
    });

    const result = await sendTaskNow(client, "task-1");

    expect(result.ok).toBe(false);
    expect(result.status).toBe("skipped");
    expect(task(tables).status).toBe("ready");
    expect(String(task(tables).error)).toContain("{{first_name}}");
    expect(claimed(writes)).toBe(false);
    expect(unipile.sendLinkedInInvitation).not.toHaveBeenCalled();
  });
});

const run = <T,>(t: { execute?: (input: T, opts: never) => unknown }, input: T) =>
  t.execute!(input, { toolCallId: "call-1", messages: [] } as never) as Promise<
    Record<string, unknown>
  >;

describe("outreachSendQueuedTask preview", () => {
  it("shows the action the send will use and record, not the raw step value", async () => {
    // An unset action with a body goes out as a connection request, so the
    // preview has to say connect_note, not null.
    db.client = linkedInTask({ action: null, body: "Hi Jane" }).client;
    const out = await run(outreachSendQueuedTask, { task_id: "task-1" });

    expect(out).toMatchObject({ success: true, would_send: true, refusal: null });
    expect(out.preview).toMatchObject({ linkedin_action: "connect_note" });

    const sent = linkedInTask({ action: null, body: "Hi Jane" });
    await sendTaskNow(sent.client, "task-1");
    expect(task(sent.tables).meta).toMatchObject({
      linkedin_action: (out.preview as Row).linkedin_action,
    });
  });

  it("previews an empty-body connect_note as sendable", async () => {
    db.client = linkedInTask({ action: "connect_note", body: "" }).client;

    const out = await run(outreachSendQueuedTask, { task_id: "task-1" });

    expect(out).toMatchObject({ success: true, would_send: true, refusal: null });
    expect(out.preview).toMatchObject({ linkedin_action: "connect_note", body: "" });
  });

  it.each([
    ["a DM", { action: "message" }],
    ["a step with an unset action", { action: null }],
    ["a step that cannot be read", { action: "connect_note", step: "unreadable" }],
  ] as const)("says a real send would refuse an empty body on %s", async (_label, setup) => {
    db.client = linkedInTask({ ...setup, body: "" }).client;

    const out = await run(outreachSendQueuedTask, { task_id: "task-1" });

    expect(out).toMatchObject({
      success: true,
      would_send: false,
      refusal: "the body is empty, and only a connect_note step can send without one",
    });
  });
});

describe("outreachSendLinkedInMessage with empty text", () => {
  it("previews a connect_note as a request without a note", async () => {
    const out = await run(outreachSendLinkedInMessage, {
      linkedin: "jane-doe",
      text: "",
      action: "connect_note",
    });

    expect(out).toMatchObject({ success: true, dry_run: true });
    expect(out.preview).toMatchObject({
      resolves_to: "connection request without a note",
    });
  });

  it("sends a connect_note with no note", async () => {
    const out = await run(outreachSendLinkedInMessage, {
      linkedin: "jane-doe",
      text: "",
      action: "connect_note",
      dry_run: false,
    });

    expect(out).toMatchObject({ success: true, sent: true, invitation_id: "inv-1" });
    expect(unipile.sendLinkedInInvitation).toHaveBeenCalledWith({
      accountId: "acc-1",
      providerId: "ACoAAjane",
      message: "",
    });
  });

  it("still refuses a DM with no text", async () => {
    const out = await run(outreachSendLinkedInMessage, {
      linkedin: "jane-doe",
      text: "  ",
      dry_run: false,
    });

    expect(out).toEqual({ success: false, message: "text is empty" });
    expect(unipile.startUnipileChat).not.toHaveBeenCalled();
    expect(unipile.sendUnipileChatMessage).not.toHaveBeenCalled();
  });
});
