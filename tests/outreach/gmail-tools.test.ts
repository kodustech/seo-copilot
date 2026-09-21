import { afterEach, describe, expect, it, vi } from "vitest";

import { buildMcpTools } from "@/lib/mcp/server";
import { createGmailDraft, replyHeadersFor, type GmailThread } from "@/lib/outreach/gmail";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_READONLY_SCOPE,
  buildRawGmailMessage,
  scopesIncludeGmailCompose,
} from "@/lib/outreach/google-oauth";

function decodeRaw(raw: string): string {
  return Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function thread(messages: Array<{ message_id: string | null; references: string | null }>, subject: string | null): GmailThread {
  return {
    thread_id: "t1",
    subject,
    messages: messages.map((m, i) => ({
      id: `m${i}`,
      from: null,
      to: null,
      cc: null,
      subject,
      date: null,
      body: null,
      body_truncated: false,
      ...m,
    })),
  };
}

describe("Gmail MCP wiring", () => {
  const { tools } = buildMcpTools({ userEmail: "test@kodus.io" });
  const schemaOf = (name: string) => {
    const t = tools.find((x) => x.name === name);
    expect(t).toBeDefined();
    return t?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  };

  it("registers gmailSearch with only query required", () => {
    expect(schemaOf("gmailSearch").required).toEqual(["query"]);
  });

  it("registers gmailGetThread with only thread_id required", () => {
    expect(schemaOf("gmailGetThread").required).toEqual(["thread_id"]);
  });

  it("registers gmailCreateDraft with to and body required", () => {
    const schema = schemaOf("gmailCreateDraft");
    expect([...(schema.required ?? [])].sort()).toEqual(["body", "to"]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["body", "cc", "mailbox_id", "subject", "thread_id", "to"],
    );
  });
});

describe("scopesIncludeGmailCompose", () => {
  it("accepts compose, modify or full mail", () => {
    expect(scopesIncludeGmailCompose(`${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`)).toBe(true);
    expect(scopesIncludeGmailCompose("https://www.googleapis.com/auth/gmail.modify")).toBe(true);
    expect(scopesIncludeGmailCompose("https://mail.google.com/")).toBe(true);
  });

  it("rejects readonly/send only and empty grants", () => {
    expect(scopesIncludeGmailCompose(`${GMAIL_READONLY_SCOPE} https://www.googleapis.com/auth/gmail.send`)).toBe(false);
    expect(scopesIncludeGmailCompose(null)).toBe(false);
  });
});

describe("replyHeadersFor", () => {
  it("replies to the last message and extends its References", () => {
    const h = replyHeadersFor(
      thread([
        { message_id: "<a@x>", references: null },
        { message_id: "<b@x>", references: "<a@x>" },
      ], "Proposta Kodus"),
    );
    expect(h).toEqual({ subject: "Re: Proposta Kodus", inReplyTo: "<b@x>", references: "<a@x> <b@x>" });
  });

  it("does not stack Re: and honours an explicit subject", () => {
    const t = thread([{ message_id: "<a@x>", references: null }], "RE: Proposta");
    expect(replyHeadersFor(t).subject).toBe("RE: Proposta");
    expect(replyHeadersFor(t, "Outro assunto").subject).toBe("Outro assunto");
  });
});

describe("buildRawGmailMessage", () => {
  it("writes a Cc header only when cc is given", () => {
    const withCc = decodeRaw(buildRawGmailMessage({ from: "a@kodus.io", to: "b@x.com", cc: "c@x.com, d@x.com", subject: "s", text: "hi" }));
    expect(withCc).toContain("Cc: c@x.com, d@x.com\r\n");
    const without = decodeRaw(buildRawGmailMessage({ from: "a@kodus.io", to: "b@x.com", subject: "s", text: "hi" }));
    expect(without).not.toContain("Cc:");
  });
});

describe("createGmailDraft", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts to drafts (never send) with threadId and reply headers", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "d1", message: { id: "m9", threadId: "t1" } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await createGmailDraft({
      accessToken: "tok",
      from: "Gabriel <gabriel@kodus.io>",
      to: "juliano@crefaz.com.br",
      subject: "Re: Proposta",
      text: "Oi Juliano",
      gmailThreadId: "t1",
      inReplyTo: "<b@x>",
      references: "<a@x> <b@x>",
    });

    expect(out).toEqual({ draftId: "d1", messageId: "m9", threadId: "t1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://gmail.googleapis.com/gmail/v1/users/me/drafts");
    const payload = JSON.parse(String(init.body)) as { message: { raw: string; threadId?: string } };
    expect(payload.message.threadId).toBe("t1");
    const raw = decodeRaw(payload.message.raw);
    expect(raw).toContain("To: juliano@crefaz.com.br\r\n");
    expect(raw).toContain("In-Reply-To: <b@x>\r\n");
    expect(raw).toContain("References: <a@x> <b@x>\r\n");
  });

  it("surfaces the Gmail error instead of pretending a draft exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient Permission" } }), { status: 403 }),
    ));
    await expect(
      createGmailDraft({ accessToken: "tok", from: "a@kodus.io", to: "b@x.com", subject: "s", text: "t" }),
    ).rejects.toThrow("Insufficient Permission");
  });
});
