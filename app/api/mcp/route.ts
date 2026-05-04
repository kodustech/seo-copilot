/**
 * MCP HTTP endpoint — exposes seo-copilot tools to remote MCP clients.
 *
 * Used by Claude Code (running in `kodus-growth/`), Anthropic Desktop,
 * Cursor, Cline, etc. via `.mcp.json` pointing to this URL.
 *
 * Auth: Bearer token via `Authorization` header. The token must match
 * the `MCP_AUTH_TOKEN` env var. Generate a strong random token and
 * share with Junior + Ed (1Password). Rotate by changing the env var.
 *
 * Optional per-request identity: `x-mcp-user-email` header (used for
 * user-scoped tools like kanban). Defaults to `growth@kodus.io`.
 *
 * Transport: simplified JSON-RPC over HTTP. Stateless (one request →
 * one response), works perfectly with Vercel serverless. Implements
 * the subset of MCP needed for client→server tool invocation:
 *   - initialize
 *   - tools/list
 *   - tools/call
 *
 * For multi-user real auth (per-user tokens), see roadmap in
 * `kodus-growth/specs/setup/18-seo-copilot-mcp-export.md`.
 */

import {
  buildMcpTools,
  SERVER_INFO,
  PROTOCOL_VERSION,
  type McpToolDefinition,
} from "../../../mcp-server/src/server";

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

function unauthorized(reason: string) {
  return new Response(JSON.stringify({ error: "unauthorized", reason }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

function validateAuth(
  req: Request
): { ok: true; userEmail: string } | { ok: false; response: Response } {
  const expectedToken = process.env.MCP_AUTH_TOKEN;
  if (!expectedToken || expectedToken.length < 16) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: "server_misconfigured",
          reason:
            "MCP_AUTH_TOKEN is not set (or too short). Set it in seo-copilot env (>= 16 chars).",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      ),
    };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, response: unauthorized("Missing Bearer token") };
  }

  const presented = authHeader.slice("Bearer ".length).trim();
  if (presented !== expectedToken) {
    return { ok: false, response: unauthorized("Invalid token") };
  }

  const userEmail =
    req.headers.get("x-mcp-user-email")?.trim() ||
    process.env.MCP_DEFAULT_USER_EMAIL ||
    "growth@kodus.io";

  return { ok: true, userEmail };
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
  const auth = validateAuth(req);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "invalid_json", reason: "Body must be valid JSON" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { tools } = buildMcpTools({ userEmail: auth.userEmail });

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
    note: "POST JSON-RPC requests to this endpoint. See specs/setup/18.",
  });
}
