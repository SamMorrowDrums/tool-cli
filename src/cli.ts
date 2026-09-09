#!/usr/bin/env node

import { writeFileSync } from "node:fs";
import {
  BridgeCompatibilityError,
  RpcAbortError,
  RpcHttpError,
  RpcNonJsonResponseError,
  RpcProtocolError,
  RpcTimeoutError,
  RpcTransportError,
  getBridgeInfo,
  rpcCall,
  type RpcCallOptions,
} from "./rpc-client.js";
import { MAX_TIMEOUT_MS } from "./constants.js";
import { SERVER_IMPLEMENTATION_VERSION } from "./protocol.js";
import { formatSchema } from "./schema-summary.js";

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

interface CallToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
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

interface SerializedError {
  type: string;
  message: string;
  httpStatus?: number;
  responseBody?: string;
  contentType?: string | null;
  rpcCode?: number;
  rpcData?: unknown;
}

let activeRpcOptions: RpcCallOptions = {};

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  try {
    if (rawArgs.length === 1 && isHelp(rawArgs[0])) {
      globalHelp();
      return;
    }
    if (rawArgs.length === 1 && isVersion(rawArgs[0])) {
      console.log(SERVER_IMPLEMENTATION_VERSION);
      return;
    }

    // Extract flags (can appear anywhere). Value flags consume the next arg;
    // boolean flags stand alone. Everything else is a positional argument.
    let outFile: string | undefined;
    let serverFlag: string | undefined;
    let uriFlag: string | undefined;
    let timeoutMs: number | undefined;
    let jsonFlag = false;
    let metaFlag = false;
    const args: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
      const arg = rawArgs[i];
      if (arg === "--out") {
        outFile = requireFlagValue(rawArgs, ++i, arg);
      } else if (arg === "--server") {
        serverFlag = requireFlagValue(rawArgs, ++i, arg);
      } else if (arg === "--uri") {
        uriFlag = requireFlagValue(rawArgs, ++i, arg);
      } else if (arg === "--timeout") {
        const value = requireFlagValue(rawArgs, ++i, arg);
        timeoutMs = Number(value);
        if (
          !Number.isInteger(timeoutMs) ||
          timeoutMs <= 0 ||
          timeoutMs > MAX_TIMEOUT_MS
        ) {
          throw new Error(
            `--timeout must be an integer between 1 and ${MAX_TIMEOUT_MS}ms`,
          );
        }
      } else if (arg === "--json") {
        jsonFlag = true;
      } else if (arg === "--meta") {
        metaFlag = true;
      } else {
        args.push(arg);
      }
    }

    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    activeRpcOptions = { signal: controller.signal, timeoutMs };

    try {
      // Every remote command starts with the authenticated v1 handshake.
      await getBridgeInfo(activeRpcOptions);

      if (args.length === 0) {
        await listServers(jsonFlag);
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
        await listTools(server, jsonFlag);
        return;
      }

      const tool = args[1];

      // <server> <tool> --help or just <server> <tool> → describe tool
      if (args.length === 2 || (args.length === 3 && isHelp(args[2]))) {
        await describeTool(server, tool, jsonFlag);
        return;
      }

      // <server> <tool> <json-args> → call tool
      await callTool(server, tool, args[2], outFile, jsonFlag);
    } finally {
      process.removeListener("SIGINT", cancel);
      process.removeListener("SIGTERM", cancel);
    }
  } catch (err) {
    if (
      err instanceof RpcTransportError &&
      err.transport !== "unix" &&
      (hasErrorCode(err, "ECONNREFUSED") ||
        err.message.includes("fetch failed"))
    ) {
      console.error("Error: tool-cli server not running. Is mcpi-ext loaded?");
    } else {
      console.error(`Error: ${formatCliError(err)}`);
    }
    process.exitCode = 1;
  }
}

