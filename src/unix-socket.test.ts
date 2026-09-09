import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BIND_HOST_ENV_VAR,
  HOST_ENV_VAR,
  PORT_ENV_VAR,
  SOCKET_ENV_VAR,
  TOKEN_ENV_VAR,
} from "./constants.js";
import type {
  CallToolResult,
  ProviderRequestContext,
  ReadResourceResult,
  ResourceInfo,
  ResourceTemplateInfo,
  ToolInfo,
  ToolProvider,
} from "./provider.js";
import {
  RpcAbortError,
  RpcTimeoutError,
  RpcTransportError,
  getBridgeInfo,
  rpcCall,
} from "./rpc-client.js";
import { ToolCliServer, type StartResult } from "./server.js";
import { UnixSocketPathError } from "./unix-socket.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SERVER_ENTRY_URL = new URL("../dist/server-entry.js", import.meta.url)
  .href;
const UNIX_SOCKET_MODULE_URL = new URL(
  "../dist/unix-socket.js",
  import.meta.url,
).href;
const BINARY_BYTES = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x10]);
const BINARY_B64 = BINARY_BYTES.toString("base64");
const trackedServers = new Set<ToolCliServer>();
const trackedHttpServers = new Set<http.Server>();
const trackedDirectories = new Set<string>();
const bridgeEnvVars = [
  BIND_HOST_ENV_VAR,
  HOST_ENV_VAR,
  PORT_ENV_VAR,
  SOCKET_ENV_VAR,
  TOKEN_ENV_VAR,
] as const;
const originalBridgeEnv = new Map(
  bridgeEnvVars.map((key) => [key, process.env[key]]),
);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

class UdsProvider implements ToolProvider {
  readonly waitStarted = deferred<void>();
  readonly waitAborted = deferred<void>();

  constructor(private readonly serverName = "uds") {}

  getServerNames(): string[] {
    return [this.serverName];
  }

  getTools(): ToolInfo[] {
    return [
      {
        name: "echo",
        description: "Echo a value",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
        annotations: { readOnlyHint: true },
        customMetadata: { transportTest: true },
      },
      {
        name: "wait",
        description: "Wait for cancellation",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
  }

  async callTool(
    _server: string,
    tool: string,
    args: Record<string, unknown>,
    context?: ProviderRequestContext,
  ): Promise<CallToolResult> {
    if (tool === "wait") {
      this.waitStarted.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          this.waitAborted.resolve();
          resolve({ content: [], isError: true });
        };
        if (context?.signal.aborted) finish();
        else context?.signal.addEventListener("abort", finish, { once: true });
      });
    }

    return {
      content: [{ type: "text", text: String(args.value) }],
      structuredContent: {
        value: args.value,
        server: this.serverName,
      },
      extensionData: { exact: true },
    };
  }

  async listResources(): Promise<ResourceInfo[]> {
    return [
      {
        uri: "asset://fixture.bin",
        name: "Fixture",
        mimeType: "application/octet-stream",
        extensionData: { exact: true },
      },
    ];
  }

  async listResourceTemplates(): Promise<ResourceTemplateInfo[]> {
    return [
      {
        uriTemplate: "asset://{name}",
        name: "Asset",
        extensionData: { exact: true },
      },
    ];
  }

  async readResource(
    _server: string,
    uri: string,
  ): Promise<ReadResourceResult> {
    return {
      contents: [
        {
          uri,
          mimeType: "application/octet-stream",
          blob: BINARY_B64,
          extensionData: { exact: true },
        },
      ],
      extensionData: { exact: true },
    };
  }

  getUpstreamMcpSummary() {
    return {
      protocolVersion: "2025-06-18",
      implementation: { name: "uds-test-provider", version: "1.0.0" },
    };
  }
}

