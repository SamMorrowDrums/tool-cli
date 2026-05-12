import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolCliServer } from "./server.js";
import { rpcCall } from "./rpc-client.js";
import type { ToolProvider, ToolInfo, CallToolResult } from "./provider.js";

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
    // Echo tool: return args as structured content
    return {
      content: [{ type: "text", text: `Called ${tool}` }],
      structuredContent: { tool, args },
    };
  }
}

describe("tool-cli server + client integration", () => {
  const provider = new MockProvider();
  const server = new ToolCliServer(provider, 0); // port 0 = OS-assigned
  let port: number;

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

    await server.start();
    port = server.getPort();
    process.env.TOOL_CLI_PORT = String(port);
  });

  afterAll(async () => {
    await server.stop();
    delete process.env.TOOL_CLI_PORT;
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
