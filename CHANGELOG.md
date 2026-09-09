# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Added opt-in Unix-domain-socket transport through
  `ToolCliServer.startUnixSocket(socketPath)` and the client-side
  `TOOL_CLI_SOCKET` variable. A socket selector combined with an explicit TCP
  host or port is rejected before any request with a typed
  `RpcAmbiguousEndpointError`, preventing inherited credentials from silently
  selecting another session's bridge. Bearer authentication, bridge-v1
  handshakes, finite timeouts, cancellation, exact schemas, and lossless
  tool/resource output are preserved.
- Added secure socket publication and lifecycle handling: dedicated parents are
  mode `0700`, sockets are mode `0600`, only owned and verified stale sockets
  are reclaimed, unsafe traversal/symlink/foreign paths are refused, and public
  socket cleanup cannot clobber a replacement filesystem entry.
- Added Linux coverage for UDS authentication, protocol negotiation, tools,
  resources and binary output, cancellation/timeouts, endpoint ambiguity and TCP
  compatibility, permissions, concurrent sessions, stale and active sockets,
  signal/close cleanup, mount-like child paths, and actionable diagnostics.
- Documented and smoke-tested a rootless/rootful container ownership boundary:
  rootful sandboxes use the mapped non-root session UID, drop all capabilities,
  enable `no-new-privileges`, and retain `--network none`.

### Changed

- Bridge protocol metadata is now `1.1` and additively reports
  `capabilities.transport.type` plus whether the bridge created a network
  listener. The protocol major remains `1`.
- The public package change is a backward-compatible feature and therefore
  targets package version `1.1.0`. `package.json` remains at `1.0.3` until the
  coordinated release is approved.

## 1.0.3

### Documentation

- Replaced the prior themed release framing with an audited integration guide for
  `@sammorrowdrums/mcpi@0.85.0`, `@sammorrowdrums/mcpi-ext@1.0.0`, and
  `@sammorrowdrums/tool-cli@1.0.3`.
- Clarified that agents invoke tool-cli through mcpi's bash tool, that the
  authenticated bridge credentials are session-scoped, and that tool-cli is an
  MCP-to-shell on-ramp rather than the shell pipeline substrate.
- Documented bridge-v1 compatibility, output and error contracts, resource and
  binary behavior, timeouts, cancellation, and the trusted-local security
  boundary.

## 1.0.2

### Fixed

- The npm publish job now targets the protected `npm publish` GitHub
  environment required by the package's Trusted Publisher configuration while
  retaining OIDC and read-only repository permissions. v1.0.1 remains
  GitHub-only and was not published to npm because that Trusted
  Publisher/environment binding was not yet configured; v1.0.2 is the first
  npm v1 release.

## 1.0.1

### Fixed

- Package verification now accepts both the array-shaped and object-shaped
  `npm pack --dry-run --json` output used across supported npm releases, while
  still requiring exactly one valid package manifest. The v1.0.0 GitHub Release
  was created, but npm 1.0.0 was never published because npm latest exposed
  this verifier incompatibility during `prepublishOnly`.

## 1.0.0

### Breaking

- Every remote CLI command now performs the authenticated `getBridgeInfo`
  handshake and requires bridge protocol `tool-cli-bridge` major `1`. Legacy
  bridges without the handshake are intentionally incompatible; upgrade the
  CLI and embedding harness together.

### Changed

- Client failures are typed across HTTP, JSON-RPC, invalid/non-JSON responses,
  transport errors, compatibility failures, finite timeouts, and caller
  cancellation. Disconnect cancellation is propagated to tool/resource
  providers through `AbortSignal`.
- Server, tool, resource, and template discovery is deterministically sorted.
  Calls are restricted to the exact discovered tool set and validated against
  each tool's complete input schema before provider dispatch.
- JSON output preserves complete structured tool results, modern MCP content
  blocks, embedded resources, resource links, and extension fields. Resource
  discovery reports partial failures explicitly; text remains pipeable, while
  binary resource bodies require `--out` in human mode and stay lossless as
  base64 under `--json`.
- The security contract is explicit: bearer authentication protects a
  short-lived trusted-local IPC boundary, not a TLS-secured or multi-tenant
  remote API.

### Migrating from 0.x

- Deploy an embedding harness that serves authenticated bridge protocol v1,
  exposes the same policy-visible schemas it dispatches, and preserves complete
  MCP results. Then move CLI installations to the `1.x` line. There is no
  fallback to pre-handshake bridges.

## 0.6.1

### Changed

- `resource read` now **refuses `skill://` URIs** — it returns an error without
  contacting the server, so skill bodies can't be read through the generic
  resource surface. (`resource list` already hides `skill://`.)

## 0.6.0

### Changed

- `resource read` refinements:
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

- Documentation rewrite with an architecture diagram.

## 0.2.0

- Token-based authentication and dynamic port allocation for session isolation.
