import http from "node:http";
import { Ajv } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import formatsModule from "ajv-formats";
import { generateToken, resolveBindHost } from "./constants.js";
import type {
  CallToolResult,
  ToolProvider,
  ToolInfo,
  ResourceInfo,
  ResourceTemplateInfo,
  ReadResourceResult,
} from "./provider.js";
import {
  BRIDGE_PROTOCOL_MAJOR,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_OPERATIONS,
  SERVER_IMPLEMENTATION_NAME,
  SERVER_IMPLEMENTATION_VERSION,
  type BridgeInfo,
} from "./protocol.js";

const MAX_BODY_SIZE = 1024 * 1024;
const ajvOptions = {
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
} as const;
const ajvDraft7 = new Ajv(ajvOptions);
const ajvDraft2019 = new Ajv2019(ajvOptions);
const ajvDraft2020 = new Ajv2020(ajvOptions);
const addFormats = formatsModule.default;
addFormats(ajvDraft7);
addFormats(ajvDraft2019);
addFormats(ajvDraft2020);

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string | null;
}

export interface ServerInfo {
  name: string;
  toolCount: number;
  examples: string[];
}

export interface ToolSummary {
  name: string;
  description: string;
  hasStructuredOutput: boolean;
}

export interface ToolDetails {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Result returned from `start()` — pass these to the agent as env vars. */
export interface StartResult {
  port: number;
  token: string;
}

/**
 * JSON-RPC 2.0 server for progressive MCP tool discovery.
 *
 * Takes a `ToolProvider` — any implementation that can list servers,
 * list tools, describe tools, and call tools.
 *
 * On `start()`, picks a random available port and generates a session
 * token. Both are returned so the caller can set `TOOL_CLI_PORT` and
 * `TOOL_CLI_TOKEN` as environment variables for agent subprocesses.
 */
export class ToolCliServer {
  private server: http.Server | null = null;
  private token: string = "";

  constructor(private provider: ToolProvider) {}

  /** Start the HTTP server on a random port. Returns `{ port, token }`. */
  async start(log?: (msg: string) => void): Promise<StartResult> {
    if (this.server) {
      return { port: this.getPort(), token: this.token };
    }

    this.token = generateToken();

    const server = http.createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify(rpcError(null, -32600, "Only POST accepted")));
        return;
      }

