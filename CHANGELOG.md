# Changelog

All notable changes to this project will be documented in this file.

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
