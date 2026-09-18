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

  it("skips an overlapping run while the previous one is still active", async () => {
    let resolveGmail!: (v: never) => void;
    vi.mocked(syncAllMailboxesInbox).mockReturnValue(
      new Promise((res) => {
        resolveGmail = res;
      }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const first = runOutreachInboxCron();
      await runOutreachInboxCron();
      resolveGmail(gmailResult as never);
      await first;
      expect(syncAllMailboxesInbox).toHaveBeenCalledTimes(1);
      expect(syncUnipileLinkedInInbox).toHaveBeenCalledTimes(1);
      const line = log.mock.calls.map((c) => String(c[0])).join("\n");
      expect(line).toMatch(/previous run still active, skipping overlap/);
    } finally {
      log.mockRestore();
    }
  });
});
