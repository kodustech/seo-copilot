import { afterEach, describe, expect, it, vi } from "vitest";

const mailbox = vi.hoisted(() => ({ box: null as Record<string, unknown> | null }));
vi.mock("@/lib/outreach/mailbox", () => ({
  getMailboxWithSecrets: async () => mailbox.box,
  ensureFreshAccessToken: async () => "tok",
}));

import { buildMcpTools } from "@/lib/mcp/server";
import {
  createGmailDraft,
  getGmailThread,
  openGmailMailbox,
  replyHeadersFor,
  searchGmailMessages,
  type GmailThread,
} from "@/lib/outreach/gmail";
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
    omitted_older: 0,
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

describe("openGmailMailbox", () => {
  const box = (scopes: string, inboxSyncReady: boolean) => ({
    fromEmail: "gabriel@kodus.io",
    fromName: null,
    authMethod: "oauth",
    provider: "google_oauth",
    oauthGrantedScopes: scopes,
    inboxSyncReady,
  });
  const client = {} as never;

  it("refuses a reply draft on a compose-only grant instead of a raw 403 later", async () => {
    mailbox.box = box(GMAIL_COMPOSE_SCOPE, false);
    expect(await openGmailMailbox(client, null, "compose")).toMatchObject({ ok: true });
    const reply = await openGmailMailbox(client, null, "reply");
    expect(reply).toMatchObject({ ok: false });
    expect(reply.ok ? "" : reply.message).toContain("gmail.readonly");
  });

  it("allows a reply draft when both scopes are granted", async () => {
    mailbox.box = box(`${GMAIL_READONLY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`, true);
    expect(await openGmailMailbox(client, null, "reply")).toMatchObject({ ok: true, accessToken: "tok" });
  });
});

describe("searchGmailMessages", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips a message that fails to load instead of failing the search", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/messages?q=")) {
        return new Response(JSON.stringify({ messages: [{ id: "gone" }, { id: "ok" }] }), { status: 200 });
      }
      if (url.includes("/messages/gone")) {
        return new Response(JSON.stringify({ error: { message: "Not Found" } }), { status: 404 });
      }
      return new Response(JSON.stringify({ id: "ok", threadId: "t", internalDate: "0", labelIds: ["UNREAD"], payload: { headers: [{ name: "Subject", value: "oi" }] } }), { status: 200 });
    }));
    const out = await searchGmailMessages("tok", "newer_than:1d", 20);
    expect(out.map((m) => m.id)).toEqual(["ok"]);
    expect(out[0]).toMatchObject({ subject: "oi", unread: true });
  });
});

describe("getGmailThread", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps the newest messages of a long thread, newest last, subject from the first", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      id: `m${i}`,
      internalDate: String(i),
      payload: { headers: [{ name: "Subject", value: i === 0 ? "Proposta" : "Re: Proposta" }, { name: "Message-ID", value: `<m${i}@x>` }] },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "t1", messages }), { status: 200 })));
    const t = await getGmailThread("tok", "t1");
    expect(t.omitted_older).toBe(5);
    expect(t.messages).toHaveLength(15);
    expect(t.messages[14].message_id).toBe("<m19@x>");
    expect(t.subject).toBe("Proposta");
  });

  it("asks Gmail for headers only when bodies are not needed", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "t1", messages: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await getGmailThread("tok", "t1", { bodies: false });
    const url = String((fetchMock.mock.calls[0] as unknown as [string])[0]);
    expect(url).toContain("format=metadata&metadataHeaders=From");
    expect(url).toContain("metadataHeaders=Message-ID&metadataHeaders=References");
    expect(url).not.toContain("format=full");
    await getGmailThread("tok", "t1");
    expect(String((fetchMock.mock.calls[1] as unknown as [string])[0])).toContain("format=full");
  });
});

describe("buildRawGmailMessage", () => {
  it("strips line breaks from To and Cc so no header can be smuggled in", () => {
    const raw = decodeRaw(buildRawGmailMessage({
      from: "a@kodus.io",
      to: "b@x.com\r\nBcc: evil@x.com",
      cc: "c@x.com\nBcc: evil@x.com",
      subject: "s",
      text: "hi",
    }));
    expect(raw).not.toMatch(/\r?\nBcc:/);
    expect(raw).toContain("To: b@x.com Bcc: evil@x.com\r\n");
  });

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
