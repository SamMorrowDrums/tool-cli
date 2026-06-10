# Changelog

All notable changes to this project will be documented in this file.

## 0.6.0

### Changed

- `resource read` refinements (the resource feature from 0.5.0 is still unreleased — this supersedes it):
  - The resource URI is now a **positional** argument: `tool-cli resource read [--server <name>] <uri> [--out <path>]`. `--uri <uri>` is still accepted as an alias.
  - **Binary content now requires `--out`.** Reading a base64 `blob` without `--out` is a hard error (exit 1, message on stderr) — tool-cli refuses to write raw binary to stdout. Text still streams to stdout by default (pipeable/greppable).
  - `resource list` now **hides `skill://` URIs** — skills are a separate channel.

## 0.5.0

### Added

- First-class **MCP resource support**, fully multi-server ([#1](https://github.com/SamMorrowDrums/tool-cli/issues/1)).
  - New optional `ToolProvider` methods — `listResources()`, `listResourceTemplates()`, `readResource()` — thin, faithful mappings of MCP `resources/list`, `resources/templates/list`, and `resources/read`. New exported types: `ResourceInfo`, `ResourceTemplateInfo`, `ReadResourceContent`, `ReadResourceResult`.
  - New JSON-RPC methods `listResources`, `listResourceTemplates`, `readResource`, mirroring how `callTool` is wired. Providers that don't implement a resource method get a structured, friendly "does not support resources" error.
  - New CLI `resource` subcommand group:
    - `tool-cli resource list [--server <name>] [--json]`
    - `tool-cli resource templates [--server <name>] [--json]`
    - `tool-cli resource read --server <name> --uri <uri> [--out <path>] [--meta] [--json]`
  - With no `--server`, `list`/`templates` query all connected servers, grouped by server. `read` defaults to the sole server when only one is connected, and requires `--server` (listing the connected names) when multiple are connected.
  - Binary `blob` content is never dumped to stdout — `read` prints metadata and directs you to `--out`, which writes the base64-decoded raw bytes. `--out` for text prints a one-line summary instead of the body, paralleling `--out` for large tool results.

### Notes

- Purely additive and backward-compatible — the new provider methods are optional, so existing tools-only providers keep compiling and working unchanged. Existing tool grammar (`tool-cli <server> <tool> …`) is untouched.
- `resource` is a reserved subcommand word; a server literally named `resource` is unsupported (acceptable for this project's use).

## 0.4.0

### Added

- `TOOL_CLI_BIND_HOST` env var (server) — overrides the host the JSON-RPC server binds to. Defaults to `127.0.0.1`. Set to `0.0.0.0` (or a specific interface) when the client lives in a different network namespace, e.g. a docker-sandboxed agent reaching a server on the host.
- `TOOL_CLI_HOST` env var (client) — overrides the host `rpcCall()` and the CLI connect to. Defaults to `127.0.0.1`. Set to e.g. `host.docker.internal` when the server is reachable at a non-loopback address.
- New helpers `resolveBindHost()` and `resolveHost()` exported from `constants.ts`.

### Notes

- Pure additive change — defaults are preserved. Existing local users who don't set either env var see identical behaviour.
- The bearer-token auth model is unchanged; every request still requires `Authorization: Bearer <TOOL_CLI_TOKEN>`. Binding to a non-loopback interface widens reachability, not the auth model — sandbox the surrounding network appropriately.

## 0.3.0

- Documentation rewrite (nuclear-football framing, architecture diagram).

## 0.2.0

- Token-based authentication and dynamic port allocation for session isolation.
