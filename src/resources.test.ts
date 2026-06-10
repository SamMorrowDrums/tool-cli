import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ToolCliServer } from "./server.js";
import { rpcCall } from "./rpc-client.js";
import type {
  ToolProvider,
  ToolInfo,
  CallToolResult,
  ResourceInfo,
  ResourceTemplateInfo,
  ReadResourceResult,
} from "./provider.js";
import { PORT_ENV_VAR, TOKEN_ENV_VAR } from "./constants.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Provider that supports resources across multiple servers. */
class ResourceProvider implements ToolProvider {
  private tools = new Map<string, ToolInfo[]>();
  private resources = new Map<string, ResourceInfo[]>();
  private templates = new Map<string, ResourceTemplateInfo[]>();
  private contents = new Map<string, ReadResourceResult>();

  addServer(
    name: string,
    opts: {
      tools?: ToolInfo[];
      resources?: ResourceInfo[];
      templates?: ResourceTemplateInfo[];
      reads?: Record<string, ReadResourceResult>;
    } = {},
  ) {
    this.tools.set(name, opts.tools ?? []);
    this.resources.set(name, opts.resources ?? []);
    this.templates.set(name, opts.templates ?? []);
    for (const [uri, res] of Object.entries(opts.reads ?? {})) {
      this.contents.set(`${name}::${uri}`, res);
    }
  }

  getServerNames(): string[] {
    return [...this.tools.keys()];
  }
  getTools(server: string): ToolInfo[] {
    return this.tools.get(server) ?? [];
  }
  async callTool(_server: string, tool: string): Promise<CallToolResult> {
    return { content: [{ type: "text", text: `Called ${tool}` }] };
  }
  async listResources(server: string): Promise<ResourceInfo[]> {
    return this.resources.get(server) ?? [];
  }
  async listResourceTemplates(server: string): Promise<ResourceTemplateInfo[]> {
    return this.templates.get(server) ?? [];
  }
  async readResource(server: string, uri: string): Promise<ReadResourceResult> {
    const res = this.contents.get(`${server}::${uri}`);
    if (!res) throw new Error(`Resource not found: ${uri}`);
    return res;
  }
}

/** Tools-only provider — does NOT implement any resource method. */
class ToolsOnlyProvider implements ToolProvider {
  getServerNames(): string[] {
    return ["plain"];
  }
  getTools(): ToolInfo[] {
    return [];
  }
  async callTool(): Promise<CallToolResult> {
    return { content: [] };
  }
}

const BINARY_BYTES = Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x10, 0x20]);
const BINARY_B64 = BINARY_BYTES.toString("base64");

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      { env: { ...process.env, ...env }, encoding: "utf-8" },
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

