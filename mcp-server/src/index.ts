#!/usr/bin/env node
/**
 * Kodus SEO Copilot — MCP Server (stdio mode)
 *
 * Local development entrypoint. For remote/HTTP mode, see
 * `seo-copilot/app/api/mcp/route.ts`.
 *
 * Run:
 *   - dev:   `npm run mcp` (uses tsx, hot reload)
 *   - prod:  `npm run mcp:build && node mcp-server/dist/index.js`
 *
 * Configuration:
 *   - MCP_USER_EMAIL : email used as identity for user-scoped tools.
 *                     Defaults to `growth@kodus.io`.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpTools, SERVER_INFO } from "./server.js";

const userEmail = process.env.MCP_USER_EMAIL ?? "growth@kodus.io";
const { tools, skipped } = buildMcpTools({ userEmail });

const server = new McpServer(SERVER_INFO, {
  capabilities: { tools: {} },
});

for (const tool of tools) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: tool.inputSchema as never,
    },
    async (args: unknown) => {
      try {
        const result = await tool.execute(args);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    }
  );
}

console.error(
  `[mcp/stdio] seo-copilot ready. Registered ${tools.length} tools (skipped ${skipped}). User: ${userEmail}`
);

const transport = new StdioServerTransport();
await server.connect(transport);

const shutdown = () => {
  console.error("[mcp/stdio] shutting down");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
