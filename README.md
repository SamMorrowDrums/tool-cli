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

Three entry points, consumable independently:

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

## Implementing a Server

The `ToolProvider` interface is intentionally minimal — three methods. Here's guidance for different integration scenarios:

### MCP SDK (TypeScript/JavaScript)

If you're using `@modelcontextprotocol/sdk`, the provider wraps your `Client` instances:

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

class McpToolProvider implements ToolProvider {
  private clients = new Map<string, { client: Client; tools: ToolInfo[] }>();

  getServerNames() {
    return [...this.clients.keys()];
  }
  getTools(server) {
    return this.clients.get(server)?.tools ?? [];
  }
  async callTool(server, tool, args) {
    const { client } = this.clients.get(server)!;
    const result = await client.callTool({ name: tool, arguments: args });
    return {
      content: result.content as unknown[],
      structuredContent: result.structuredContent as
        | Record<string, unknown>
        | undefined,
    };
  }
}
```

### Other languages — implement the JSON-RPC server directly

You don't need this package to run a tool-cli compatible server. The protocol is 4 JSON-RPC methods over HTTP. Implement them in any language:

**Go:**

```go
// Skeleton — handle POST to :7179, dispatch by method
func handleRPC(w http.ResponseWriter, r *http.Request) {
    var req struct {
        Method string          `json:"method"`
        Params json.RawMessage `json:"params"`
        ID     int             `json:"id"`
    }
    json.NewDecoder(r.Body).Decode(&req)

    switch req.method {
    case "listServers":  // return { servers: [...] }
    case "listTools":    // parse server from params, return tools
    case "describeTool": // parse server+tool, return schema
    case "callTool":     // parse server+tool+arguments, call MCP, return result
    }
}
```

**Python (Flask):**

```python
from flask import Flask, request, jsonify

app = Flask(__name__)

@app.route("/", methods=["POST"])
def rpc():
    req = request.json
    method = req["method"]
    params = req.get("params", {})

    if method == "listServers":
        result = {"servers": [{"name": "my-server", "toolCount": 5, "examples": ["search"]}]}
    elif method == "listTools":
        result = {"server": params["server"], "tools": [...]}
    elif method == "describeTool":
        result = {"name": params["tool"], "description": "...", "inputSchema": {...}}
    elif method == "callTool":
        result = call_mcp_tool(params["server"], params["tool"], params.get("arguments", {}))
    else:
        return jsonify({"jsonrpc": "2.0", "error": {"code": -32601, "message": "Not found"}, "id": req["id"]})

    return jsonify({"jsonrpc": "2.0", "result": result, "id": req["id"]})

app.run(port=7179, host="127.0.0.1")
```

**Rust:**

```rust
// Use axum, actix-web, or any HTTP framework
// Parse JSON-RPC request, match on method, return JSON-RPC response
// The 4 methods map directly to your MCP client's list/describe/call operations
```

### Key implementation notes

- **Bind to `127.0.0.1` only** — the server should not be exposed to the network without authentication
- **`TOOL_CLI_PORT` env var** — honour this so the CLI can find your server on non-default ports
- **`structuredContent`** — if the MCP tool returns structured output, include it alongside `content`. The CLI prefers it for JSON piping
- **Error responses** — use JSON-RPC error codes: `-32602` for invalid params, `-32601` for unknown methods, `-32603` for internal errors
- **Tool annotations** — include `readOnlyHint`, `destructiveHint` etc. in `describeTool` responses. Future HITL gating will use these

---

## Writing Clients in Other Languages

The CLI is a convenience — the real API is JSON-RPC over HTTP, callable from any language:

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

## Security

The server uses token-based authentication and dynamic port allocation:

1. `start()` binds to a random available port and generates a 32-byte session token
2. Returns `{ port, token }` — the caller sets these as `TOOL_CLI_PORT` and `TOOL_CLI_TOKEN` env vars for agent subprocesses
3. Every request must include `Authorization: Bearer <token>` — rejected with 401 otherwise

This means:

- **Concurrent sessions** work — each gets its own port + token
- **Random processes can't call tools** — they don't have the token
- **Cross-session isolation** — one agent can't reach another's tools

### Integration with agent harnesses

The harness (e.g. mcpi-ext) wires it up:

```typescript
const { port, token } = await server.start();
// Set env vars so agent-spawned bash/tool-cli can authenticate
pi.setEnv("TOOL_CLI_PORT", String(port));
pi.setEnv("TOOL_CLI_TOKEN", token);
```

The CLI and `rpcCall()` client read both from environment automatically.

### TODO

- TLS for non-localhost deployments

See [#1](https://github.com/SamMorrowDrums/tool-cli/issues/1) for resource discovery support.

## License

MIT
