# tool-cli

> **Experimental.** CLI and server for progressive MCP tool discovery via JSON-RPC. Part of the [mcpi-ext](https://github.com/SamMorrowDrums/mcpi-ext) experiment.

```sh
npm install -g @sammorrowdrums/tool-cli
```

## Usage

`tool-cli` speaks JSON-RPC 2.0 to a server running on `localhost:7179`. Discovery is progressive — each step pays only the tokens it needs:

```sh
tool-cli                                     # List connected MCP servers
tool-cli github                              # List tools on a server
tool-cli github search_code                  # Show schema for a tool
tool-cli github search_code '{"query":"auth"}' # Call a tool
```

### Shell composability

```sh
tool-cli github search_code '{"query":"auth"}' | jq '.items[].path'

tool-cli myserver list_items '{}' | jq -r '.[0].id' | \
  xargs -I{} tool-cli myserver get_item '{"id":"{}"}'

for city in London Tokyo Paris; do
  echo "=== $city ==="
  tool-cli weather check_weather '{"city":"'"$city"'"}'
done

tool-cli github list_issues '{"repo":"owner/repo"}' --out /tmp/issues.json
```

Errors go to stderr with exit code 1 — safe for `&&` chaining and `set -e` scripts.

---

## Package Structure

The package has three entry points that can be consumed independently:

```typescript
// Everything (server + client + types)
import { ToolCliServer, rpcCall } from "@sammorrowdrums/tool-cli";

// Server only — for building a harness that serves tool-cli requests
import { ToolCliServer } from "@sammorrowdrums/tool-cli/server";
import type { ToolProvider } from "@sammorrowdrums/tool-cli/server";

// Client only — for calling a running tool-cli server programmatically
import { rpcCall } from "@sammorrowdrums/tool-cli/client";
```

---

## ToolProvider Interface

The server takes a **`ToolProvider`** — a simple interface anyone can implement to bridge tool-cli to their MCP client, agent harness, or tool registry.

```typescript
import { ToolCliServer } from "@sammorrowdrums/tool-cli/server";
import type { ToolProvider } from "@sammorrowdrums/tool-cli/server";

const provider: ToolProvider = {
  getServerNames() {
    return ["my-server"];
  },
  getTools(server) {
    return [
      {
        name: "search",
        description: "Search documents",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
  },
  async callTool(server, tool, args) {
    const result = await myMcpClient.callTool(server, tool, args);
    return { content: result.content };
  },
};

const server = new ToolCliServer(provider);
await server.start();
// tool-cli CLI and any JSON-RPC client can now talk to it
```

The full interface:

```typescript
interface ToolProvider {
  getServerNames(): string[];
  getTools(server: string): ToolInfo[];
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

interface ToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface CallToolResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}
```

---

## Writing Clients in Other Languages

The JSON-RPC interface is language-agnostic. Any HTTP client can talk to the server:

```python
import requests

def tool_cli(method, **params):
    r = requests.post("http://127.0.0.1:7179", json={
        "jsonrpc": "2.0", "method": method, "params": params, "id": 1
    })
    result = r.json()
    if "error" in result:
        raise Exception(result["error"]["message"])
    return result["result"]

servers = tool_cli("listServers")
tools = tool_cli("listTools", server="github")
result = tool_cli("callTool", server="github", tool="get_me", arguments={})
```

---

## JSON-RPC Protocol

The server listens at `http://127.0.0.1:7179` (override with `TOOL_CLI_PORT` env var).

| Method         | Params                        | Returns                                                           |
| -------------- | ----------------------------- | ----------------------------------------------------------------- |
| `listServers`  | —                             | `{ servers: [{ name, toolCount, examples }] }`                    |
| `listTools`    | `{ server }`                  | `{ server, tools: [{ name, description, hasStructuredOutput }] }` |
| `describeTool` | `{ server, tool }`            | `{ name, description, inputSchema, outputSchema?, annotations? }` |
| `callTool`     | `{ server, tool, arguments }` | `{ content, isError?, structuredContent? }`                       |

---

## Security (TODO)

Currently no authentication — the server accepts any request from localhost. Future work:

- Shared secret token (e.g. via `TOOL_CLI_TOKEN` env var)
- Dynamic port allocation with port file
- TLS for non-localhost deployments

## License

MIT