async function listServers(json: boolean): Promise<void> {
  const result = (await bridgeRpc("listServers")) as { servers: ServerInfo[] };
  const { servers } = result;

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

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

async function listTools(server: string, json: boolean): Promise<void> {
  const result = (await bridgeRpc("listTools", { server })) as {
    server: string;
    tools: ToolSummary[];
  };

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

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

async function describeTool(
  server: string,
  tool: string,
  json: boolean,
): Promise<void> {
  const result = (await bridgeRpc("describeTool", {
    server,
    tool,
  })) as ToolDetails;

  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

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
  json = false,
): Promise<void> {
  let toolArgs: unknown;
  try {
    toolArgs = JSON.parse(argsJson) as unknown;
  } catch {
    throw new Error(`invalid JSON arguments: ${argsJson}`);
  }

  const result = (await bridgeRpc("callTool", {
    server,
    tool,
    arguments: toolArgs,
  })) as CallToolResult;

  if (result.isError) {
    if (json) {
      console.error(JSON.stringify(result, null, 2));
    } else if (result.structuredContent !== undefined) {
      console.error(JSON.stringify(result.structuredContent, null, 2));
    } else if (result.content) {
      for (const item of result.content) {
        if (
          item !== null &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          (item as Record<string, unknown>).type === "text" &&
          typeof (item as Record<string, unknown>).text === "string"
        ) {
          console.error((item as Record<string, unknown>).text);
        } else {
          console.error(JSON.stringify(item, null, 2));
        }
      }
    }
    process.exitCode = 1;
    return;
  }

  const output = json
    ? JSON.stringify(result, null, 2)
    : formatOutput(result.structuredContent, result.content);
  if (!output) return;

  if (outFile) {
    writeFileSync(outFile, output, "utf-8");
    if (json) {
      console.log(
        JSON.stringify(
          {
            written: outFile,
            bytes: Buffer.byteLength(output, "utf8"),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Written to: ${outFile}`);
    }
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
  const result = (await bridgeRpc("listServers")) as {
    servers: { name: string }[];
  };
  return result.servers.map((s) => s.name).sort(compareNames);
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
    if (flags.json) {
      console.log(
        JSON.stringify({ kind, status: "complete", results: [] }, null, 2),
      );
    } else console.log("No MCP servers connected.");
    return;
  }

  type Entry = {
    server: string;
    items?: (ResourceInfo | ResourceTemplateInfo)[];
    error?: SerializedError;
  };
  const entries = await Promise.all(
    servers.map(async (server): Promise<Entry> => {
      try {
        const res = (await bridgeRpc(method, { server })) as Record<
          string,
          unknown
        >;
        const items = (
          kind === "templates" ? res.templates : res.resources
        ) as (ResourceInfo | ResourceTemplateInfo)[];
        // Skills are a separate channel — never surface skill:// resources here.
        const visible =
          kind === "templates"
            ? items
            : items.filter(
                (i) => !((i as ResourceInfo).uri ?? "").startsWith("skill://"),
              );
        return { server, items: visible };
      } catch (err) {
        return { server, error: serializeError(err) };
      }
    }),
  );

  const failureCount = entries.filter((entry) => entry.error).length;
  const status =
    failureCount === 0
      ? "complete"
      : failureCount === entries.length
        ? "failed"
        : "partial";

  if (flags.json) {
    const results = entries.map((entry) =>
      entry.error
        ? { server: entry.server, ok: false, error: entry.error }
        : kind === "templates"
          ? { server: entry.server, ok: true, templates: entry.items ?? [] }
          : { server: entry.server, ok: true, resources: entry.items ?? [] },
    );
    const out = { kind, status, results };
    console.log(JSON.stringify(out, null, 2));
    if (status === "failed") process.exitCode = 1;
    return;
  }

  for (const e of entries) {
    if (e.error) {
      console.error(`${e.server} — ${e.error.message}`);
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

  if (status === "partial") {
    console.error(
      `Warning: partial ${label} discovery (${failureCount}/${entries.length} server(s) failed).`,
    );
  } else if (status === "failed") {
    process.exitCode = 1;
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

  const result = (await bridgeRpc("readResource", {
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

  // --json is the lossless machine-readable form, including base64 blobs.
  if (flags.json) {
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
  structuredContent?: unknown,
  content?: unknown[],
): string {
  if (structuredContent !== undefined) {
    return JSON.stringify(structuredContent, null, 2);
  }
  if (content) {
    const parts: string[] = [];
    for (const item of content) {
      if (
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).type === "text" &&
        typeof (item as Record<string, unknown>).text === "string"
      ) {
        parts.push((item as Record<string, unknown>).text as string);
      } else {
        parts.push(JSON.stringify(item, null, 2));
      }
    }
    return parts.join("\n");
  }
  return "";
}

function globalHelp(): void {
  console.log(`tool-cli ${SERVER_IMPLEMENTATION_VERSION}`);
  console.log("");
  console.log("Usage:");
  console.log("  tool-cli [--json]                              List servers");
  console.log("  tool-cli <server> [--json]                     List tools");
  console.log(
    "  tool-cli <server> <tool> [--json]              Describe a tool",
  );
  console.log("  tool-cli <server> <tool> '<json>' [--json]     Call a tool");
  console.log(
    "  tool-cli resource <list|templates|read> ...    Access resources",
  );
  console.log("");
  console.log("Global options:");
  console.log("  -h, --help                 Show this help without connecting");
  console.log(
    "  -V, --version              Show the CLI version without connecting",
  );
  console.log(
    `  --timeout <ms>             Request timeout (1-${MAX_TIMEOUT_MS})`,
  );
  console.log("  --json                     Lossless machine-readable output");
}

function requireFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function bridgeRpc(
  method: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  return rpcCall(method, params, activeRpcOptions);
}

function serializeError(err: unknown): SerializedError {
  if (err instanceof RpcHttpError) {
    return {
      type: err.name,
      message: err.message,
      httpStatus: err.status,
      responseBody: err.body,
      contentType: err.contentType,
      ...(err.rpcCode === undefined ? {} : { rpcCode: err.rpcCode }),
      ...(err.rpcData === undefined ? {} : { rpcData: err.rpcData }),
    };
  }
  if (err instanceof RpcProtocolError) {
    return {
      type: err.name,
      message: err.message,
      httpStatus: err.httpStatus,
      rpcCode: err.code,
      ...(err.data === undefined ? {} : { rpcData: err.data }),
    };
  }
  return {
    type: err instanceof Error ? err.name : "Error",
    message: err instanceof Error ? err.message : String(err),
  };
}

function formatCliError(err: unknown): string {
  if (err instanceof RpcProtocolError) {
    const data =
      err.data === undefined ? "" : `\n${JSON.stringify(err.data, null, 2)}`;
    return `JSON-RPC ${err.code}: ${err.message}${data}`;
  }
  if (
    err instanceof RpcHttpError ||
    err instanceof RpcNonJsonResponseError ||
    err instanceof RpcTimeoutError ||
    err instanceof RpcAbortError ||
    err instanceof BridgeCompatibilityError
  ) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

function hasErrorCode(err: Error, code: string): boolean {
  let current: unknown = err;
  while (current instanceof Error) {
    if ((current as NodeJS.ErrnoException).code === code) return true;
    current = current.cause;
  }
  return false;
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isHelp(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

function isVersion(arg: string): boolean {
  return arg === "--version" || arg === "-V";
}

void main();
