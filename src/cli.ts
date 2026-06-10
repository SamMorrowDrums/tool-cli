#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import { rpcCall } from "./rpc-client.js";

interface ServerInfo {
  name: string;
  toolCount: number;
  examples: string[];
}

interface ToolSummary {
  name: string;
  description: string;
  hasStructuredOutput: boolean;
}

interface ToolDetails {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface ResourceInfo {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface ResourceTemplateInfo {
  uriTemplate: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

interface ReadResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface ReadResourceResult {
  contents: ReadResourceContent[];
}

interface ResourceFlags {
  server?: string;
  uri?: string;
  outFile?: string;
  json: boolean;
  meta: boolean;
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Extract flags (can appear anywhere). Value flags consume the next arg;
  // boolean flags stand alone. Everything else is a positional argument.
  let outFile: string | undefined;
  let serverFlag: string | undefined;
  let uriFlag: string | undefined;
  let jsonFlag = false;
  let metaFlag = false;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--out" && i + 1 < rawArgs.length) {
      outFile = rawArgs[++i];
    } else if (arg === "--server" && i + 1 < rawArgs.length) {
      serverFlag = rawArgs[++i];
    } else if (arg === "--uri" && i + 1 < rawArgs.length) {
      uriFlag = rawArgs[++i];
    } else if (arg === "--json") {
      jsonFlag = true;
    } else if (arg === "--meta") {
      metaFlag = true;
    } else {
      args.push(arg);
    }
  }

  try {
    // No args or --help → list servers
    if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
      await listServers();
      return;
    }

    // `resource` subcommand group (singular, reserved word). A server
    // literally named `resource` is therefore unsupported — acceptable here.
    if (args[0] === "resource") {
      await handleResource(args.slice(1), {
        server: serverFlag,
        uri: uriFlag,
        outFile,
        json: jsonFlag,
        meta: metaFlag,
      });
      return;
    }

    const server = args[0];

    // <server> --help or just <server> → list tools
    if (args.length === 1 || (args.length === 2 && isHelp(args[1]))) {
      await listTools(server);
      return;
    }

    const tool = args[1];

    // <server> <tool> --help or just <server> <tool> → describe tool
    if (args.length === 2 || (args.length === 3 && isHelp(args[2]))) {
      await describeTool(server, tool);
      return;
    }

    // <server> <tool> <json-args> → call tool
    await callTool(server, tool, args[2], outFile);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("ECONNREFUSED") || message.includes("fetch failed")) {
      console.error("Error: tool-cli server not running. Is mcpi-ext loaded?");
    } else {
      console.error(`Error: ${message}`);
    }
    process.exit(1);
  }
}

async function listServers(): Promise<void> {
  const result = (await rpcCall("listServers")) as { servers: ServerInfo[] };
  const { servers } = result;

  if (servers.length === 0) {
    console.log("No MCP servers connected.");
    return;
  }

  console.log("Available servers:");
  for (const s of servers) {
    const examples =
      s.examples.length > 0 ? ` (e.g. ${s.examples.join(", ")})` : "";
    console.log(`  ${s.name.padEnd(20)} ${s.toolCount} tool(s)${examples}`);
  }
  console.log("");
  console.log("Use: tool-cli <server> to list tools");
  console.log("Use: tool-cli resource list to list resources");
}

async function listTools(server: string): Promise<void> {
  const result = (await rpcCall("listTools", { server })) as {
    server: string;
    tools: ToolSummary[];
  };

  if (result.tools.length === 0) {
    console.log(`${server} — no tools`);
    return;
  }

  console.log(`${server} — ${result.tools.length} tool(s):`);
  for (const t of result.tools) {
    const badge = t.hasStructuredOutput ? " [json]" : "";
    console.log(`  ${t.name.padEnd(30)} ${t.description}${badge}`);
  }
  console.log("");
  console.log("Use: tool-cli <server> <tool> for full schema");
}

