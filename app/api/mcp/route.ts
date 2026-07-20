/**
 * MCP HTTP endpoint — exposes seo-copilot tools to remote MCP clients.
 *
 * Used by Claude Code (running in `kodus-growth/`), Anthropic Desktop,
 * Cursor, Cline, etc. via `.mcp.json` pointing to this URL.
 *
 * Auth (dual):
 *   1. Personal PAT — create in Settings → MCP access after login.
 *      Identity = token owner (ignores x-mcp-user-email).
 *   2. Shared MCP_AUTH_TOKEN env (legacy/service). Identity from
 *      x-mcp-user-email or MCP_DEFAULT_USER_EMAIL. Disable with
 *      MCP_ALLOW_SHARED_TOKEN=false.
 *
 * Transport: simplified JSON-RPC over HTTP. Stateless (one request →
 * one response). Methods: initialize, tools/list, tools/call, ping.
 */

import {
  buildMcpTools,
  SERVER_INFO,
  PROTOCOL_VERSION,
  type McpToolDefinition,
} from "@/lib/mcp/server";
import { resolveMcpAuth } from "@/lib/mcp/tokens";

export const runtime = "nodejs";
export const maxDuration = 300;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      result: unknown;
    }
  | {
      jsonrpc: "2.0";
      id: string | number | null;
      error: { code: number; message: string; data?: unknown };
    };

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, data } };
}

async function dispatchRpc(
  message: JsonRpcRequest,
  tools: McpToolDefinition[]
): Promise<JsonRpcResponse> {
  const id = message.id ?? null;
  const method = message.method;
  const params = message.params ?? {};

  switch (method) {
    case "initialize": {
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case "ping": {
      return jsonRpcResult(id, {});
    }

    case "tools/list": {
      return jsonRpcResult(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    }

    case "tools/call": {
      const name = params.name as string | undefined;
      const args = (params.arguments as Record<string, unknown>) ?? {};

      if (!name) {
        return jsonRpcError(id, -32602, "Missing 'name' parameter");
      }

      const tool = tools.find((t) => t.name === name);
      if (!tool) {
        return jsonRpcError(id, -32601, `Tool not found: ${name}`);
      }

      try {
        const result = await tool.execute(args);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);
        return jsonRpcResult(id, {
          content: [{ type: "text", text }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        });
      }
    }

    case "notifications/initialized":
    case "notifications/cancelled": {
      // Notifications have no response.
      return jsonRpcResult(id, {});
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

export async function POST(req: Request) {
  const resolved = await resolveMcpAuth(req);
  if (!resolved.ok) {
    return new Response(
      JSON.stringify({ error: resolved.error, reason: resolved.reason }),
      {
        status: resolved.status,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid_json", reason: "Body must be valid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { tools } = buildMcpTools({ userEmail: resolved.auth.userEmail });

  // Support batched requests (JSON-RPC 2.0 spec).
  if (Array.isArray(body)) {
    const responses = await Promise.all(
      (body as JsonRpcRequest[]).map((msg) => dispatchRpc(msg, tools))
    );
    return Response.json(responses);
  }

  const response = await dispatchRpc(body as JsonRpcRequest, tools);
  return Response.json(response);
}

export async function GET() {
  // Health check / probe.
  return Response.json({
    ok: true,
    server: SERVER_INFO,
    protocolVersion: PROTOCOL_VERSION,
    transport: "http-jsonrpc",
    auth: {
      personalTokens: true,
      sharedToken: process.env.MCP_ALLOW_SHARED_TOKEN?.toLowerCase() !== "false",
      mintPath: "/settings (MCP access) or POST /api/mcp/tokens",
    },
    note: "POST JSON-RPC with Authorization: Bearer <personal or shared token>.",
  });
}
