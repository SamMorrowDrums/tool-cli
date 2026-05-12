import { resolvePort, resolveToken } from "./constants.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

/**
 * Send a JSON-RPC 2.0 request to the tool-cli RPC server.
 * Sends auth token via Authorization header if TOOL_CLI_TOKEN is set.
 * Throws on network errors and JSON-RPC error responses.
 */
export async function rpcCall(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const port = resolvePort();
  const url = `http://127.0.0.1:${port}`;
  const token = resolveToken();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: 1,
    }),
  });

  if (response.status === 401) {
    throw new Error("Authentication failed: invalid or missing TOOL_CLI_TOKEN");
  }

  const json = (await response.json()) as JsonRpcResponse;

  if (json.error) {
    throw new Error(json.error.message);
  }

  return json.result;
}