async function describeTool(server: string, tool: string): Promise<void> {
  const result = (await rpcCall("describeTool", {
    server,
    tool,
  })) as ToolDetails;

  console.log(`${result.name} — ${result.description}`);
  console.log("");
  console.log("Input schema:");
  console.log(formatSchema(result.inputSchema));

  if (result.outputSchema) {
    console.log("");
    console.log("Output schema (structured JSON output):");
    console.log(formatSchema(result.outputSchema));
  }

  if (result.annotations && Object.keys(result.annotations).length > 0) {
    console.log("");
    console.log("Annotations:");
    for (const [key, val] of Object.entries(result.annotations)) {
      console.log(`  ${key}: ${JSON.stringify(val)}`);
    }
  }

  console.log("");
  console.log(`Use: tool-cli ${server} ${tool} '{"key":"value"}' to call`);
}

async function callTool(
  server: string,
  tool: string,
  argsJson: string,
  outFile?: string,
): Promise<void> {
  let toolArgs: Record<string, unknown>;
  try {
    toolArgs = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    console.error(`Error: invalid JSON arguments: ${argsJson}`);
    process.exit(1);
  }

  const result = (await rpcCall("callTool", {
    server,
    tool,
    arguments: toolArgs,
  })) as {
    content: unknown[];
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };

  if (result.isError) {
    // Error content goes to stderr so stdout stays clean for piping
    if (result.structuredContent) {
      console.error(JSON.stringify(result.structuredContent, null, 2));
    } else if (result.content) {
      for (const item of result.content) {
        const entry = item as Record<string, unknown>;
        if (entry.type === "text") {
          console.error(entry.text);
        } else {
          console.error(JSON.stringify(entry, null, 2));
        }
      }
    }
    process.exit(1);
    return;
  }

  const output = formatOutput(result.structuredContent, result.content);
  if (!output) return;

  if (outFile) {
    writeFileSync(outFile, output, "utf-8");
    console.log(`Written to: ${outFile}`);
  } else {
    console.log(output);
  }
}

async function handleResource(
  args: string[],
  flags: ResourceFlags,
): Promise<void> {
  const sub = args[0];
  if (!sub || isHelp(sub)) {
    resourceHelp();
    return;
  }
  switch (sub) {
    case "list":
      await resourceList(flags, "resources");
      return;
    case "templates":
      await resourceList(flags, "templates");
      return;
    case "read":
      await resourceRead(flags, args[1]);
      return;
    default:
      throw new Error(
        `Unknown resource subcommand: "${sub}". Use: list, templates, read`,
      );
  }
}

function resourceHelp(): void {
  console.log("tool-cli resource — read-only MCP resource access\n");
  console.log("Usage:");
  console.log(
    "  tool-cli resource list [--server <name>] [--json]        List concrete resources",
  );
  console.log(
    "  tool-cli resource templates [--server <name>] [--json]   List resource templates",
  );
  console.log(
    "  tool-cli resource read [--server <name>] <uri> [--out <path>] [--meta] [--json]",
  );
  console.log("");
  console.log(
    "With no --server, list/templates query ALL connected servers, grouped by server.",
  );
  console.log(
    "read streams text to stdout; binary content requires --out. skill:// URIs are hidden from list and refused by read.",
  );
}

async function getAllServerNames(): Promise<string[]> {
  const result = (await rpcCall("listServers")) as {
    servers: { name: string }[];
  };
  return result.servers.map((s) => s.name);
}

/** Resolve the target server for single-server operations like `read`. */
async function resolveServer(explicit?: string): Promise<string> {
  if (explicit) return explicit;
  const names = await getAllServerNames();
  if (names.length === 1) return names[0];
  if (names.length === 0) throw new Error("No MCP servers connected.");
  throw new Error(
    `Multiple servers connected — specify --server <name>. Connected: ${names.join(", ")}`,
  );
}

