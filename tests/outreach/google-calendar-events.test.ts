import { describe, expect, it } from "vitest";

import { buildMcpTools } from "@/lib/mcp/server";

describe("listGoogleCalendarEvents MCP wiring", () => {
  it("is registered with an all-optional schema", () => {
    const { tools } = buildMcpTools({ userEmail: "test@kodus.io" });
    const tool = tools.find((t) => t.name === "listGoogleCalendarEvents");
    expect(tool).toBeDefined();
    expect(tool?.description).toContain("Calendar");

    const schema = tool?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
      ["mailbox_id", "max_results", "time_max", "time_min"].sort(),
    );
    expect(schema.required ?? []).toEqual([]);
  });
});