      // Validate auth token
      const auth = req.headers["authorization"];
      if (!auth || auth !== `Bearer ${this.token}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      let body = "";
      let aborted = false;
      const requestController = new AbortController();

      const abortRequest = () => {
        if (!requestController.signal.aborted) {
          requestController.abort(new Error("Bridge client disconnected"));
        }
      };

      req.on("error", () => {
        aborted = true;
        abortRequest();
      });
      req.on("aborted", abortRequest);
      res.on("close", () => {
        if (!res.writableEnded) abortRequest();
      });

      req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        body += chunk.toString();
        if (body.length > MAX_BODY_SIZE) {
          aborted = true;
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify(rpcError(null, -32600, "Request too large")));
          req.destroy();
        }
      });

      req.on("end", () => {
        if (aborted) return;
        void this.handleBody(body, requestController.signal)
          .then((response) => {
            if (requestController.signal.aborted || res.destroyed) return;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch(() => {
            if (requestController.signal.aborted || res.destroyed) return;
            try {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify(rpcError(null, -32603, "Internal error")));
            } catch {
              res.end();
            }
          });
      });
    });

    return new Promise<StartResult>((resolve, reject) => {
      server.once("error", (err) => {
        this.server = null;
        reject(err);
      });
      const bindHost = resolveBindHost();
      server.listen(0, bindHost, () => {
        this.server = server;
        const port = this.getPort();
        log?.(`[tool-cli] RPC server listening on ${bindHost}:${port}`);
        resolve({ port, token: this.token });
      });
    });
  }

  /** Stop the HTTP server. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;

    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  /** Returns the port the server is listening on. */
  getPort(): number {
    if (this.server) {
      const addr = this.server.address();
      if (addr && typeof addr === "object") return addr.port;
    }
    return 0;
  }

  private async handleBody(
    body: string,
    signal: AbortSignal,
  ): Promise<JsonRpcResponse> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      return rpcError(null, -32700, "Parse error");
    }

    if (
      !isRecord(parsed) ||
      parsed.jsonrpc !== "2.0" ||
      typeof parsed.method !== "string" ||
      parsed.method.length === 0 ||
      !isValidRpcId(parsed.id)
    ) {
      return rpcError(getResponseId(parsed), -32600, "Invalid Request");
    }

    const params = parsed.params === undefined ? {} : parsed.params;
    if (!isRecord(params)) {
      return rpcError(
        parsed.id ?? null,
        -32602,
        "Invalid params: named object required",
      );
    }

    try {
      const result = await this.dispatch(parsed.method, params, signal);
      return { jsonrpc: "2.0", result, id: parsed.id ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof BridgeRpcError ? err.code : -32603;
      const data = err instanceof BridgeRpcError ? err.data : undefined;
      return rpcError(parsed.id ?? null, code, message, data);
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (signal.aborted) {
      throw new BridgeRpcError(-32000, "Request cancelled");
    }

    switch (method) {
      case "getBridgeInfo":
        return this.getBridgeInfo();
      case "listServers":
        return this.listServers();
      case "listTools":
        return this.listTools(params);
      case "describeTool":
        return this.describeTool(params);
      case "callTool":
        return this.callTool(params, signal);
      case "listResources":
        return this.listResources(params, signal);
      case "listResourceTemplates":
        return this.listResourceTemplates(params, signal);
      case "readResource":
        return this.readResource(params, signal);
      default:
        throw new BridgeRpcError(-32601, `Method not found: ${method}`);
    }
  }

  private getBridgeInfo(): BridgeInfo {
    const upstreamMcp = this.provider.getUpstreamMcpSummary?.();
    return {
      bridgeProtocol: {
        name: BRIDGE_PROTOCOL_NAME,
        major: BRIDGE_PROTOCOL_MAJOR,
        version: BRIDGE_PROTOCOL_VERSION,
      },
      serverImplementation: {
        name: SERVER_IMPLEMENTATION_NAME,
        version: SERVER_IMPLEMENTATION_VERSION,
      },
      operations: [...BRIDGE_RPC_OPERATIONS],
      capabilities: {
        authentication: {
          required: true,
          scheme: "bearer",
        },
        tools: {
          discovery: true,
          calls: true,
          inputSchemaValidation: true,
          jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
          supportedJsonSchemaDialects: [
            "https://json-schema.org/draft/2020-12/schema",
            "https://json-schema.org/draft/2019-09/schema",
            "http://json-schema.org/draft-07/schema#",
          ],
        },
        resources: {
          list: typeof this.provider.listResources === "function",
          templates: typeof this.provider.listResourceTemplates === "function",
          read: typeof this.provider.readResource === "function",
        },
        cancellation: {
          providerAbortSignal: true,
        },
      },
      ...(upstreamMcp ? { upstreamMcp } : {}),
    };
  }

  private listServers(): { servers: ServerInfo[] } {
    const serverNames = [...this.provider.getServerNames()].sort(compareNames);
    const servers: ServerInfo[] = serverNames.map((name) => {
      const tools = [...this.provider.getTools(name)].sort(compareTools);
      return {
        name,
        toolCount: tools.length,
        examples: tools.slice(0, 3).map((tool) => tool.name),
      };
    });
    return { servers };
  }

  private listTools(params: Record<string, unknown>): {
    server: string;
    tools: ToolSummary[];
  } {
    const server = requireString(params, "server");
    this.assertServerExists(server);
    const tools = [...this.provider.getTools(server)].sort(compareTools);
    return {
      server,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "(no description)",
        hasStructuredOutput: t.outputSchema != null,
      })),
    };
  }

  private describeTool(params: Record<string, unknown>): ToolDetails {
    const server = requireString(params, "server");
    const toolName = requireString(params, "tool");
    this.assertServerExists(server);

    const tool = this.getTool(server, toolName);

    return {
      ...tool,
      name: tool.name,
      description: tool.description ?? "(no description)",
      inputSchema: tool.inputSchema,
    };
  }

  private async callTool(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<CallToolResult> {
    const server = requireString(params, "server");
    const toolName = requireString(params, "tool");
    this.assertServerExists(server);
    const tool = this.getTool(server, toolName);

    const rawArguments = Object.prototype.hasOwnProperty.call(
      params,
      "arguments",
    )
      ? params.arguments
      : {};
    if (!isRecord(rawArguments)) {
      throw new BridgeRpcError(
        -32602,
        `Invalid arguments for "${server}/${toolName}": an object is required`,
        { server, tool: toolName, validationErrors: [] },
      );
    }

    let validate;
    try {
      validate = compileInputSchema(tool.inputSchema);
    } catch (err) {
      throw new BridgeRpcError(
        -32603,
        `Tool "${toolName}" on server "${server}" has an invalid input schema`,
        {
          server,
          tool: toolName,
          schemaError: err instanceof Error ? err.message : String(err),
        },
      );
    }

    if (!validate(rawArguments)) {
      throw new BridgeRpcError(
        -32602,
        `Arguments do not match the input schema for "${server}/${toolName}"`,
        {
          server,
          tool: toolName,
          validationErrors: validate.errors ?? [],
        },
      );
    }

    return this.provider.callTool(server, toolName, rawArguments, { signal });
  }

  private async listResources(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ server: string; resources: ResourceInfo[] }> {
    const server = requireString(params, "server");
    this.assertServerExists(server);
    this.assertResourcesSupported(server);
    const resources = await this.provider.listResources!(server, { signal });
    return {
      server,
      resources: [...resources].sort((a, b) => compareNames(a.uri, b.uri)),
    };
  }

  private async listResourceTemplates(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ server: string; templates: ResourceTemplateInfo[] }> {
    const server = requireString(params, "server");
    this.assertServerExists(server);
    this.assertTemplatesSupported(server);
    const templates = await this.provider.listResourceTemplates!(server, {
      signal,
    });
    return {
      server,
      templates: [...templates].sort((a, b) =>
        compareNames(a.uriTemplate, b.uriTemplate),
      ),
    };
  }

  private async readResource(
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ReadResourceResult> {
    const server = requireString(params, "server");
    const uri = requireString(params, "uri");
    this.assertServerExists(server);
    this.assertReadSupported(server);
    return this.provider.readResource!(server, uri, { signal });
  }

  private assertServerExists(server: string): void {
    const serverNames = this.provider.getServerNames();
    if (!serverNames.includes(server)) {
      throw new BridgeRpcError(
        -32602,
        `Server "${server}" not found. Connected: ${[...serverNames].sort(compareNames).join(", ") || "(none)"}`,
      );
    }
  }

  private getTool(server: string, toolName: string): ToolInfo {
    const tools = this.provider.getTools(server);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new BridgeRpcError(
        -32602,
        `Tool "${toolName}" not found on server "${server}"`,
        {
          server,
          tool: toolName,
          discoveredTools: tools
            .map((candidate) => candidate.name)
            .sort(compareNames),
        },
      );
    }
    return tool;
  }

  private assertResourcesSupported(server: string): void {
    if (typeof this.provider.listResources !== "function") {
      throw new BridgeRpcError(
        -32601,
        `Server "${server}": this provider does not support resources (listResources not implemented)`,
      );
    }
  }

  private assertTemplatesSupported(server: string): void {
    if (typeof this.provider.listResourceTemplates !== "function") {
      throw new BridgeRpcError(
        -32601,
        `Server "${server}": this provider does not support resource templates (listResourceTemplates not implemented)`,
      );
    }
  }

  private assertReadSupported(server: string): void {
    if (typeof this.provider.readResource !== "function") {
      throw new BridgeRpcError(
        -32601,
        `Server "${server}": this provider does not support resources (readResource not implemented)`,
      );
    }
  }
}

export class BridgeRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message);
    this.name = "BridgeRpcError";
  }
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    error: {
      code,
      message,
      ...(data === undefined ? {} : { data }),
    },
    id,
  };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new BridgeRpcError(
      -32602,
      `Missing or invalid parameter: "${key}" (string required)`,
    );
  }
  return val;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareTools(a: ToolInfo, b: ToolInfo): number {
  return compareNames(a.name, b.name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidRpcId(
  value: unknown,
): value is number | string | null | undefined {
  return (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number"
  );
}

function getResponseId(value: unknown): number | string | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  return typeof id === "string" || typeof id === "number" || id === null
    ? id
    : null;
}

function compileInputSchema(schema: Record<string, unknown>) {
  const dialect = typeof schema.$schema === "string" ? schema.$schema : "";
  if (dialect.includes("draft-07")) return ajvDraft7.compile(schema);
  if (dialect.includes("2019-09")) return ajvDraft2019.compile(schema);
  return ajvDraft2020.compile(schema);
}
