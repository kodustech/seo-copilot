#!/usr/bin/env node
/**
 * Kodus SEO Copilot — MCP Server (stdio mode, local dev)
 *
 * For production HTTP mode, see `seo-copilot/app/api/mcp/route.ts`.
 *
 * Run:
 *   - dev:   `npm run mcp` (uses tsx, hot reload)
 *   - prod:  `npm run mcp:build && node mcp-server/dist/index.js`
 *
 * Configuration:
 *   - MCP_USER_EMAIL : email used as identity for user-scoped tools.
 *                     Defaults to `growth@kodus.io`.
 *
 * The shared factory lives at `seo-copilot/lib/mcp/server.ts` so the
 * HTTP and stdio transports stay in sync (single source of truth).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpTools, SERVER_INFO } from "@/lib/mcp/server";

// Next.js loads .env on its own; a bare tsx process does not. Without this,
// every tool that needs a credential (BIGQUERY_CREDENTIALS, Supabase, …)
// fails at call time with "env var is not set".
for (const envFile of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(envFile);
  } catch {
    // Missing file is fine — the var may come from the real environment.
  }
}

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
      // The Zod schema, not the JSON Schema: registerTool validates with Zod
      // and throws "unrecognized object" on a plain JSON Schema.
      inputSchema: tool.zodSchema as never,
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

const shutdown = () => {
  console.error("[mcp/stdio] shutting down");
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Not top-level await: the root package.json has no `"type": "module"`, so
// tsx/esbuild emits CJS and top-level await is a hard transform error.
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("[mcp/stdio] failed to start:", err);
  process.exit(1);
});
