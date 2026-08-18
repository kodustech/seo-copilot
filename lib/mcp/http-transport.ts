export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface DispatchedMessage<T> {
  notification: boolean;
  response: T;
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const message = value as Record<string, unknown>;
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return false;
  }

  if (
    Object.prototype.hasOwnProperty.call(message, "id") &&
    message.id !== null &&
    typeof message.id !== "string" &&
    typeof message.id !== "number"
  ) {
    return false;
  }

  if (!Object.prototype.hasOwnProperty.call(message, "params")) {
    return true;
  }

  return (
    message.params === null ||
    message.params === undefined ||
    typeof message.params === "object"
  );
}

export function isJsonRpcNotification(message: JsonRpcMessage): boolean {
  return !Object.prototype.hasOwnProperty.call(message, "id");
}

export function hasPositionalJsonRpcParams(message: JsonRpcMessage): boolean {
  return Array.isArray(message.params);
}

/**
 * Serialize dispatched JSON-RPC messages according to Streamable HTTP rules.
 * Messages without an id are notifications and must not receive a response.
 */
export function createJsonRpcHttpResponse<T>(
  dispatched: DispatchedMessage<T>[],
  batched: boolean
): Response {
  const responses = dispatched
    .filter(({ notification }) => !notification)
    .map(({ response }) => response);

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  return Response.json(batched ? responses : responses[0]);
}
