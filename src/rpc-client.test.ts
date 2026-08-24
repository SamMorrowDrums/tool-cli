import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { PORT_ENV_VAR, TOKEN_ENV_VAR } from "./constants.js";
import type {
  CallToolResult,
  ProviderRequestContext,
  ToolInfo,
  ToolProvider,
} from "./provider.js";
import {
  BridgeCompatibilityError,
  RpcAbortError,
  RpcHttpError,
  RpcNonJsonResponseError,
  RpcProtocolError,
  RpcTimeoutError,
  assertCompatibleBridge,
  rpcCall,
} from "./rpc-client.js";
import { ToolCliServer } from "./server.js";

const activeServers: http.Server[] = [];
const previousPort = process.env[PORT_ENV_VAR];
const previousToken = process.env[TOKEN_ENV_VAR];

afterEach(async () => {
  for (const server of activeServers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  restoreEnv(PORT_ENV_VAR, previousPort);
  restoreEnv(TOKEN_ENV_VAR, previousToken);
});

describe("rpcCall typed failures", () => {
  it("preserves JSON-RPC code and data", async () => {
    await startRawServer(async (req, res) => {
      const body = await readJsonRequest(req);
      sendJson(res, 200, {
        jsonrpc: "2.0",
        error: {
          code: -32602,
          message: "Schema rejected",
          data: { instancePath: "/city", keyword: "type" },
        },
        id: body.id,
      });
    });

    await expect(rpcCall("callTool")).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RpcProtocolError &&
        err.code === -32602 &&
        err.httpStatus === 200 &&
        JSON.stringify(err.data) ===
          JSON.stringify({ instancePath: "/city", keyword: "type" })
      );
    });
  });

  it("preserves HTTP status, body, and nested JSON-RPC metadata", async () => {
    await startRawServer(async (req, res) => {
      const body = await readJsonRequest(req);
      sendJson(
        res,
        429,
        {
          jsonrpc: "2.0",
          error: {
            code: -32029,
            message: "Rate limited",
            data: { retryAfterMs: 2500 },
          },
          id: body.id,
        },
        "Too Many Requests",
      );
    });

    await expect(rpcCall("callTool")).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RpcHttpError &&
        err.status === 429 &&
        err.rpcCode === -32029 &&
        JSON.stringify(err.rpcData) ===
          JSON.stringify({ retryAfterMs: 2500 }) &&
        err.body.includes("Rate limited")
      );
    });
  });

  it("preserves non-JSON success responses", async () => {
    await startRawServer(async (req, res) => {
      await readJsonRequest(req);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("upstream bridge warming up");
    });

    await expect(rpcCall("listServers")).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof RpcNonJsonResponseError &&
        err.status === 200 &&
        err.contentType === "text/plain" &&
        err.body === "upstream bridge warming up"
      );
    });
  });

  it("aborts at the configured finite timeout", async () => {
    await startRawServer(async (req) => {
      await readJsonRequest(req);
    });

    await expect(
      rpcCall("listServers", {}, { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: "RpcTimeoutError",
      timeoutMs: 20,
    } satisfies Partial<RpcTimeoutError>);
  });

  it("supports caller cancellation with an AbortSignal", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    await startRawServer(async (req) => {
      await readJsonRequest(req);
      requestStarted();
    });

    const controller = new AbortController();
    const pending = rpcCall("listServers", {}, { signal: controller.signal });
    await started;
    controller.abort("test cancellation");

    await expect(pending).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RpcAbortError && err.reason === "test cancellation",
    );
  });
});

describe("bridge compatibility", () => {
  it("rejects a different bridge protocol major", () => {
    expect(() =>
      assertCompatibleBridge({
        bridgeProtocol: {
          name: "tool-cli-bridge",
          major: 2,
          version: "2.0",
        },
      }),
    ).toThrow(BridgeCompatibilityError);
  });
});

describe("provider cancellation propagation", () => {
  it("aborts the provider operation when the client disconnects", async () => {
    let callStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    let abortObserved!: () => void;
    const observed = new Promise<void>((resolve) => {
      abortObserved = resolve;
    });

    class AbortProvider implements ToolProvider {
      getServerNames(): string[] {
        return ["slow"];
      }
      getTools(): ToolInfo[] {
        return [
          {
            name: "wait",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
          },
        ];
      }
      callTool(
        _server: string,
        _tool: string,
        _args: Record<string, unknown>,
        context?: ProviderRequestContext,
      ): Promise<CallToolResult> {
        callStarted();
        return new Promise((resolve) => {
          const finish = () => {
            abortObserved();
            resolve({ content: [], isError: true });
          };
          if (context?.signal.aborted) finish();
          else
            context?.signal.addEventListener("abort", finish, { once: true });
        });
      }
    }

    const server = new ToolCliServer(new AbortProvider());
    const { port, token } = await server.start();
    process.env[PORT_ENV_VAR] = String(port);
    process.env[TOKEN_ENV_VAR] = token;
    const controller = new AbortController();

    try {
      const pending = rpcCall(
        "callTool",
        { server: "slow", tool: "wait", arguments: {} },
        { signal: controller.signal },
      );
      await started;
      controller.abort();
      await expect(pending).rejects.toBeInstanceOf(RpcAbortError);
      await observed;
    } finally {
      await server.stop();
    }
  });
});

async function startRawServer(
  handler: (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => Promise<void>,
): Promise<void> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  activeServers.push(server);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Raw test server did not bind to a TCP port");
  }
  process.env[PORT_ENV_VAR] = String(address.port);
  process.env[TOKEN_ENV_VAR] = "test-token";
}

async function readJsonRequest(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
    string,
    unknown
  >;
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  statusMessage?: string,
): void {
  res.writeHead(status, statusMessage, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