describe("resource RPC methods", () => {
  const provider = new ResourceProvider();
  const server = new ToolCliServer(provider);

  beforeAll(async () => {
    provider.addServer("docs", {
      resources: [
        {
          uri: "file:///readme.md",
          name: "Readme",
          description: "Project readme",
          mimeType: "text/markdown",
        },
      ],
      templates: [
        {
          uriTemplate: "file:///logs/{date}.log",
          name: "Daily log",
          mimeType: "text/plain",
        },
      ],
      reads: {
        "file:///readme.md": {
          contents: [
            {
              uri: "file:///readme.md",
              mimeType: "text/markdown",
              text: "# Hello\n",
            },
          ],
        },
        "file:///multi": {
          contents: [
            { uri: "file:///a.txt", mimeType: "text/plain", text: "AAA" },
            { uri: "file:///b.txt", mimeType: "text/plain", text: "BBB" },
          ],
        },
        "file:///image.png": {
          contents: [
            {
              uri: "file:///image.png",
              mimeType: "image/png",
              blob: BINARY_B64,
            },
          ],
        },
      },
    });
    provider.addServer("media", {
      resources: [{ uri: "asset://logo", name: "Logo", mimeType: "image/svg" }],
    });

    const result = await server.start();
    process.env[PORT_ENV_VAR] = String(result.port);
    process.env[TOKEN_ENV_VAR] = result.token;
  });

  afterAll(async () => {
    await server.stop();
    delete process.env[PORT_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
  });

  it("listResources returns resources for a server", async () => {
    const res = (await rpcCall("listResources", { server: "docs" })) as {
      server: string;
      resources: ResourceInfo[];
    };
    expect(res.server).toBe("docs");
    expect(res.resources).toHaveLength(1);
    expect(res.resources[0].uri).toBe("file:///readme.md");
  });

  it("listResourceTemplates returns templates for a server", async () => {
    const res = (await rpcCall("listResourceTemplates", {
      server: "docs",
    })) as { templates: ResourceTemplateInfo[] };
    expect(res.templates[0].uriTemplate).toBe("file:///logs/{date}.log");
  });

  it("readResource returns contents", async () => {
    const res = (await rpcCall("readResource", {
      server: "docs",
      uri: "file:///readme.md",
    })) as ReadResourceResult;
    expect(res.contents[0].text).toBe("# Hello\n");
  });

  it("returns error for unknown server", async () => {
    await expect(rpcCall("listResources", { server: "nope" })).rejects.toThrow(
      /not found/i,
    );
  });

  it("requires server param", async () => {
    await expect(rpcCall("listResources", {})).rejects.toThrow(/missing/i);
  });
});

describe("resource RPC — tools-only provider", () => {
  const provider = new ToolsOnlyProvider();
  const server = new ToolCliServer(provider);

  beforeAll(async () => {
    const result = await server.start();
    process.env[PORT_ENV_VAR] = String(result.port);
    process.env[TOKEN_ENV_VAR] = result.token;
  });
  afterAll(async () => {
    await server.stop();
    delete process.env[PORT_ENV_VAR];
    delete process.env[TOKEN_ENV_VAR];
  });

  it("returns a structured, friendly not-supported error", async () => {
    await expect(rpcCall("listResources", { server: "plain" })).rejects.toThrow(
      /does not support resources/i,
    );
  });

  it("read also reports not supported", async () => {
    await expect(
      rpcCall("readResource", { server: "plain", uri: "x://y" }),
    ).rejects.toThrow(/does not support resources/i);
  });
});

describe("resource CLI grammar", () => {
  const provider = new ResourceProvider();
  const server = new ToolCliServer(provider);
  let env: NodeJS.ProcessEnv;
  let tmp: string;

  beforeAll(async () => {
    provider.addServer("docs", {
      resources: [
        {
          uri: "file:///readme.md",
          name: "Readme",
          mimeType: "text/markdown",
        },
      ],
      templates: [
        { uriTemplate: "file:///logs/{date}.log", name: "Daily log" },
      ],
      reads: {
        "file:///readme.md": {
          contents: [
            {
              uri: "file:///readme.md",
              mimeType: "text/markdown",
              text: "# Hello\n",
            },
          ],
        },
        "file:///multi": {
          contents: [
            { uri: "file:///a.txt", mimeType: "text/plain", text: "AAA" },
            { uri: "file:///b.txt", mimeType: "text/plain", text: "BBB" },
          ],
        },
        "file:///image.png": {
          contents: [
            {
              uri: "file:///image.png",
              mimeType: "image/png",
              blob: BINARY_B64,
            },
          ],
        },
      },
    });
    provider.addServer("media", {
      resources: [{ uri: "asset://logo", name: "Logo" }],
    });

    const result = await server.start();
    env = {
      [PORT_ENV_VAR]: String(result.port),
      [TOKEN_ENV_VAR]: result.token,
    };
    tmp = mkdtempSync(join(tmpdir(), "tool-cli-res-"));
  });

  afterAll(async () => {
    await server.stop();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("resource list --server lists a single server's resources", async () => {
    const { stdout, code } = await runCli(
      ["resource", "list", "--server", "docs"],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("docs —");
    expect(stdout).toContain("file:///readme.md");
    expect(stdout).not.toContain("asset://logo");
  });

  it("resource list with no --server groups across all servers", async () => {
    const { stdout, code } = await runCli(["resource", "list"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("docs —");
    expect(stdout).toContain("file:///readme.md");
    expect(stdout).toContain("media —");
    expect(stdout).toContain("asset://logo");
  });

  it("resource templates lists templates", async () => {
    const { stdout, code } = await runCli(
      ["resource", "templates", "--server", "docs"],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("file:///logs/{date}.log");
  });

  it("resource list --json emits machine-readable grouped output", async () => {
    const { stdout, code } = await runCli(["resource", "list", "--json"], env);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as {
      server: string;
      resources?: ResourceInfo[];
    }[];
    const docs = parsed.find((p) => p.server === "docs");
    expect(docs?.resources?.[0].uri).toBe("file:///readme.md");
  });

  it("resource read prints text to stdout", async () => {
    const { stdout, code } = await runCli(
      ["resource", "read", "--server", "docs", "--uri", "file:///readme.md"],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("# Hello");
  });

  it("resource read of multiple contents adds header separators", async () => {
    const { stdout, code } = await runCli(
      ["resource", "read", "--server", "docs", "--uri", "file:///multi"],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("# file:///a.txt (text/plain)");
    expect(stdout).toContain("AAA");
    expect(stdout).toContain("# file:///b.txt (text/plain)");
    expect(stdout).toContain("BBB");
  });

  it("resource read --out writes base64-decoded bytes for a binary blob", async () => {
    const outPath = join(tmp, "image.png");
    const { stdout, code } = await runCli(
      [
        "resource",
        "read",
        "--server",
        "docs",
        "--uri",
        "file:///image.png",
        "--out",
        outPath,
      ],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("Written to:");
    expect(stdout).not.toContain(BINARY_B64);
    const written = readFileSync(outPath);
    expect(Buffer.compare(written, BINARY_BYTES)).toBe(0);
  });

  it("binary blob without --out is not dumped; hints to use --out", async () => {
    const { stdout, code } = await runCli(
      ["resource", "read", "--server", "docs", "--uri", "file:///image.png"],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).not.toContain(BINARY_B64);
    expect(stdout).toContain("binary");
    expect(stdout).toContain("--out");
  });

  it("resource read --meta prints metadata only, never the body", async () => {
    const { stdout, code } = await runCli(
      [
        "resource",
        "read",
        "--server",
        "docs",
        "--uri",
        "file:///readme.md",
        "--meta",
      ],
      env,
    );
    expect(code).toBe(0);
    expect(stdout).toContain("file:///readme.md");
    expect(stdout).toContain("text");
    expect(stdout).not.toContain("# Hello");
  });

  it("resource read --json emits machine-readable contents", async () => {
    const { stdout, code } = await runCli(
      [
        "resource",
        "read",
        "--server",
        "docs",
        "--uri",
        "file:///readme.md",
        "--json",
      ],
      env,
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as ReadResourceResult;
    expect(parsed.contents[0].text).toBe("# Hello\n");
  });

  it("read defaults to the only server when one is connected", async () => {
    const solo = new ResourceProvider();
    solo.addServer("only", {
      reads: {
        "file:///x": {
          contents: [
            { uri: "file:///x", mimeType: "text/plain", text: "solo" },
          ],
        },
      },
    });
    const soloServer = new ToolCliServer(solo);
    const r = await soloServer.start();
    try {
      const { stdout, code } = await runCli(
        ["resource", "read", "--uri", "file:///x"],
        { [PORT_ENV_VAR]: String(r.port), [TOKEN_ENV_VAR]: r.token },
      );
      expect(code).toBe(0);
      expect(stdout).toContain("solo");
    } finally {
      await soloServer.stop();
    }
  });

  it("read errors and lists servers when ambiguous and --server omitted", async () => {
    const { stderr, code } = await runCli(
      ["resource", "read", "--uri", "file:///readme.md"],
      env,
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/specify --server/i);
    expect(stderr).toContain("docs");
    expect(stderr).toContain("media");
  });

  it("read of an unknown server errors", async () => {
    const { stderr, code } = await runCli(
      ["resource", "read", "--server", "ghost", "--uri", "file:///x"],
      env,
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/not found/i);
  });

  it("unknown resource subcommand errors", async () => {
    const { stderr, code } = await runCli(["resource", "bogus"], env);
    expect(code).toBe(1);
    expect(stderr).toMatch(/unknown resource subcommand/i);
  });
});

describe("resource CLI — tools-only provider", () => {
  const provider = new ToolsOnlyProvider();
  const server = new ToolCliServer(provider);
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    const result = await server.start();
    env = {
      [PORT_ENV_VAR]: String(result.port),
      [TOKEN_ENV_VAR]: result.token,
    };
  });
  afterAll(async () => {
    await server.stop();
  });

  it("resource list reports the not-supported error per server", async () => {
    const { stdout, code } = await runCli(["resource", "list"], env);
    expect(code).toBe(0);
    expect(stdout).toContain("plain —");
    expect(stdout).toMatch(/does not support resources/i);
  });

  it("resource read surfaces a friendly not-supported error", async () => {
    const { stderr, code } = await runCli(
      ["resource", "read", "--server", "plain", "--uri", "x://y"],
      env,
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/does not support resources/i);
  });
});
