import { describe, expect, it } from "vitest";

import { orderChatMessages } from "@/lib/linkedin-inbox";
import { buildMcpTools } from "@/lib/mcp/server";
import { linkedInLookupIdentifier } from "@/lib/unipile";

describe("LinkedIn read tools MCP wiring", () => {
  const { tools } = buildMcpTools({ userEmail: "test@kodus.io" });
  const schemaOf = (name: string) => {
    const t = tools.find((x) => x.name === name);
    expect(t).toBeDefined();
    return t?.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  };

  it("linkedinListChats takes only optional inputs", () => {
    const schema = schemaOf("linkedinListChats");
    expect(schema.required ?? []).toEqual([]);
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["account_id", "limit"]);
  });

  it("linkedinGetChat requires chat_id", () => {
    expect(schemaOf("linkedinGetChat").required).toEqual(["chat_id"]);
  });

  it("linkedinGetProfile requires linkedin", () => {
    expect(schemaOf("linkedinGetProfile").required).toEqual(["linkedin"]);
  });
});

describe("orderChatMessages", () => {
  it("reads oldest first and keeps who sent what", () => {
    const out = orderChatMessages([
      { id: "2", chatId: "c", text: "tudo certo, vamos marcar", timestamp: "2026-09-20T10:00:00.000Z", isSender: false, senderProviderId: "ACoAAx" },
      { id: "1", chatId: "c", text: "oi Juliano", timestamp: "2026-09-19T10:00:00.000Z", isSender: true, senderProviderId: "ACoAAme" },
    ]);
    expect(out).toEqual([
      { from_me: true, text: "oi Juliano", at: "2026-09-19T10:00:00.000Z" },
      { from_me: false, text: "tudo certo, vamos marcar", at: "2026-09-20T10:00:00.000Z" },
    ]);
  });
});

describe("linkedInLookupIdentifier", () => {
  it("keeps a member id's case, bare or inside a profile URL", () => {
    expect(linkedInLookupIdentifier("ACoAABcDeF")).toBe("ACoAABcDeF");
    expect(linkedInLookupIdentifier("https://www.linkedin.com/in/ACoAABcDeF/")).toBe("ACoAABcDeF");
    expect(linkedInLookupIdentifier("https://www.linkedin.com/in/ACoAABcDeF?miniProfileUrn=x")).toBe("ACoAABcDeF");
  });

  it("normalizes a vanity slug from a URL or bare", () => {
    expect(linkedInLookupIdentifier("https://www.linkedin.com/in/Juliano-Silva/")).toBe("juliano-silva");
    expect(linkedInLookupIdentifier("Juliano-Silva")).toBe("juliano-silva");
  });

  it("returns null for empty input", () => {
    expect(linkedInLookupIdentifier("  ")).toBeNull();
  });
});
