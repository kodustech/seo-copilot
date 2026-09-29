import { describe, expect, it } from "vitest";

import {
  createdInPeriod,
  enteredOpportunity,
  firstEntries,
  stageEntries,
  type StatusChange,
} from "@/lib/funnel/stage-entries";

const PERIOD = { periodStart: "2026-09-01", nextStart: "2026-10-01" };

function move(company_id: string, from: string, to: string, at: string): StatusChange {
  return { company_id, kind: "status_change", actor: "someone@kodus.io", from, to, created_at: at };
}

function company(id: string, status: string, created_at: string) {
  return { id, status, created_at };
}

/** The period's status changes, as loadActivities hands them over. */
function inPeriod(history: StatusChange[]): StatusChange[] {
  return history.filter((h) => h.created_at >= "2026-09-01" && h.created_at < "2026-10-01");
}

function entries(companies: ReturnType<typeof company>[], history: StatusChange[]) {
  return stageEntries({ changes: inPeriod(history), companies, history, ...PERIOD });
}

const ids = (list: StatusChange[]) => list.map((e) => e.company_id);
const meetings = (list: StatusChange[]) => ids(firstEntries(list, (e) => e.to === "meeting"));
const opportunities = (list: StatusChange[]) => ids(firstEntries(list, enteredOpportunity));

describe("stage entries", () => {
  it("counts an account created straight into meeting as a meeting on its creation date", () => {
    const list = entries([company("inbound", "meeting", "2026-09-10T14:00:00.123+00:00")], []);
    expect(meetings(list)).toEqual(["inbound"]);
    // No actor: creation must not read as a human touch.
    expect(list[0]).toMatchObject({ kind: "created", from: null, to: "meeting", actor: null });
    expect(list[0].created_at.slice(0, 10)).toBe("2026-09-10");
  });

  it("counts an account created in qualified as an opportunity", () => {
    const list = entries([company("q", "qualified", "2026-09-14T10:00:00+00:00")], []);
    expect(opportunities(list)).toEqual(["q"]);
  });

  it("counts an account created in lead and moved to meeting once", () => {
    const history = [move("a", "lead", "meeting", "2026-09-12T09:00:00+00:00")];
    const list = entries([company("a", "meeting", "2026-09-11T09:00:00+00:00")], history);
    expect(meetings(list)).toEqual(["a"]);
    expect(firstEntries(list, (e) => e.to === "meeting")[0].kind).toBe("status_change");
  });

  it("counts an account created in meeting that leaves and comes back once", () => {
    const history = [
      move("a", "meeting", "engaged", "2026-09-12T09:00:00+00:00"),
      move("a", "engaged", "meeting", "2026-09-20T09:00:00+00:00"),
    ];
    const list = entries([company("a", "meeting", "2026-09-11T09:00:00+00:00")], history);
    expect(meetings(list)).toEqual(["a"]);
    expect(firstEntries(list, (e) => e.to === "meeting")[0].kind).toBe("created");
  });

  it("gives no creation entry to an account created before the period", () => {
    const list = entries([company("old", "meeting", "2026-08-20T09:00:00+00:00")], []);
    expect(list).toEqual([]);
    expect(meetings(list)).toEqual([]);
  });

  it("does not count an account already past a stage before the period", () => {
    const history = [move("old", "qualified", "poc", "2026-09-05T09:00:00+00:00")];
    const list = entries([company("old", "poc", "2026-08-10T09:00:00+00:00")], history);
    expect(opportunities(list)).toEqual([]);
  });

  it("reads the creation status from the first change, not the status today", () => {
    // Created on the 29th in lead, moved to meeting next month: today it is a
    // meeting, but September must not count it.
    const history = [move("late", "lead", "meeting", "2026-10-05T09:00:00+00:00")];
    const list = entries([company("late", "meeting", "2026-09-29T09:00:00+00:00")], history);
    expect(list).toMatchObject([{ company_id: "late", kind: "created", to: "lead" }]);
    expect(meetings(list)).toEqual([]);
  });

  it("counts an account created in qualified and moved to poc once, on its creation date", () => {
    const history = [move("q", "qualified", "poc", "2026-09-20T09:00:00+00:00")];
    const list = entries([company("q", "poc", "2026-09-14T09:00:00+00:00")], history);
    const opps = firstEntries(list, enteredOpportunity);
    expect(ids(opps)).toEqual(["q"]);
    expect(opps[0]).toMatchObject({ kind: "created", to: "qualified" });
  });

  it("takes the earliest change whatever order the history comes in", () => {
    const history = [
      move("a", "meeting", "qualified", "2026-09-20T09:00:00+00:00"),
      move("a", "lead", "meeting", "2026-09-15T09:00:00+00:00"),
    ];
    const list = entries([company("a", "qualified", "2026-09-10T09:00:00+00:00")], history);
    expect(list[0]).toMatchObject({ kind: "created", to: "lead" });
  });

  it("skips the creation entry when the first change has no from", () => {
    const history = [{ ...move("a", "lead", "meeting", "2026-09-15T09:00:00+00:00"), from: null }];
    const list = entries([company("a", "meeting", "2026-09-10T09:00:00+00:00")], history);
    expect(list.filter((e) => e.kind === "created")).toEqual([]);
  });

  it("puts creation before a move logged in the same instant", () => {
    const at = "2026-09-10T09:00:00+00:00";
    const list = entries([company("a", "meeting", at)], [move("a", "lead", "meeting", at)]);
    expect(list.map((e) => e.kind)).toEqual(["created", "status_change"]);
  });
});

describe("created in period", () => {
  it("compares instants, not strings, at both edges", () => {
    const list = createdInPeriod(
      [
        company("first-instant", "lead", "2026-09-01T00:00:00.5+00:00"),
        company("last-day", "lead", "2026-09-30T23:59:59.999+00:00"),
        company("next-month", "lead", "2026-10-01T00:00:00+00:00"),
        company("before", "lead", "2026-08-31T23:59:59+00:00"),
      ],
      PERIOD.periodStart,
      PERIOD.nextStart,
    );
    expect(list.map((c) => c.id)).toEqual(["first-instant", "last-day"]);
  });
});
