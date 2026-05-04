/**
 * Tool registry shared by both MCP transports (HTTP + stdio).
 *
 * Pure function — no side effects, no transport coupling. Returns the
 * list of MCP-compatible tool definitions built from the Vercel AI SDK
 * tools in `lib/ai/tools.ts`. Each transport then plugs these into its
 * own dispatch mechanism.
 *
 * Used by:
 *   - app/api/mcp/route.ts        (HTTP, deployed)
 *   - mcp-server/src/index.ts     (stdio, local dev)
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { createAgentTools } from "@/lib/ai/tools";

type AnyTool = {
  description?: string;
  inputSchema?: unknown;
  parameters?: unknown;
  execute?: (input: unknown) => Promise<unknown>;
};

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

export interface BuildToolsOptions {
  /** Email used as identity for user-scoped tools (kanban, social, voice). */
  userEmail?: string;
}

export interface BuildToolsResult {
  tools: McpToolDefinition[];
  skipped: number;
}

/**
 * Build the MCP-compatible tool registry from `createAgentTools`.
 */
export function buildMcpTools(options: BuildToolsOptions = {}): BuildToolsResult {
  const userEmail = options.userEmail ?? "growth@kodus.io";
  const raw = createAgentTools(userEmail) as Record<string, AnyTool>;

  const tools: McpToolDefinition[] = [];
  let skipped = 0;

  for (const [name, t] of Object.entries(raw)) {
    if (!t || typeof t !== "object") {
      skipped++;
      continue;
    }

    const description = t.description ?? `seo-copilot tool ${name}`;
    const schemaSource = t.inputSchema ?? t.parameters;
    const execute = t.execute;

    if (!schemaSource || typeof execute !== "function") {
      skipped++;
      continue;
    }

    let inputSchema: Record<string, unknown>;
    try {
      inputSchema = zodToJsonSchema(
        schemaSource as Parameters<typeof zodToJsonSchema>[0],
        {
          target: "openApi3",
          $refStrategy: "none",
        }
      ) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }

    tools.push({
      name,
      description,
      inputSchema,
      execute: execute as (input: unknown) => Promise<unknown>,
    });
  }

  return { tools, skipped };
}

export const SERVER_INFO = {
  name: "seo-copilot",
  version: "0.1.0",
} as const;

export const PROTOCOL_VERSION = "2024-11-05";