async function resourceList(
  flags: ResourceFlags,
  kind: "resources" | "templates",
): Promise<void> {
  const method =
    kind === "templates" ? "listResourceTemplates" : "listResources";
  const label = kind === "templates" ? "resource template" : "resource";
  const servers = flags.server ? [flags.server] : await getAllServerNames();

  if (servers.length === 0) {
    if (flags.json) console.log("[]");
    else console.log("No MCP servers connected.");
    return;
  }

  type Entry = {
    server: string;
    items?: (ResourceInfo | ResourceTemplateInfo)[];
    error?: string;
  };
  const entries: Entry[] = [];
  for (const s of servers) {
    try {
      const res = (await rpcCall(method, { server: s })) as Record<
        string,
        unknown
      >;
      const items = (kind === "templates" ? res.templates : res.resources) as (
        | ResourceInfo
        | ResourceTemplateInfo
      )[];
      // Skills are a separate channel — never surface skill:// resources here.
      const visible =
        kind === "templates"
          ? items
          : items.filter(
              (i) => !((i as ResourceInfo).uri ?? "").startsWith("skill://"),
            );
      entries.push({ server: s, items: visible });
    } catch (err) {
      entries.push({
        server: s,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (flags.json) {
    const out = entries.map((e) =>
      e.error
        ? { server: e.server, error: e.error }
        : kind === "templates"
          ? { server: e.server, templates: e.items ?? [] }
          : { server: e.server, resources: e.items ?? [] },
    );
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  for (const e of entries) {
    if (e.error) {
      console.log(`${e.server} — ${e.error}`);
      continue;
    }
    const items = e.items ?? [];
    if (items.length === 0) {
      console.log(`${e.server} — no ${label}s`);
      continue;
    }
    console.log(`${e.server} — ${items.length} ${label}(s):`);
    for (const item of items) {
      const id =
        (item as ResourceInfo).uri ??
        (item as ResourceTemplateInfo).uriTemplate;
      const name = item.name ? ` (${item.name})` : "";
      const mime = item.mimeType ? ` [${item.mimeType}]` : "";
      const desc = item.description ? ` — ${item.description}` : "";
      console.log(`  ${id}${name}${mime}${desc}`);
    }
    console.log("");
  }
}

interface ContentMeta {
  uri: string;
  mimeType?: string;
  kind: "text" | "binary";
  bytes: number;
}

function contentMeta(c: ReadResourceContent): ContentMeta {
  const isText = typeof c.text === "string";
  const bytes = isText
    ? Buffer.byteLength(c.text as string, "utf-8")
    : c.blob
      ? Buffer.from(c.blob, "base64").length
      : 0;
  return {
    uri: c.uri,
    mimeType: c.mimeType,
    kind: isText ? "text" : "binary",
    bytes,
  };
}

function printResourceMeta(
  server: string,
  uri: string,
  metas: ContentMeta[],
): void {
  console.log(`${uri} (server: ${server}) — ${metas.length} content(s):`);
  for (const m of metas) {
    console.log(
      `  ${m.uri} [${m.mimeType ?? "?"}] ${m.kind}, ${m.bytes} bytes`,
    );
  }
}

/** Concatenate resource contents into raw bytes for `--out`. */
function buildResourceBuffer(contents: ReadResourceContent[]): Buffer {
  const parts: Buffer[] = [];
  const multiple = contents.length > 1;
  for (const c of contents) {
    if (typeof c.text === "string") {
      if (multiple) {
        parts.push(Buffer.from(`# ${c.uri} (${c.mimeType ?? "text"})\n`));
      }
      parts.push(Buffer.from(c.text, "utf-8"));
    } else if (c.blob) {
      parts.push(Buffer.from(c.blob, "base64"));
    }
  }
  return Buffer.concat(parts);
}

async function resourceRead(
  flags: ResourceFlags,
  positionalUri?: string,
): Promise<void> {
  const uri = positionalUri ?? flags.uri;
  if (!uri) {
    throw new Error("resource read requires a <uri> (positional or --uri)");
  }
  // Skills are a separate channel. Refuse skill:// URIs without contacting the
  // server so a non-skill context can't read skill bodies via the resource API.
  if (uri.startsWith("skill://")) {
    throw new Error(
      `refusing to read skill:// URI '${uri}': skills are a separate channel, not exposed through resources`,
    );
  }
  const server = await resolveServer(flags.server);

  const result = (await rpcCall("readResource", {
    server,
    uri,
  })) as ReadResourceResult;
  const contents = result.contents ?? [];
  const metas = contents.map(contentMeta);

  // --meta → metadata only, never the body
  if (flags.meta) {
    if (flags.json) {
      console.log(JSON.stringify({ server, uri, contents: metas }, null, 2));
    } else {
      printResourceMeta(server, uri, metas);
    }
    return;
  }

  // --out → write body to file, print a one-line summary instead of the body
  if (flags.outFile) {
    const buf = buildResourceBuffer(contents);
    writeFileSync(flags.outFile, buf);
    if (flags.json) {
      console.log(
        JSON.stringify(
          {
            server,
            uri,
            written: flags.outFile,
            bytes: buf.length,
            contents: metas,
          },
          null,
          2,
        ),
      );
    } else {
      printResourceMeta(server, uri, metas);
      console.log(`Written to: ${flags.outFile}`);
    }
    return;
  }

  // --json without --out → machine-readable result. Binary still requires
  // --out so we never stream raw bytes (even base64) as the body channel.
  if (flags.json) {
    assertNoBinaryWithoutOut(contents);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Default: stream text to stdout. Binary content REQUIRES --out.
  assertNoBinaryWithoutOut(contents);
  const multiple = contents.length > 1;
  for (const c of contents) {
    if (typeof c.text === "string") {
      if (multiple) {
        console.log(`# ${c.uri} (${c.mimeType ?? "text"})`);
      }
      console.log(c.text);
    }
  }
}

/**
 * Throw a clear error if any content is binary (a base64 blob) — binary
 * content must be saved with `--out`, never dumped to stdout.
 */
function assertNoBinaryWithoutOut(contents: ReadResourceContent[]): void {
  const binary = contents.find((c) => typeof c.text !== "string" && c.blob);
  if (!binary) return;
  const bytes = Buffer.from(binary.blob as string, "base64").length;
  throw new Error(
    `resource "${binary.uri}" is binary (${binary.mimeType ?? "application/octet-stream"}, ${bytes} bytes) — pass --out <path> to save it; refusing to write binary to stdout`,
  );
}

/** Build the output string from structured or raw content. */
function formatOutput(
  structuredContent?: Record<string, unknown>,
  content?: unknown[],
): string {
  if (structuredContent) {
    return JSON.stringify(structuredContent, null, 2);
  }
  if (content) {
    const parts: string[] = [];
    for (const item of content) {
      const entry = item as Record<string, unknown>;
      if (entry.type === "text") {
        parts.push(entry.text as string);
      } else {
        parts.push(JSON.stringify(entry, null, 2));
      }
    }
    return parts.join("\n");
  }
  return "";
}

/** Format a JSON Schema as a compact, readable summary. */
function formatSchema(schema: Record<string, unknown>): string {
  const props = schema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = (schema.required as string[]) ?? [];

  if (!props || Object.keys(props).length === 0) {
    return "  (no parameters)";
  }

  const lines: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    const type = (prop.type as string) ?? "unknown";
    const req = required.includes(name) ? ", required" : "";
    const desc = prop.description ? `: ${prop.description as string}` : "";
    lines.push(`  ${name} (${type}${req})${desc}`);
  }
  return lines.join("\n");
}

function isHelp(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

void main();
