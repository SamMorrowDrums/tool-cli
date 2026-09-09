export const BRIDGE_PROTOCOL_NAME = "tool-cli-bridge";
export const BRIDGE_PROTOCOL_MAJOR = 1;
export const BRIDGE_PROTOCOL_VERSION = "1.1";

export const SERVER_IMPLEMENTATION_NAME = "@sammorrowdrums/tool-cli";
export const SERVER_IMPLEMENTATION_VERSION = "1.0.3";

export const BRIDGE_RPC_OPERATIONS = [
  "getBridgeInfo",
  "listServers",
  "listTools",
  "describeTool",
  "callTool",
  "listResources",
  "listResourceTemplates",
  "readResource",
] as const;

export type BridgeRpcOperation = (typeof BRIDGE_RPC_OPERATIONS)[number];
export type BridgeTransport = "tcp" | "unix";

export interface UpstreamMcpSummary {
  protocolVersion?: string;
  implementation?: {
    name: string;
    version?: string;
  };
  capabilities?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface BridgeInfo {
  bridgeProtocol: {
    name: typeof BRIDGE_PROTOCOL_NAME;
    major: typeof BRIDGE_PROTOCOL_MAJOR;
    version: string;
  };
  serverImplementation: {
    name: typeof SERVER_IMPLEMENTATION_NAME;
    version: string;
  };
  operations: BridgeRpcOperation[];
  capabilities: {
    authentication: {
      required: true;
      scheme: "bearer";
    };
    tools: {
      discovery: true;
      calls: true;
      inputSchemaValidation: true;
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema";
      supportedJsonSchemaDialects: [
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2019-09/schema",
        "http://json-schema.org/draft-07/schema#",
      ];
    };
    resources: {
      list: boolean;
      templates: boolean;
      read: boolean;
    };
    cancellation: {
      providerAbortSignal: true;
    };
    transport?: {
      type: BridgeTransport;
      networkListener: boolean;
    };
  };
  upstreamMcp?: UpstreamMcpSummary;
}
