/** Minimal tool metadata needed by the RPC server. */
export interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

/** Result of calling a tool. */
export interface CallToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Provider interface for the tool-cli RPC server.
 *
 * Implement this to bridge tool-cli to any MCP client, agent harness,
 * or tool registry. The RPC server delegates all operations to this interface.
 */
export interface ToolProvider {
  /** List connected server names. */
  getServerNames(): string[];

  /** Get tools for a specific server. */
  getTools(server: string): ToolInfo[];

  /** Call a tool on a server with the given arguments. */
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}
