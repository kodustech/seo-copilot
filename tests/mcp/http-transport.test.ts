import { describe, expect, it } from "vitest";

import {
  createJsonRpcHttpResponse,
  isJsonRpcMessage,
  isJsonRpcNotification,
} from "../../lib/mcp/http-transport";

describe("JSON-RPC message validation", () => {
  it("accepts requests and notifications", () => {
    const notification = {
      jsonrpc: "2.0" as const,
      method: "notifications/initialized",
    };
    const request = { jsonrpc: "2.0" as const, id: null, method: "ping" };

    expect(isJsonRpcMessage(notification)).toBe(true);
    expect(isJsonRpcNotification(notification)).toBe(true);
    expect(isJsonRpcMessage(request)).toBe(true);
    expect(isJsonRpcNotification(request)).toBe(false);
  });

  it.each([
    null,
    [],
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 1 },
    { jsonrpc: "2.0", id: true, method: "ping" },
    { jsonrpc: "2.0", id: 1, method: "ping", params: "invalid" },
  ])("rejects invalid messages: %j", (message) => {
    expect(isJsonRpcMessage(message)).toBe(false);
  });
});

describe("createJsonRpcHttpResponse", () => {
  it("accepts initialized without returning a JSON-RPC response", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          notification: true,
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
      ],
      false
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("does not respond to unknown notifications", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          notification: true,
          response: {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32601, message: "Method not found" },
          },
        },
      ],
      false
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("keeps only request responses in a mixed batch", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          notification: true,
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
        {
          notification: false,
          response: { jsonrpc: "2.0", id: 7, result: {} },
        },
      ],
      true
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { jsonrpc: "2.0", id: 7, result: {} },
    ]);
  });

  it("returns 202 for a notification-only batch", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          notification: true,
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
        {
          notification: true,
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
      ],
      true
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("responds when the id is explicitly null", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          notification: false,
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
      ],
      false
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      result: {},
    });
  });
});
