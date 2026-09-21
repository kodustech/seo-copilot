import { describe, expect, it } from "vitest";

import { orderChatMessages } from "@/lib/linkedin-inbox";
import { buildMcpTools } from "@/lib/mcp/server";

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
