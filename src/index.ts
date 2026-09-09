// Re-export everything for convenience
export { BridgeRpcError, ToolCliServer } from "./server.js";
export { UnixSocketPathError } from "./unix-socket.js";
export type {
  ServerInfo,
  ToolSummary,
  ToolDetails,
  StartResult,
} from "./server.js";
export type {
  ToolProvider,
  ToolInfo,
  CallToolResult,
  ProviderRequestContext,
} from "./provider.js";
export type {
  ResourceInfo,
  ResourceTemplateInfo,
  ReadResourceContent,
  ReadResourceResult,
} from "./provider.js";
export {
  BridgeCompatibilityError,
  RpcAbortError,
  RpcHttpError,
  RpcInvalidResponseError,
  RpcNonJsonResponseError,
  RpcProtocolError,
  RpcTimeoutError,
  RpcTransportError,
  assertCompatibleBridge,
  getBridgeInfo,
  rpcCall,
} from "./rpc-client.js";
export type { RpcCallOptions } from "./rpc-client.js";
export {
  BRIDGE_PROTOCOL_MAJOR,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_RPC_OPERATIONS,
  SERVER_IMPLEMENTATION_NAME,
  SERVER_IMPLEMENTATION_VERSION,
} from "./protocol.js";
export type {
  BridgeInfo,
  BridgeRpcOperation,
  BridgeTransport,
  UpstreamMcpSummary,
} from "./protocol.js";
export {
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  PORT_ENV_VAR,
  SOCKET_ENV_VAR,
  TIMEOUT_ENV_VAR,
  TOKEN_ENV_VAR,
  resolvePort,
  resolveSocketPath,
  resolveTimeoutMs,
  resolveToken,
  generateToken,
} from "./constants.js";
