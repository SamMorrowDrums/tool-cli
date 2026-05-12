import { randomBytes } from "node:crypto";

/** Default port for the tool-cli JSON-RPC server. */
export const DEFAULT_PORT = 7179;

/** Environment variable to override the default port. */
export const PORT_ENV_VAR = "TOOL_CLI_PORT";

/** Environment variable for the shared auth token. */
export const TOKEN_ENV_VAR = "TOOL_CLI_TOKEN";

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

/** Generate a random session token. */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}
