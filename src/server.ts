import http from "node:http";
import { generateToken } from "./constants.js";
import type { ToolProvider, ToolInfo } from "./provider.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number | string | null;
}

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

    const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

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

      req.on("error", () => {
        aborted = true;
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
        void this.handleBody(body)
          .then((response) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          })
          .catch(() => {
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
      server.listen(0, "127.0.0.1", () => {
        this.server = server;
        const port = this.getPort();
        log?.(`[tool-cli] RPC server listening on 127.0.0.1:${port}`);
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

  private async handleBody(body: string): Promise<JsonRpcResponse> {
    let parsed: JsonRpcRequest;
    try {
      parsed = JSON.parse(body) as JsonRpcRequest;
    } catch {
      return rpcError(null, -32700, "Parse error");
    }

    if (parsed.jsonrpc !== "2.0" || !parsed.method) {
      return rpcError(parsed.id ?? null, -32600, "Invalid Request");
    }

    try {
      const result = await this.dispatch(parsed.method, parsed.params ?? {});
      return { jsonrpc: "2.0", result, id: parsed.id ?? null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = err instanceof RpcMethodError ? err.code : -32603;
      return rpcError(parsed.id ?? null, code, message);
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "listServers":
        return this.listServers();
      case "listTools":
        return this.listTools(params);
      case "describeTool":
        return this.describeTool(params);
      case "callTool":
        return this.callTool(params);
      default:
        throw new RpcMethodError(-32601, `Method not found: ${method}`);
    }
  }

  private listServers(): { servers: ServerInfo[] } {
    const serverNames = this.provider.getServerNames();
    const servers: ServerInfo[] = serverNames.map((name) => {
      const tools = this.provider.getTools(name);
      return {
        name,
        toolCount: tools.length,
        examples: pickRandomExamples(tools, 3),
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
    const tools = this.provider.getTools(server);
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

    const tool = this.provider
      .getTools(server)
      .find((t) => t.name === toolName);
    if (!tool) {
      throw new RpcMethodError(
        -32602,
        `Tool "${toolName}" not found on server "${server}"`,
      );
    }

    return {
      name: tool.name,
      description: tool.description ?? "(no description)",
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    };
  }

  private async callTool(params: Record<string, unknown>): Promise<{
    content: unknown[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }> {
    const server = requireString(params, "server");
    const toolName = requireString(params, "tool");
    this.assertServerExists(server);

    const toolArgs = (params.arguments as Record<string, unknown>) ?? {};
    return this.provider.callTool(server, toolName, toolArgs);
  }

  private assertServerExists(server: string): void {
    if (!this.provider.getServerNames().includes(server)) {
      throw new RpcMethodError(
        -32602,
        `Server "${server}" not found. Connected: ${this.provider.getServerNames().join(", ") || "(none)"}`,
      );
    }
  }
}

class RpcMethodError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcMethodError";
  }
}

function rpcError(
  id: number | string | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

function requireString(params: Record<string, unknown>, key: string): string {
  const val = params[key];
  if (typeof val !== "string" || val.length === 0) {
    throw new RpcMethodError(
      -32602,
      `Missing or invalid parameter: "${key}" (string required)`,
    );
  }
  return val;
}

function pickRandomExamples(tools: ToolInfo[], n: number): string[] {
  if (tools.length <= n) return tools.map((t) => t.name);
  const shuffled = [...tools].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n).map((t) => t.name);
}
