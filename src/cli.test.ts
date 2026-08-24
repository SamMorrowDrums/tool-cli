import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PORT_ENV_VAR, TOKEN_ENV_VAR } from "./constants.js";
import type { CallToolResult, ToolInfo, ToolProvider } from "./provider.js";
import { SERVER_IMPLEMENTATION_VERSION } from "./protocol.js";
import { ToolCliServer } from "./server.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));

class CliProvider implements ToolProvider {
  callCount = 0;

  getServerNames(): string[] {
    return ["example"];
  }

  getTools(): ToolInfo[] {
    return [
      {
        name: "complex",
        description: "Use nested arguments",
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: ["safe", "fast"],
              description: "Execution mode",
            },
            request: {
              type: "object",
              properties: {
                ids: {
                  type: "array",
                  items: { type: "integer" },
                },
              },
              required: ["ids"],
              additionalProperties: false,
            },
          },
          required: ["mode", "request"],
          additionalProperties: false,
          $defs: {
            untouched: {
              type: "object",
              properties: { value: { type: ["string", "null"] } },
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: { accepted: { type: "boolean" } },
        },
        annotations: { readOnlyHint: true },
        icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+" }],
      },
      {
        name: "provider_error",
        description: "Return an MCP tool error result",
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
  ): Promise<CallToolResult> {
    this.callCount++;
    if (tool === "provider_error") {
      return {
        content: [{ type: "text", text: "provider rejected the call" }],
        isError: true,
        errorMetadata: { category: "policy" },
      };
    }
    return {
      content: [
        { type: "text", text: "accepted" },
        {
          type: "resource_link",
          uri: "file:///result.json",
          name: "Result",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///inline.json",
            mimeType: "application/json",
            text: '{"ok":true}',
          },
        },
      ],
      structuredContent: {
        accepted: true,
        echoedArguments: args,
        nullable: null,
      },
      vendorMetadata: { trace: ["a", 2, false] },
    };
  }
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
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

describe("global CLI metadata", () => {
  const disconnectedEnv = { ...process.env };
  delete disconnectedEnv[PORT_ENV_VAR];
  delete disconnectedEnv[TOKEN_ENV_VAR];

  it("--help works without bridge environment or authentication", async () => {
    const result = await runCli(["--help"], disconnectedEnv);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage:");
    expect(result.stdout).toContain("--version");
  });

  it("--version works without bridge environment or authentication", async () => {
    const result = await runCli(["--version"], disconnectedEnv);
    expect(result).toMatchObject({
      code: 0,
      stderr: "",
      stdout: `${SERVER_IMPLEMENTATION_VERSION}\n`,
    });
  });

  it("keeps the implementation version synchronized with package.json", () => {
    const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
      version: string;
    };
    expect(SERVER_IMPLEMENTATION_VERSION).toBe(pkg.version);
  });
});

describe("CLI schema and result fidelity", () => {
  const provider = new CliProvider();
  const server = new ToolCliServer(provider);
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    const started = await server.start();
    env = {
      ...process.env,
      [PORT_ENV_VAR]: String(started.port),
      [TOKEN_ENV_VAR]: started.token,
    };
  });

  afterAll(async () => {
    await server.stop();
  });

  it("emits the complete discovered tool details with --json", async () => {
    const result = await runCli(["example", "complex", "--json"], env);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const details = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(details.inputSchema).toEqual(provider.getTools()[0].inputSchema);
    expect(details.outputSchema).toEqual(provider.getTools()[0].outputSchema);
    expect(details.annotations).toEqual({ readOnlyHint: true });
    expect(details.icons).toEqual(provider.getTools()[0].icons);
  });

  it("keeps authenticated HTTP failures off stdout", async () => {
    const result = await runCli(["--json"], {
      ...env,
      [TOKEN_ENV_VAR]: "wrong-token",
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("HTTP 401");
    expect(result.stderr).toContain("Unauthorized");
  });

  it("summarizes nested, enum, optional, and required input fields for humans", async () => {
    const result = await runCli(["example", "complex"], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'mode (enum "safe" | "fast", required): Execution mode',
    );
    expect(result.stdout).toContain("request (object, required)");
    expect(result.stdout).toContain("ids (array<integer>, required)");
  });

  it("keeps arbitrary modern MCP content and extension fields lossless with --json", async () => {
    const args = {
      mode: "safe",
      request: { ids: [1, 2, 3] },
    };
    const result = await runCli(
      ["example", "complex", JSON.stringify(args), "--json"],
      env,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as CallToolResult;
    expect(output.structuredContent).toEqual({
      accepted: true,
      echoedArguments: args,
      nullable: null,
    });
    expect(output.content[1]).toMatchObject({
      type: "resource_link",
      uri: "file:///result.json",
    });
    expect(output.content[2]).toMatchObject({
      type: "resource",
      resource: { uri: "file:///inline.json", text: '{"ok":true}' },
    });
    expect(output.vendorMetadata).toEqual({ trace: ["a", 2, false] });
  });

  it("keeps stdout empty for schema failures and does not call the provider", async () => {
    const callsBefore = provider.callCount;
    const result = await runCli(
      [
        "example",
        "complex",
        JSON.stringify({ mode: "unsafe", request: { ids: ["wrong"] } }),
      ],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("JSON-RPC -32602");
    expect(result.stderr).toContain("validationErrors");
    expect(provider.callCount).toBe(callsBefore);
  });

  it("keeps provider error results on stderr and preserves them in JSON", async () => {
    const result = await runCli(
      ["example", "provider_error", "{}", "--json"],
      env,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "provider rejected the call" }],
      errorMetadata: { category: "policy" },
    });
  });
});
