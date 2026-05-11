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

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Extract --out <file> flag (can appear anywhere)
  let outFile: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--out" && i + 1 < rawArgs.length) {
      outFile = rawArgs[++i];
    } else {
      args.push(rawArgs[i]);
    }
  }

  try {
    // No args or --help → list servers
    if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
      await listServers();
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