describe
  .skipIf(process.platform === "win32")
  .sequential("Unix-domain-socket transport", () => {
    afterEach(async () => {
      for (const server of trackedServers) {
        try {
          await server.stop();
        } catch {
          // Tests that replace the published path assert the cleanup error.
        }
      }
      trackedServers.clear();

      for (const server of trackedHttpServers) {
        if (!server.listening) continue;
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      trackedHttpServers.clear();

      for (const directory of trackedDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
      trackedDirectories.clear();
      restoreBridgeEnv();
    });

    it("serves authenticated handshake, tool, and resource operations over UDS", async () => {
      const provider = new UdsProvider();
      const { server, socketPath, started } = await startUds(provider);
      setRpcEnvironment(socketPath, started.token);

      const info = await getBridgeInfo();
      expect(info.bridgeProtocol).toMatchObject({ major: 1, version: "1.1" });
      expect(info.capabilities.transport).toEqual({
        type: "unix",
        networkListener: false,
      });
      expect(info.capabilities.resources).toEqual({
        list: true,
        templates: true,
        read: true,
      });

      const described = (await rpcCall("describeTool", {
        server: "uds",
        tool: "echo",
      })) as ToolInfo;
      expect(described).toEqual(provider.getTools()[0]);

      const called = (await rpcCall("callTool", {
        server: "uds",
        tool: "echo",
        arguments: { value: "hello" },
      })) as CallToolResult;
      expect(called).toEqual({
        content: [{ type: "text", text: "hello" }],
        structuredContent: { value: "hello", server: "uds" },
        extensionData: { exact: true },
      });

      const resource = (await rpcCall("readResource", {
        server: "uds",
        uri: "asset://fixture.bin",
      })) as ReadResourceResult;
      expect(resource).toEqual({
        contents: [
          {
            uri: "asset://fixture.bin",
            mimeType: "application/octet-stream",
            blob: BINARY_B64,
            extensionData: { exact: true },
          },
        ],
        extensionData: { exact: true },
      });
      expect(server.getTransport()).toBe("unix");
    });

    it("requires the bearer token on the Unix socket", async () => {
      const { socketPath, started } = await startUds(new UdsProvider());

      expect((await rawRpc(socketPath)).status).toBe(401);
      expect((await rawRpc(socketPath, "wrong-token")).status).toBe(401);
      expect((await rawRpc(socketPath, started.token)).status).toBe(200);
    });

    it("uses TOOL_CLI_SOCKET ahead of TCP host and port without a TCP request", async () => {
      let tcpRequests = 0;
      const tcpServer = http.createServer((_req, res) => {
        tcpRequests++;
        res.writeHead(500);
        res.end();
      });
      trackedHttpServers.add(tcpServer);
      await new Promise<void>((resolve) =>
        tcpServer.listen(0, "127.0.0.1", () => resolve()),
      );
      const address = tcpServer.address();
      if (!address || typeof address === "string") {
        throw new Error("TCP trap did not bind");
      }

      const { socketPath, started } = await startUds(new UdsProvider());
      setRpcEnvironment(socketPath, started.token);
      process.env[HOST_ENV_VAR] = "127.0.0.1";
      process.env[PORT_ENV_VAR] = String(address.port);

      const result = (await rpcCall("listServers")) as {
        servers: { name: string }[];
      };
      expect(result.servers.map(({ name }) => name)).toEqual(["uds"]);
      expect(tcpRequests).toBe(0);
    });

    it("propagates caller cancellation and timeouts to the provider", async () => {
      const cancelledProvider = new UdsProvider("cancelled");
      const cancelled = await startUds(cancelledProvider);
      setRpcEnvironment(cancelled.socketPath, cancelled.started.token);
      const controller = new AbortController();
      const pending = rpcCall(
        "callTool",
        { server: "cancelled", tool: "wait", arguments: {} },
        { signal: controller.signal },
      );
      await cancelledProvider.waitStarted.promise;
      controller.abort("uds cancellation");
      await expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof RpcAbortError && error.reason === "uds cancellation",
      );
      await cancelledProvider.waitAborted.promise;
      await cancelled.server.stop();

      const timedProvider = new UdsProvider("timed");
      const timed = await startUds(timedProvider);
      setRpcEnvironment(timed.socketPath, timed.started.token);
      await expect(
        rpcCall(
          "callTool",
          { server: "timed", tool: "wait", arguments: {} },
          { timeoutMs: 20 },
        ),
      ).rejects.toBeInstanceOf(RpcTimeoutError);
      await timedProvider.waitAborted.promise;
    });

    it("creates a 0700 parent and publishes only a 0600 socket", async () => {
      const root = temporaryDirectory("tool-cli-parent-");
      const parent = join(root, "session");
      const socketPath = join(parent, "bridge.sock");
      const server = track(new ToolCliServer(new UdsProvider()));
      const messages: string[] = [];
      const started = await server.startUnixSocket(socketPath, (message) =>
        messages.push(message),
      );

      expect(started).toMatchObject({
        port: 0,
        transport: "unix",
        socketPath,
      });
      expect(server.getPort()).toBe(0);
      expect(server.getSocketPath()).toBe(socketPath);
      expect(lstatSync(parent).mode & 0o777).toBe(0o700);
      expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
      const entries = readdirSync(parent).sort();
      expect(entries).toHaveLength(2);
      expect(entries).toContain("bridge.sock");
      const backingName = entries.find((entry) => entry !== "bridge.sock");
      expect(backingName).toMatch(/^\.tc-[0-9a-f]{12}$/);
      const backingStats = lstatSync(join(parent, backingName as string));
      const publicStats = lstatSync(socketPath);
      expect(backingStats.isSocket()).toBe(true);
      expect(backingStats.mode & 0o777).toBe(0o600);
      expect(backingStats.ino).toBe(publicStats.ino);
      const collision = track(new ToolCliServer(new UdsProvider("collision")));
      await expect(
        collision.startUnixSocket(join(parent, backingName as string)),
      ).rejects.toMatchObject({
        name: "UnixSocketPathError",
        code: "EADDRINUSE",
      });
      expect(messages.join("\n")).toContain(socketPath);
      expect(messages.join("\n")).not.toContain(started.token);
    });

    it("preserves the legacy start signature and result shape for TCP", async () => {
      class LegacyOverrideServer extends ToolCliServer {
        override start(log?: (message: string) => void): Promise<StartResult> {
          return super.start(log);
        }
      }

      const server = track(new LegacyOverrideServer(new UdsProvider()));
      const startArgs: Parameters<LegacyOverrideServer["start"]> = [];
      const started = await server.start(undefined);
      const legacyResult: StartResult = {
        port: started.port,
        token: started.token,
      };

      expect(started.transport).toBe("tcp");
      expect(started.port).toBeGreaterThan(0);
      expect(started.socketPath).toBeUndefined();
      expect(server.getTransport()).toBe("tcp");
      expect(legacyResult.port).toBe(started.port);
      expect(startArgs).toEqual([]);
    });

    it("serializes concurrent lifecycle calls on one server instance", async () => {
      const directory = temporaryDirectory("tool-cli-lifecycle-");
      const socketPath = join(directory, "bridge.sock");
      const server = track(new ToolCliServer(new UdsProvider()));

      const [first, second] = await Promise.all([
        server.start(),
        server.startUnixSocket(socketPath),
      ]);
      expect(second).toEqual(first);
      expect(second).not.toBe(first);
      expect(first.transport).toBe("tcp");
      expect(first.port).toBeGreaterThan(0);
      expect(existsSync(socketPath)).toBe(false);
      second.token = "corrupted";
      expect((await server.start()).token).toBe(first.token);

      await server.stop();
      await expect(
        fetch(`http://127.0.0.1:${first.port}`),
      ).rejects.toBeDefined();

      const starting = server.startUnixSocket(socketPath);
      const stopping = server.stop();
      await expect(starting).resolves.toMatchObject({ transport: "unix" });
      await expect(stopping).resolves.toBeUndefined();
      expect(existsSync(socketPath)).toBe(false);
    });

    it("makes reentrant starts share the outer startup failure", async () => {
      const server = track(new ToolCliServer(new UdsProvider()));
      let nested: Promise<StartResult> | undefined;
      let stopping: Promise<void> | undefined;
      const outer = server.start(() => {
        stopping = server.stop();
        nested = server.start();
        void nested.catch(() => {});
        throw new Error("logger failed");
      });

      await expect(outer).rejects.toThrow("logger failed");
      expect(nested).toBeDefined();
      await expect(nested as Promise<StartResult>).rejects.toThrow(
        "logger failed",
      );
      await expect(stopping as Promise<void>).resolves.toBeUndefined();
      expect(server.getPort()).toBe(0);
      await expect(server.start()).resolves.toMatchObject({
        transport: "tcp",
      });
    });

    it("supports concurrent session sockets and isolated child environments", async () => {
      const first = await startUds(new UdsProvider("first"));
      const second = await startUds(new UdsProvider("second"));

      const [firstCli, secondCli] = await Promise.all([
        runCli(["--json"], udsChildEnv(first.socketPath, first.started.token)),
        runCli(
          ["--json"],
          udsChildEnv(second.socketPath, second.started.token),
        ),
      ]);

      expect(firstCli).toMatchObject({ code: 0, stderr: "" });
      expect(secondCli).toMatchObject({ code: 0, stderr: "" });
      expect(
        (JSON.parse(firstCli.stdout) as { servers: { name: string }[] })
          .servers,
      ).toEqual([expect.objectContaining({ name: "first" })]);
      expect(
        (JSON.parse(secondCli.stdout) as { servers: { name: string }[] })
          .servers,
      ).toEqual([expect.objectContaining({ name: "second" })]);
    });

    it("preserves CLI schemas, binary --out bytes, and stdout cleanliness over UDS", async () => {
      const provider = new UdsProvider();
      const { socketPath, started } = await startUds(provider);
      const env = udsChildEnv(socketPath, started.token);

      const schema = await runCli(["uds", "echo", "--json"], env);
      expect(schema).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(schema.stdout)).toEqual(provider.getTools()[0]);

      const outputDirectory = temporaryDirectory("tool-cli-output-");
      const outputPath = join(outputDirectory, "fixture.bin");
      const resource = await runCli(
        [
          "resource",
          "read",
          "--server",
          "uds",
          "asset://fixture.bin",
          "--out",
          outputPath,
          "--json",
        ],
        env,
      );
      expect(resource).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(resource.stdout)).toMatchObject({
        written: outputPath,
        bytes: BINARY_BYTES.length,
      });
      expect(readFileSync(outputPath)).toEqual(BINARY_BYTES);

      const unauthorized = await runCli(["--json"], {
        ...env,
        [TOKEN_ENV_VAR]: "wrong-token",
      });
      expect(unauthorized.code).toBe(1);
      expect(unauthorized.stdout).toBe("");
      expect(unauthorized.stderr).toContain("HTTP 401");
    });

    it("accepts a child-visible socket alias like a bind-mounted file", async () => {
      const { socketPath, started } = await startUds(
        new UdsProvider("mounted"),
      );
      const containerDirectory = temporaryDirectory("tool-cli-container-");
      const mountedPath = join(containerDirectory, "bridge.sock");
      linkSync(socketPath, mountedPath);

      const result = await runCli(
        ["--json"],
        udsChildEnv(mountedPath, started.token),
      );
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain('"mounted"');
      unlinkSync(mountedPath);
    });

    it("reclaims an owned stale socket but refuses an active one", async () => {
      const directory = temporaryDirectory("tool-cli-stale-");
      const socketPath = join(directory, "bridge.sock");
      await leaveStaleSocket(socketPath);
      expect(lstatSync(socketPath).isSocket()).toBe(true);

      const replacement = track(new ToolCliServer(new UdsProvider("new")));
      const started = await replacement.startUnixSocket(socketPath);
      setRpcEnvironment(socketPath, started.token);
      const result = (await rpcCall("listServers")) as {
        servers: { name: string }[];
      };
      expect(result.servers[0].name).toBe("new");

      const competing = track(new ToolCliServer(new UdsProvider("other")));
      await expect(competing.startUnixSocket(socketPath)).rejects.toMatchObject(
        {
          name: "UnixSocketPathError",
          code: "EADDRINUSE",
        },
      );
      expect(lstatSync(socketPath).isSocket()).toBe(true);
    });

    it("allows only one winner when two servers race for the same path", async () => {
      const directory = temporaryDirectory("tool-cli-race-");
      const socketPath = join(directory, "bridge.sock");
      const first = track(new ToolCliServer(new UdsProvider("first")));
      const second = track(new ToolCliServer(new UdsProvider("second")));

      const results = await Promise.allSettled([
        first.startUnixSocket(socketPath),
        second.startUnixSocket(socketPath),
      ]);
      const fulfilled = results.filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<ToolCliServer["start"]>>
        > => result.status === "fulfilled",
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toMatchObject({
        name: "UnixSocketPathError",
        code: "EADDRINUSE",
      });

      setRpcEnvironment(socketPath, fulfilled[0].value.token);
      const response = (await rpcCall("listServers")) as {
        servers: { name: string }[];
      };
      expect(["first", "second"]).toContain(response.servers[0].name);
    });

    it("removes the socket on stop, process exit signals, and external directory cleanup", async () => {
      const stopped = await startUds(new UdsProvider());
      await stopped.server.stop();
      expect(existsSync(stopped.socketPath)).toBe(false);

      const directory = temporaryDirectory("tool-cli-signal-");
      const socketPath = join(directory, "bridge.sock");
      const child = spawnSignalServer(socketPath);
      const [ready] = (await once(child.stdout, "data")) as [Buffer];
      expect(ready.toString()).toContain("ready");
      expect(existsSync(socketPath)).toBe(true);

      child.kill("SIGTERM");
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect(code).toBeNull();
      expect(signal).toBe("SIGTERM");
      expect(existsSync(socketPath)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);

      const removedParent = await startUds(new UdsProvider());
      rmSync(dirname(removedParent.socketPath), {
        recursive: true,
        force: true,
      });
      await expect(removedParent.server.stop()).resolves.toBeUndefined();
    });

    it("keeps the socket available when the embedding host handles SIGHUP", async () => {
      const directory = temporaryDirectory("tool-cli-sighup-");
      const socketPath = join(directory, "bridge.sock");
      const child = spawnSignalServer(socketPath, true);
      const [ready] = (await once(child.stdout, "data")) as [Buffer];
      expect(ready.toString()).toContain("ready");

      child.kill("SIGHUP");
      const [reloaded] = (await once(child.stdout, "data")) as [Buffer];
      expect(reloaded.toString()).toContain("reloaded");
      expect(existsSync(socketPath)).toBe(true);
      expect((await rawRpc(socketPath)).status).toBe(401);

      child.kill("SIGTERM");
      await once(child, "exit");
      expect(existsSync(socketPath)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    });

    it("coordinates signal cleanup across separately loaded package copies", async () => {
      const directory = temporaryDirectory("tool-cli-module-copies-");
      const firstPath = join(directory, "first.sock");
      const secondPath = join(directory, "second.sock");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import http from "node:http";
            const first = await import(${JSON.stringify(`${UNIX_SOCKET_MODULE_URL}?copy=first`)});
            const second = await import(${JSON.stringify(`${UNIX_SOCKET_MODULE_URL}?copy=second`)});
            const firstServer = http.createServer();
            const secondServer = http.createServer();
            const firstBinding = await first.bindUnixSocket(
              firstServer,
              process.env.FIRST_SOCKET_PATH,
            );
            const secondBinding = await second.bindUnixSocket(
              secondServer,
              process.env.SECOND_SOCKET_PATH,
            );
            first.registerUnixSocketCleanup(firstBinding);
            second.registerUnixSocketCleanup(secondBinding);
            process.stdout.write("ready\\n");
            setInterval(() => {}, 1000);
          `,
        ],
        {
          env: {
            ...sanitizedProcessEnv(),
            FIRST_SOCKET_PATH: firstPath,
            SECOND_SOCKET_PATH: secondPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const [ready] = (await once(child.stdout, "data")) as [Buffer];
      expect(ready.toString()).toContain("ready");

      child.kill("SIGTERM");
      const [code, signal] = (await once(child, "exit")) as [
        number | null,
        NodeJS.Signals | null,
      ];
      expect(code).toBeNull();
      expect(signal).toBe("SIGTERM");
      expect(existsSync(firstPath)).toBe(false);
      expect(existsSync(secondPath)).toBe(false);
      expect(readdirSync(directory)).toEqual([]);
    });

    it("refuses traversal, insecure parents, symlinks, and foreign entries", async () => {
      const traversalRoot = temporaryDirectory("tool-cli-traversal-");
      mkdirSync(join(traversalRoot, "session"), { mode: 0o700 });
      const traversalPath = `${traversalRoot}/session/../bridge.sock`;
      await expect(
        track(new ToolCliServer(new UdsProvider())).startUnixSocket(
          traversalPath,
        ),
      ).rejects.toThrow(/normalized|traversal/i);

      const insecureParent = temporaryDirectory("tool-cli-insecure-");
      chmodSync(insecureParent, 0o755);
      await expect(
        track(new ToolCliServer(new UdsProvider())).startUnixSocket(
          join(insecureParent, "bridge.sock"),
        ),
      ).rejects.toThrow(/0700/);

      const writableAncestor = temporaryDirectory(
        "tool-cli-writable-ancestor-",
      );
      const protectedParent = join(writableAncestor, "session");
      mkdirSync(protectedParent, { mode: 0o700 });
      chmodSync(writableAncestor, 0o777);
      await expect(
        track(new ToolCliServer(new UdsProvider())).startUnixSocket(
          join(protectedParent, "bridge.sock"),
        ),
      ).rejects.toThrow(/writable directory without the sticky bit/);

      const blockedRoot = temporaryDirectory("tool-cli-blocked-");
      const blockedParent = join(blockedRoot, "blocked");
      const blockedPath = join(blockedParent, "session", "bridge.sock");
      mkdirSync(blockedParent, { mode: 0o000 });
      try {
        await expect(
          track(new ToolCliServer(new UdsProvider())).startUnixSocket(
            blockedPath,
          ),
        ).rejects.toSatisfy(
          (error: unknown) =>
            error instanceof UnixSocketPathError &&
            error.socketPath === blockedPath &&
            error.code === "EACCES",
        );
      } finally {
        chmodSync(blockedParent, 0o700);
      }

      const foreignDirectory = temporaryDirectory("tool-cli-foreign-");
      const foreignPath = join(foreignDirectory, "bridge.sock");
      writeFileSync(foreignPath, "do not replace");
      await expect(
        track(new ToolCliServer(new UdsProvider())).startUnixSocket(
          foreignPath,
        ),
      ).rejects.toThrow(/non-socket/);
      expect(readFileSync(foreignPath, "utf8")).toBe("do not replace");

      const symlinkDirectory = temporaryDirectory("tool-cli-symlink-");
      const target = join(symlinkDirectory, "target");
      const symlinkPath = join(symlinkDirectory, "bridge.sock");
      writeFileSync(target, "do not clobber");
      symlinkSync(target, symlinkPath);
      await expect(
        track(new ToolCliServer(new UdsProvider())).startUnixSocket(
          symlinkPath,
        ),
      ).rejects.toThrow(/symlink/);
      expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("do not clobber");

      const realParent = temporaryDirectory("tool-cli-real-parent-");
      const parentLinkRoot = temporaryDirectory("tool-cli-parent-link-");
      const linkedParent = join(parentLinkRoot, "session");
      symlinkSync(realParent, linkedParent);
      const aliasServer = track(new ToolCliServer(new UdsProvider()));
      const aliasResult = await aliasServer.startUnixSocket(
        join(linkedParent, "bridge.sock"),
      );
      expect(aliasResult.socketPath).toBe(join(realParent, "bridge.sock"));
      expect(existsSync(join(linkedParent, "bridge.sock"))).toBe(true);
      await aliasServer.stop();
      expect(lstatSync(linkedParent).isSymbolicLink()).toBe(true);
    });

    it("does not clobber a replacement symlink during close", async () => {
      const { server, socketPath } = await startUds(new UdsProvider());
      const directory = temporaryDirectory("tool-cli-replacement-");
      const target = join(directory, "target");
      writeFileSync(target, "preserve me");
      unlinkSync(socketPath);
      symlinkSync(target, socketPath);

      await expect(server.stop()).rejects.toBeInstanceOf(UnixSocketPathError);
      expect(lstatSync(socketPath).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, "utf8")).toBe("preserve me");
    });

    it("reports missing and unreachable Unix sockets without touching stdout", async () => {
      const directory = temporaryDirectory("tool-cli-missing-");
      const missingPath = join(directory, "missing.sock");
      setRpcEnvironment("relative.sock", "test-token");
      await expect(rpcCall("listServers")).rejects.toMatchObject({
        name: "RpcTransportError",
        transport: "unix",
        endpoint: "relative.sock",
        code: "EINVAL",
      });

      setRpcEnvironment(missingPath, "test-token");
      await expect(rpcCall("listServers")).rejects.toMatchObject({
        name: "RpcTransportError",
        transport: "unix",
        endpoint: missingPath,
        code: "ENOENT",
      });
      await expect(rpcCall("listServers")).rejects.toThrow(
        `Unix socket not found: ${missingPath}`,
      );

      const missingCli = await runCli(
        ["--json"],
        udsChildEnv(missingPath, "test-token"),
      );
      expect(missingCli.code).toBe(1);
      expect(missingCli.stdout).toBe("");
      expect(missingCli.stderr).toContain(
        `Unix socket not found: ${missingPath}`,
      );

      const stalePath = join(directory, "stale.sock");
      await leaveStaleSocket(stalePath);
      setRpcEnvironment(stalePath, "test-token");
      await expect(rpcCall("listServers")).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof RpcTransportError &&
          error.transport === "unix" &&
          error.code === "ECONNREFUSED" &&
          error.message.includes("not accepting connections"),
      );
    });
  });

async function startUds(provider: ToolProvider): Promise<{
  server: ToolCliServer;
  socketPath: string;
  started: Awaited<ReturnType<ToolCliServer["start"]>>;
}> {
  const directory = temporaryDirectory("tool-cli-uds-");
  const socketPath = join(directory, "bridge.sock");
  const server = track(new ToolCliServer(provider));
  const started = await server.startUnixSocket(socketPath);
  return { server, socketPath, started };
}

function track(server: ToolCliServer): ToolCliServer {
  trackedServers.add(server);
  return server;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  trackedDirectories.add(directory);
  return directory;
}

function setRpcEnvironment(socketPath: string, token: string): void {
  process.env[SOCKET_ENV_VAR] = socketPath;
  process.env[TOKEN_ENV_VAR] = token;
  delete process.env[HOST_ENV_VAR];
  delete process.env[PORT_ENV_VAR];
}

function udsChildEnv(socketPath: string, token: string): NodeJS.ProcessEnv {
  return {
    ...sanitizedProcessEnv(),
    [SOCKET_ENV_VAR]: socketPath,
    [TOKEN_ENV_VAR]: token,
  };
}

function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("TOOL_CLI_")) delete env[key];
  }
  return env;
}

function restoreBridgeEnv(): void {
  for (const key of bridgeEnvVars) {
    const value = originalBridgeEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function rawRpc(
  socketPath: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "listServers",
      params: {},
      id: 1,
    });
    const request = http.request(
      {
        socketPath,
        path: "/",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(payload)),
          ...(token ? { Authorization: ["Bearer", token].join(" ") } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { env, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

function spawnSignalServer(socketPath: string, handleSighup = false) {
  return spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { ToolCliServer } from ${JSON.stringify(SERVER_ENTRY_URL)};
        ${
          handleSighup
            ? 'process.once("SIGHUP", () => process.stdout.write("reloaded\\\\n"));'
            : ""
        }
        const provider = {
          getServerNames: () => [],
          getTools: () => [],
          callTool: async () => ({ content: [] }),
        };
        const server = new ToolCliServer(provider);
        await server.startUnixSocket(process.env.TEST_SOCKET_PATH);
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        ...sanitizedProcessEnv(),
        TEST_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function leaveStaleSocket(socketPath: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { ToolCliServer } from ${JSON.stringify(SERVER_ENTRY_URL)};
        const provider = {
          getServerNames: () => [],
          getTools: () => [],
          callTool: async () => ({ content: [] }),
        };
        const server = new ToolCliServer(provider);
        await server.startUnixSocket(process.env.TEST_SOCKET_PATH);
        process.stdout.write("ready\\n");
        setInterval(() => {}, 1000);
      `,
    ],
    {
      env: {
        ...sanitizedProcessEnv(),
        TEST_SOCKET_PATH: socketPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const [ready] = (await once(child.stdout, "data")) as [Buffer];
  expect(ready.toString()).toContain("ready");
  child.kill("SIGKILL");
  await once(child, "exit");
  expect(existsSync(socketPath)).toBe(true);
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
