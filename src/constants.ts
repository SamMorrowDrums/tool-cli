/** Default port for the tool-cli JSON-RPC server. */
export const DEFAULT_PORT = 7179;

/** Environment variable to override the default port. */
export const PORT_ENV_VAR = "TOOL_CLI_PORT";

/** Resolve the port from environment or default. */
export function resolvePort(): number {
  const envPort = process.env[PORT_ENV_VAR];
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed < 65536) return parsed;
  }
  return DEFAULT_PORT;
}
