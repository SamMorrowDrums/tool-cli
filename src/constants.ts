import { randomBytes } from "node:crypto";

/** Default port for the tool-cli JSON-RPC server. */
export const DEFAULT_PORT = 7179;

/** Environment variable to override the default port. */
export const PORT_ENV_VAR = "TOOL_CLI_PORT";

/** Environment variable for the shared auth token. */
export const TOKEN_ENV_VAR = "TOOL_CLI_TOKEN";

/** Default finite timeout for bridge requests. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum configurable timeout for bridge requests. */
export const MAX_TIMEOUT_MS = 300_000;

/** Environment variable that overrides the bridge request timeout. */
export const TIMEOUT_ENV_VAR = "TOOL_CLI_TIMEOUT_MS";

/** Default loopback host for both bind and client target. */
export const DEFAULT_HOST = "127.0.0.1";

/** Environment variable to override the server bind host. */
export const BIND_HOST_ENV_VAR = "TOOL_CLI_BIND_HOST";

/** Environment variable to override the client target host. */
export const HOST_ENV_VAR = "TOOL_CLI_HOST";

/** Resolve the port from environment or default. */
export function resolvePort(): number {
  const envPort = process.env[PORT_ENV_VAR];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}

/** Resolve the token from environment, or undefined if not set. */
export function resolveToken(): string | undefined {
  return process.env[TOKEN_ENV_VAR] || undefined;
}

/** Resolve and bound the bridge request timeout. */
export function resolveTimeoutMs(explicit?: number): number {
  if (explicit !== undefined) {
    if (
      !Number.isInteger(explicit) ||
      explicit <= 0 ||
      explicit > MAX_TIMEOUT_MS
    ) {
      throw new RangeError(
        `timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`,
      );
    }
    return explicit;
  }

  const configured = process.env[TIMEOUT_ENV_VAR];
  if (!configured) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(configured);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Resolve the host the server should bind to. Defaults to `127.0.0.1`.
 *
 * Override with `TOOL_CLI_BIND_HOST` for sandboxed setups where the
 * client lives in a different network namespace (e.g. a docker
 * container reaching a server on the host) — in that case set the
 * server to bind on `0.0.0.0` or a specific interface.
 *
 * Note: binding to a non-loopback interface exposes the server beyond
 * the local machine. The bearer-token check still applies, but the
 * caller is responsible for ensuring the network is appropriately
 * sandboxed.
 */
export function resolveBindHost(): string {
  return process.env[BIND_HOST_ENV_VAR] || DEFAULT_HOST;
}

/**
 * Resolve the host the client should connect to. Defaults to `127.0.0.1`.
 *
 * Override with `TOOL_CLI_HOST` when the server is reachable at a
 * different address than localhost (e.g. `host.docker.internal` from
 * inside a docker container).
 */
export function resolveHost(): string {
  return process.env[HOST_ENV_VAR] || DEFAULT_HOST;
}

/** Generate a random session token. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}
