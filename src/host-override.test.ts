import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolCliServer } from "./server.js";
import { rpcCall } from "./rpc-client.js";
import type { ToolProvider, ToolInfo, CallToolResult } from "./provider.js";
import {
  BIND_HOST_ENV_VAR,
  HOST_ENV_VAR,
  PORT_ENV_VAR,
  TOKEN_ENV_VAR,
} from "./constants.js";

class EmptyProvider implements ToolProvider {
  getServerNames(): string[] {
    return [];
  }
  getTools(_server: string): ToolInfo[] {
    return [];
  }
  async callTool(): Promise<CallToolResult> {
    return { content: [] };
  }
}

describe("TOOL_CLI_BIND_HOST / TOOL_CLI_HOST overrides", () => {
  const provider = new EmptyProvider();
  const server = new ToolCliServer(provider);
  const prevBind = process.env[BIND_HOST_ENV_VAR];
  const prevHost = process.env[HOST_ENV_VAR];
  const prevPort = process.env[PORT_ENV_VAR];
  const prevToken = process.env[TOKEN_ENV_VAR];

  beforeAll(async () => {
    process.env[BIND_HOST_ENV_VAR] = "0.0.0.0";
    const result = await server.start();
    process.env[PORT_ENV_VAR] = String(result.port);
    process.env[TOKEN_ENV_VAR] = result.token;
    // Client points at loopback; with bind=0.0.0.0 the server is reachable here.
    process.env[HOST_ENV_VAR] = "127.0.0.1";
  });

  afterAll(async () => {
    await server.stop();
    restore(BIND_HOST_ENV_VAR, prevBind);
    restore(HOST_ENV_VAR, prevHost);
    restore(PORT_ENV_VAR, prevPort);
    restore(TOKEN_ENV_VAR, prevToken);
  });

  it("server bound on 0.0.0.0 is reachable from rpcCall via TOOL_CLI_HOST", async () => {
    const result = (await rpcCall("listServers")) as { servers: unknown[] };
    expect(result.servers).toEqual([]);
  });

  it("server bound on 0.0.0.0 advertises the override in its log", async () => {
    const altServer = new ToolCliServer(provider);
    const messages: string[] = [];
    const result = await altServer.start((msg) => messages.push(msg));
    try {
      expect(result.port).toBeGreaterThan(0);
      expect(messages.some((m) => m.includes("0.0.0.0"))).toBe(true);
    } finally {
      await altServer.stop();
    }
  });
});

function restore(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}
