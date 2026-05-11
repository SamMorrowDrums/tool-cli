# tool-cli

> **Experimental.** A thin CLI for progressive MCP tool discovery via JSON-RPC. Part of the [mcpi-ext](https://github.com/SamMorrowDrums/mcpi-ext) experiment.

```sh
npm install -g @sammorrowdrums/tool-cli
```

## Usage

`tool-cli` speaks JSON-RPC 2.0 to an MCP tool harness (like [mcpi-ext](https://github.com/SamMorrowDrums/mcpi-ext)) running on `localhost:7179`. Discovery is progressive — each step pays only the tokens it needs:

```sh
tool-cli                                     # List connected MCP servers
tool-cli github                              # List tools on a server
tool-cli github search_code                  # Show schema for a tool
tool-cli github search_code '{"query":"auth"}' # Call a tool
```

### Shell composability

Because it's a plain CLI, it composes with pipes, grep, jq, loops:

```sh
# Search and filter
tool-cli github search_code '{"query":"auth"}' | jq '.items[].path'

# Chain tool calls
tool-cli myserver list_items '{}' | jq -r '.[0].id' | \
  xargs -I{} tool-cli myserver get_item '{"id":"{}"}'

# Process collections
for city in London Tokyo Paris; do
  echo "=== $city ==="
  tool-cli weather check_weather '{"city":"'"$city"'"}'
done

# Save large output to file
tool-cli github list_issues '{"repo":"owner/repo"}' --out /tmp/issues.json
```

Errors go to stderr with exit code 1 — safe for `&&` chaining and `set -e` scripts.

## JSON-RPC Interface

The CLI communicates with a JSON-RPC 2.0 server at `http://127.0.0.1:7179` (override with `TOOL_CLI_PORT` env var).

### Methods

| Method         | Params                        | Returns                                                           |
| -------------- | ----------------------------- | ----------------------------------------------------------------- |
| `listServers`  | —                             | `{ servers: [{ name, toolCount, examples }] }`                    |
| `listTools`    | `{ server }`                  | `{ server, tools: [{ name, description, hasStructuredOutput }] }` |
| `describeTool` | `{ server, tool }`            | `{ name, description, inputSchema, outputSchema?, annotations? }` |
| `callTool`     | `{ server, tool, arguments }` | `{ content, isError?, structuredContent? }`                       |

### Example request

```json
{
  "jsonrpc": "2.0",
  "method": "callTool",
  "params": {
    "server": "github",
    "tool": "get_me",
    "arguments": {}
  },
  "id": 1
}
```

## Security (TODO)

Currently no authentication — the RPC server accepts any request from localhost. This is acceptable for local development but not a finished security posture. Future work:

- Shared secret token (e.g. via `TOOL_CLI_TOKEN` env var)
- Dynamic port allocation with port file
- TLS for non-localhost deployments

## How it fits together

`tool-cli` is the client half. The server half (`ToolCliRpcServer`) runs inside the agent extension ([mcpi-ext](https://github.com/SamMorrowDrums/mcpi-ext)) and bridges JSON-RPC calls to actual MCP server connections.

```
Agent (mcpi)
  │
  │  shell exec
  ▼
tool-cli <server> <tool> '{"args"}'
  │
  │  HTTP JSON-RPC (localhost:7179)
  ▼
ToolCliRpcServer (in mcpi-ext)
  │
  │  MCP protocol (stdio/HTTP)
  ▼
MCP Server(s)
```

## License

MIT
CLI for progressive MCP tool discovery via JSON-RPC. Companion to mcpi-ext.
