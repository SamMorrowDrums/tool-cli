import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolCliServer } from "./server.js";
import { rpcCall } from "./rpc-client.js";
import type { ToolProvider, ToolInfo, CallToolResult } from "./provider.js";
import { PORT_ENV_VAR, TOKEN_ENV_VAR } from "./constants.js";

/**
 * In-memory ToolProvider for testing.
 * Demonstrates the minimal interface an implementor needs to satisfy.
 */
class MockProvider implements ToolProvider {
  private servers = new Map<string, ToolInfo[]>();

  addServer(name: string, tools: ToolInfo[]) {
    this.servers.set(name, tools);
  }

  getServerNames(): string[] {
    return [...this.servers.keys()];
  }

  getTools(server: string): ToolInfo[] {
    return this.servers.get(server) ?? [];
  }

  async callTool(
    _server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    return {
      content: [{ type: "text", text: `Called ${tool}` }],
      structuredContent: { tool, args },
    };
  }
}

describe("tool-cli server + client integration", () => {
  const provider = new MockProvider();
  const server = new ToolCliServer(provider);
  let token: string;

  beforeAll(async () => {
    provider.addServer("test-server", [
      {
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string", description: "City name" } },
          required: ["city"],
        },
      },
      {
        name: "list_items",
        description: "List all items",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    ]);

    provider.addServer("empty-server", []);

    const result = await server.start();
    token = result.token;
    process.env[PORT_ENV_VAR] = String(result.port);
    process.env[TOKEN_ENV_VAR] = result.token;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env[PORT_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
  });

  describe("authentication", () => {
    it("rejects requests without a token", async () => {
      const port = server.getPort();
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "listServers", id: 1 }),
      });
      expect(res.status).toBe(401);
    });

    it("rejects requests with a wrong token", async () => {
      const port = server.getPort();
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer wrong-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "listServers", id: 1 }),
      });
      expect(res.status).toBe(401);
    });

    it("accepts requests with the correct token", async () => {
      const port = server.getPort();
      const res = await fetch(`http://127.0.0.1:${port}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "listServers", id: 1 }),
      });
      expect(res.status).toBe(200);
    });

    it("client sends token from TOOL_CLI_TOKEN env", async () => {
      // rpcCall reads TOOL_CLI_TOKEN from env (set in beforeAll)
      const result = (await rpcCall("listServers")) as { servers: unknown[] };
      expect(result.servers).toBeDefined();
    });
  });

  describe("start() returns port and token", () => {
    it("returns a valid port number", () => {
      const port = server.getPort();
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThan(65536);
    });

    it("returns a non-empty token", () => {
      expect(token).toBeTruthy();
      expect(token.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe("listServers", () => {
    it("returns all connected servers with tool counts", async () => {
      const result = (await rpcCall("listServers")) as {
        servers: { name: string; toolCount: number }[];
      };
      const names = result.servers.map((s) => s.name).sort();
      expect(names).toEqual(["empty-server", "test-server"]);

      const testServer = result.servers.find((s) => s.name === "test-server");
      expect(testServer?.toolCount).toBe(2);

      const emptyServer = result.servers.find((s) => s.name === "empty-server");
      expect(emptyServer?.toolCount).toBe(0);
    });
  });

  describe("listTools", () => {
    it("returns tools with descriptions for a server", async () => {
      const result = (await rpcCall("listTools", {
        server: "test-server",
      })) as {
        server: string;
        tools: {
          name: string;
          description: string;
          hasStructuredOutput: boolean;
        }[];
      };
      expect(result.server).toBe("test-server");
      expect(result.tools).toHaveLength(2);

      const weather = result.tools.find((t) => t.name === "get_weather");
      expect(weather?.description).toBe("Get weather for a city");
      expect(weather?.hasStructuredOutput).toBe(false);

      const items = result.tools.find((t) => t.name === "list_items");
      expect(items?.hasStructuredOutput).toBe(true);
    });

    it("returns empty list for server with no tools", async () => {
      const result = (await rpcCall("listTools", {
        server: "empty-server",
      })) as {
        tools: unknown[];
      };
      expect(result.tools).toHaveLength(0);
    });

    it("returns error for unknown server", async () => {
      await expect(rpcCall("listTools", { server: "nope" })).rejects.toThrow(
        /not found/i,
      );
    });
  });

  describe("describeTool", () => {
    it("returns full schema for a tool", async () => {
      const result = (await rpcCall("describeTool", {
        server: "test-server",
        tool: "get_weather",
      })) as {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
      };
      expect(result.name).toBe("get_weather");
      expect(result.description).toBe("Get weather for a city");
      expect(result.inputSchema).toHaveProperty("properties");
      expect(result.outputSchema).toBeUndefined();
    });

    it("includes outputSchema when present", async () => {
      const result = (await rpcCall("describeTool", {
        server: "test-server",
        tool: "list_items",
      })) as { outputSchema?: Record<string, unknown> };
      expect(result.outputSchema).toBeDefined();
      expect(result.outputSchema?.type).toBe("array");
    });

    it("returns error for unknown tool", async () => {
      await expect(
        rpcCall("describeTool", { server: "test-server", tool: "nope" }),
      ).rejects.toThrow(/not found/i);
    });
  });

  describe("callTool", () => {
    it("forwards arguments to provider and returns result", async () => {
      const result = (await rpcCall("callTool", {
        server: "test-server",
        tool: "get_weather",
        arguments: { city: "Tokyo" },
      })) as {
        content: unknown[];
        structuredContent?: Record<string, unknown>;
      };

      expect(result.content).toEqual([
        { type: "text", text: "Called get_weather" },
      ]);
      expect(result.structuredContent).toEqual({
        tool: "get_weather",
        args: { city: "Tokyo" },
      });
    });

    it("passes empty args when none provided", async () => {
      const result = (await rpcCall("callTool", {
        server: "test-server",
        tool: "list_items",
      })) as { structuredContent?: Record<string, unknown> };
      expect(result.structuredContent?.args).toEqual({});
    });
  });

  describe("JSON-RPC protocol", () => {
    it("returns method-not-found for unknown methods", async () => {
      await expect(rpcCall("nonExistentMethod")).rejects.toThrow(/not found/i);
    });

    it("returns invalid-params for missing required params", async () => {
      await expect(rpcCall("listTools", {})).rejects.toThrow(/missing/i);
    });
  });
});
