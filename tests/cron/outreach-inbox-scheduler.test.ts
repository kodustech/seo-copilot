/**
 * LinkedIn replies stopped landing in the reply inbox because nothing on a
 * schedule ran the Unipile pull: the in-process outreach-inbox job synced
 * Gmail only, the HTTP cron route is hit by nothing, and webhooks alone did
 * not cover it. This guards the composition — the scheduled inbox run must
 * pull LinkedIn every time, and must still report Gmail when LinkedIn fails.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase-server", () => ({
  getSupabaseServiceClient: vi.fn(() => ({ __client: true })),
}));

vi.mock("@/lib/outreach/inbox", () => ({
  syncAllMailboxesInbox: vi.fn(),
}));

vi.mock("@/lib/unipile-replies", () => ({
  syncUnipileLinkedInInbox: vi.fn(),
}));

import { syncAllMailboxesInbox } from "@/lib/outreach/inbox";
import { syncUnipileLinkedInInbox } from "@/lib/unipile-replies";
import { runOutreachInboxCron } from "@/lib/cron/scheduler";

const gmailResult = [
  { ok: true, threadsTouched: 2, enrollmentsMarkedReplied: 1 },
];

const linkedinResult = {
  ok: true,
  mode: "unipile_pull",
  accounts: 1,
  chatsScanned: 40,
  threadsTouched: 3,
  messagesUpserted: 5,
  enrollmentsMarkedReplied: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(syncAllMailboxesInbox).mockResolvedValue(gmailResult as never);
  vi.mocked(syncUnipileLinkedInInbox).mockResolvedValue(linkedinResult as never);
});

describe("runOutreachInboxCron", () => {
  it("pulls LinkedIn replies on every scheduled run", async () => {
    await runOutreachInboxCron();
    expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(1);
    expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
    expect(syncUnipileLinkedInInbox).toHaveBeenCalledWith(
      expect.objectContaining({ __client: true }),
    );
  });

  it("reports LinkedIn numbers on the cron line", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runOutreachInboxCron();
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/linkedin: 1 account\(s\), 40 chats, 3 threads, 5 messages, 2 marked replied/);
    } finally {
      log.mockRestore();
    }
  });

  it("still reports Gmail when the LinkedIn pull returns an error", async () => {
    vi.mocked(syncUnipileLinkedInInbox).mockResolvedValue({
      ...linkedinResult,
      ok: false,
      error: "boom",
    } as never);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runOutreachInboxCron();
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/1\/1 mailboxes/);
      expect(line).toMatch(/linkedin error: boom/);
    } finally {
      log.mockRestore();
    }
  });

  it("still reports Gmail when the LinkedIn pull throws", async () => {
    vi.mocked(syncUnipileLinkedInInbox).mockRejectedValue(new Error("down"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runOutreachInboxCron()).resolves.toBeUndefined();
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/1\/1 mailboxes/);
      expect(line).toMatch(/linkedin error: down/);
    } finally {
      log.mockRestore();
    }
  });

  it("still pulls LinkedIn when the Gmail sync throws (one broken mailbox must not gate replies)", async () => {
    vi.mocked(syncAllMailboxesInbox).mockRejectedValue(new Error("Mailbox has no Google connection"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runOutreachInboxCron()).resolves.toBeUndefined();
      expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith(
        expect.stringContaining("gmail sync failed"),
        expect.anything(),
      );
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/0\/0 mailboxes/);
      expect(line).toMatch(/linkedin: 1 account\(s\)/);
    } finally {
      err.mockRestore();
      log.mockRestore();
    }
  });

  // NOTE: both overlap tests stagger the second run until the first has
  // reached its pending phase. Two overlapping runs also overlap their
  // dynamic imports, and this Vitest version resolves the second concurrent
  // duplicate dynamic import of a mocked module to the REAL module — a test
  // runner quirk, not production behavior (real modules dedup to one
  // instance). Waiting for the first run's phase entry proves its imports
  // settled, so the second run imports alone and sees the mocks.
  it("still pulls LinkedIn while a previous run is stuck in the Gmail phase", async () => {
    let resolveGmail!: (v: never) => void;
    vi.mocked(syncAllMailboxesInbox).mockReturnValue(
      new Promise((res) => {
        resolveGmail = res;
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = runOutreachInboxCron();
      await vi.waitFor(() => {
        expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(1);
      });
      await runOutreachInboxCron();
      // Second run skipped Gmail but still pulled LinkedIn exactly once.
      expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(1);
      expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/gmail phase still active, skipping overlap/);
      expect(line).toMatch(/linkedin: 1 account\(s\)/);
      resolveGmail(gmailResult as never);
      await first;
    } finally {
      log.mockRestore();
    }
  });

  it("retries a phase whose lease expired instead of skipping it forever", async () => {
    const now = vi.spyOn(Date, "now");
    // Fresh pending promise per call: run1 sticks on the first, run2 on the
    // second, so each run can be released independently.
    const gmailGate: Array<(v: never) => void> = [];
    vi.mocked(syncAllMailboxesInbox).mockImplementation(
      () =>
        new Promise((res) => {
          gmailGate.push(res);
        }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      now.mockReturnValue(1_000_000);
      const first = runOutreachInboxCron();
      await vi.waitFor(() => {
        expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(1);
      });
      // 21 minutes later the stuck phase's lease has expired: the next tick
      // retries instead of logging "skipping overlap" forever.
      now.mockReturnValue(1_000_000 + 21 * 60_000);
      const second = runOutreachInboxCron();
      await vi.waitFor(() => {
        expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(2);
      });
      gmailGate[1](gmailResult as never);
      await second;
      expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("gmail phase lease expired"),
      );
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).not.toMatch(/gmail phase still active/);
      // The originally stuck run settling late must not free the live lease.
      // Releasing it now is safe: the retried run already completed and
      // released its own stamp, so this delete is a no-op — assert the next
      // tick still runs normally.
      gmailGate[0](gmailResult as never);
      await first;
      // The next tick runs normally again (its Gmail call gets a fresh
      // pending promise that this test must release).
      const third = runOutreachInboxCron();
      await vi.waitFor(() => {
        expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(3);
      });
      gmailGate[2](gmailResult as never);
      await third;
      expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(3);
    } finally {
      log.mockRestore();
      warn.mockRestore();
      now.mockRestore();
    }
  });

  it("still syncs Gmail while a previous run is stuck in the LinkedIn phase", async () => {
    let resolveLinkedin!: (v: never) => void;
    vi.mocked(syncUnipileLinkedInInbox).mockReturnValue(
      new Promise((res) => {
        resolveLinkedin = res;
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = runOutreachInboxCron();
      // Let the first run reach the LinkedIn phase before overlapping it.
      await vi.waitFor(() => {
        expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      });
      await runOutreachInboxCron();
      expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(2);
      expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/linkedin phase still active, skipping overlap/);
      resolveLinkedin(linkedinResult as never);
      await first;
    } finally {
      log.mockRestore();
    }
  });
});
