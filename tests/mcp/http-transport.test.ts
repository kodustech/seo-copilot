import { describe, expect, it } from "vitest";

import { createJsonRpcHttpResponse } from "../../lib/mcp/http-transport";

describe("createJsonRpcHttpResponse", () => {
  it("accepts initialized without returning a JSON-RPC response", async () => {
    const response = createJsonRpcHttpResponse(
      [
        {
          message: { jsonrpc: "2.0", method: "notifications/initialized" },
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
          message: { jsonrpc: "2.0", method: "notifications/unknown" },
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
          message: { jsonrpc: "2.0", method: "notifications/initialized" },
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
        {
          message: { jsonrpc: "2.0", id: 7, method: "ping" },
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
          message: { jsonrpc: "2.0", method: "notifications/initialized" },
          response: { jsonrpc: "2.0", id: null, result: {} },
        },
        {
          message: { jsonrpc: "2.0", method: "notifications/cancelled" },
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
          message: { jsonrpc: "2.0", id: null, method: "ping" },
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
