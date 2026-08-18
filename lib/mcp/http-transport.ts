interface DispatchedMessage<T> {
  message: object;
  response: T;
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
    .filter(({ message }) => Object.prototype.hasOwnProperty.call(message, "id"))
    .map(({ response }) => response);

  if (responses.length === 0) {
    return new Response(null, { status: 202 });
  }

  return Response.json(batched ? responses : responses[0]);
}
