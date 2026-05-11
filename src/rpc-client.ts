import { resolvePort } from "./constants.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

/**
 * Send a JSON-RPC 2.0 request to the tool-cli RPC server.
 * Throws on network errors and JSON-RPC error responses.
 */
export async function rpcCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const port = resolvePort();
  const url = `http://127.0.0.1:${port}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    }),
  });

  const json = (await response.json()) as JsonRpcResponse;

  if (json.error) {
    throw new Error(json.error.message);
  }

  return json.result;
}
