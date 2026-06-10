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

/** A concrete MCP resource (faithful mapping of `resources/list`). */
export interface ResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** An MCP resource template (faithful mapping of `resources/templates/list`). */
export interface ResourceTemplateInfo {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A single content block returned from reading a resource. */
export interface ReadResourceContent {
  uri: string;
  mimeType?: string;
  /** UTF-8 text content, when the resource is textual. */
  text?: string;
  /** Base64-encoded binary content, when the resource is binary. */
  blob?: string;
}

/** Result of reading a resource (faithful mapping of `resources/read`). */
export interface ReadResourceResult {
  contents: ReadResourceContent[];
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

  /**
   * List concrete resources for a server (MCP `resources/list`).
   *
   * Optional — providers that do not support resources simply omit it,
   * keeping tools-only implementations fully backward-compatible.
   */
  listResources?(server: string): Promise<ResourceInfo[]>;

  /**
   * List resource templates for a server (MCP `resources/templates/list`).
   *
   * Optional — see {@link ToolProvider.listResources}.
   */
  listResourceTemplates?(server: string): Promise<ResourceTemplateInfo[]>;

  /**
   * Read a resource by URI for a server (MCP `resources/read`).
   *
   * Optional — see {@link ToolProvider.listResources}.
   */
  readResource?(server: string, uri: string): Promise<ReadResourceResult>;
}
