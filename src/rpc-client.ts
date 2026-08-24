import {
  resolveHost,
  resolvePort,
  resolveTimeoutMs,
  resolveToken,
} from "./constants.js";
import {
  BRIDGE_PROTOCOL_MAJOR,
  BRIDGE_PROTOCOL_NAME,
  type BridgeInfo,
} from "./protocol.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

export interface RpcCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class RpcHttpError extends Error {
  readonly rpcCode?: number;
  readonly rpcData?: unknown;

  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly contentType: string | null,
    public readonly responseJson?: unknown,
  ) {
    const rpcError = getJsonRpcError(responseJson);
    const detail =
      rpcError?.message ??
      getErrorMessage(responseJson) ??
      summarizeBody(body) ??
      (statusText || "Request failed");
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ""}: ${detail}`);
    this.name = "RpcHttpError";
    this.rpcCode = rpcError?.code;
    this.rpcData = rpcError?.data;
  }
}

export class RpcProtocolError extends Error {
  constructor(
    public readonly code: number,
    message: string,
    public readonly data: unknown,
    public readonly id: number | string | null,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export class RpcNonJsonResponseError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly contentType: string | null,
    options?: ErrorOptions,
  ) {
    super(
      `Bridge returned a non-JSON response (HTTP ${status}${contentType ? `, ${contentType}` : ""}): ${summarizeBody(body) || "(empty body)"}`,
      options,
    );
    this.name = "RpcNonJsonResponseError";
  }
}

export class RpcInvalidResponseError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    public readonly responseJson: unknown,
  ) {
    super(message);
    this.name = "RpcInvalidResponseError";
  }
}

export class RpcTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RpcTransportError";
  }
}

export class RpcTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
    options?: ErrorOptions,
  ) {
    super(`Bridge request timed out after ${timeoutMs}ms`, options);
    this.name = "RpcTimeoutError";
  }
}

export class RpcAbortError extends Error {
  constructor(
    public readonly reason?: unknown,
    options?: ErrorOptions,
  ) {
    super("Bridge request cancelled", options);
    this.name = "RpcAbortError";
  }
}

export class BridgeCompatibilityError extends Error {
  constructor(
    message: string,
    public readonly bridgeInfo?: unknown,
  ) {
    super(message);
    this.name = "BridgeCompatibilityError";
  }
}

let requestId = 0;

/**
 * Send an authenticated JSON-RPC 2.0 request to the tool-cli bridge.
 *
 * The request always has a finite timeout. Callers may also supply an
 * AbortSignal; cancellation is forwarded to fetch and, for a compatible
 * bridge, to the provider operation.
 */
export async function rpcCall(
  method: string,
  params: Record<string, unknown> = {},
  options: RpcCallOptions = {},
): Promise<unknown> {
  const id = ++requestId;
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timeout.unref?.();

  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) {
    clearTimeout(timeout);
    throw new RpcAbortError(options.signal.reason);
  }
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(`http://${resolveHost()}:${resolvePort()}`, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
        id,
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    const contentType = response.headers.get("content-type");
    const parsed = tryParseJson(body);

    if (!response.ok) {
      throw new RpcHttpError(
        response.status,
        response.statusText,
        body,
        contentType,
        parsed,
      );
    }

    if (parsed === undefined) {
      throw new RpcNonJsonResponseError(response.status, body, contentType);
    }

    if (!isJsonRpcResponse(parsed)) {
      throw new RpcInvalidResponseError(
        "Bridge returned an invalid JSON-RPC response",
        response.status,
        body,
        parsed,
      );
    }

    if (parsed.id !== id) {
      throw new RpcInvalidResponseError(
        `Bridge returned JSON-RPC id ${JSON.stringify(parsed.id)} for request ${id}`,
        response.status,
        body,
        parsed,
      );
    }

    if (parsed.error) {
      throw new RpcProtocolError(
        parsed.error.code,
        parsed.error.message,
        parsed.error.data,
        parsed.id,
        response.status,
      );
    }

    if (!Object.prototype.hasOwnProperty.call(parsed, "result")) {
      throw new RpcInvalidResponseError(
        "Bridge JSON-RPC response has neither result nor error",
        response.status,
        body,
        parsed,
      );
    }

    return parsed.result;
  } catch (err) {
    if (
      err instanceof RpcHttpError ||
      err instanceof RpcProtocolError ||
      err instanceof RpcNonJsonResponseError ||
      err instanceof RpcInvalidResponseError
    ) {
      throw err;
    }
    if (timedOut) {
      throw new RpcTimeoutError(timeoutMs, { cause: err });
    }
    if (options.signal?.aborted) {
      throw new RpcAbortError(options.signal.reason, { cause: err });
    }
    throw new RpcTransportError(
      err instanceof Error ? err.message : String(err),
      { cause: err },
    );
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

/** Perform the authenticated protocol handshake and reject incompatible bridges. */
export async function getBridgeInfo(
  options: RpcCallOptions = {},
): Promise<BridgeInfo> {
  const result = await rpcCall("getBridgeInfo", {}, options);
  assertCompatibleBridge(result);
  return result;
}

export function assertCompatibleBridge(
  value: unknown,
): asserts value is BridgeInfo {
  if (!isRecord(value) || !isRecord(value.bridgeProtocol)) {
    throw new BridgeCompatibilityError(
      "Bridge handshake did not return bridgeProtocol metadata",
      value,
    );
  }

  const protocol = value.bridgeProtocol;
  if (
    protocol.name !== BRIDGE_PROTOCOL_NAME ||
    protocol.major !== BRIDGE_PROTOCOL_MAJOR
  ) {
    throw new BridgeCompatibilityError(
      `Incompatible bridge protocol: expected ${BRIDGE_PROTOCOL_NAME} major ${BRIDGE_PROTOCOL_MAJOR}, received ${String(protocol.name)} major ${String(protocol.major)}`,
      value,
    );
  }
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const token = resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function tryParseJson(body: string): unknown | undefined {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
  if (
    typeof value.id !== "number" &&
    typeof value.id !== "string" &&
    value.id !== null
  ) {
    return false;
  }

  if (value.error !== undefined) {
    const error = value.error;
    if (
      !isRecord(error) ||
      typeof error.code !== "number" ||
      typeof error.message !== "string"
    ) {
      return false;
    }
  }
  return true;
}

function getJsonRpcError(
  value: unknown,
): { code: number; message: string; data?: unknown } | undefined {
  if (!isRecord(value) || !isRecord(value.error)) return undefined;
  const error = value.error;
  if (typeof error.code !== "number" || typeof error.message !== "string") {
    return undefined;
  }
  return {
    code: error.code,
    message: error.message,
    ...(error.data === undefined ? {} : { data: error.data }),
  };
}

function getErrorMessage(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.error === "string" ? value.error : undefined;
}

function summarizeBody(body: string): string | undefined {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= 500
    ? normalized
    : `${normalized.slice(0, 500)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
