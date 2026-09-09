import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ToolCliServer } from "../dist/server-entry.js";
import { classifyDockerOwnershipModel } from "./docker-ownership-model.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.env.TOOL_CLI_DOCKER_IMAGE || "node:22";
const sessionDirectory = mkdtempSync(join(tmpdir(), "tool-cli-docker-"));
const socketPath = join(sessionDirectory, "bridge.sock");
const containerSocketPath = "/run/tool-cli/bridge.sock";

const provider = {
  getServerNames: () => ["docker-smoke"],
  getTools: () => [],
  callTool: async () => ({ content: [] }),
};

const server = new ToolCliServer(provider);

try {
  await execFileAsync("docker", ["image", "inspect", image]);
  let securityOptions;
  try {
    ({ stdout: securityOptions } = await execFileAsync(
      "docker",
      ["info", "--format", "{{json .SecurityOptions}}"],
      { encoding: "utf8" },
    ));
  } catch (error) {
    throw new Error(
      "Could not determine Docker's ownership model; refusing to select a container user",
      { cause: error },
    );
  }

  const ownershipModel = classifyDockerOwnershipModel(securityOptions);
  if (ownershipModel === "unknown") {
    throw new Error(
      "Docker returned unrecognized security options; refusing to select a container user",
    );
  }
  if (ownershipModel === "userns-remap") {
    throw new Error(
      "Docker userns-remap requires an explicit host/container UID mapping for the 0700 socket directory",
    );
  }
  const containerUser =
    ownershipModel === "rootless"
      ? "0:0"
      : `${process.getuid()}:${process.getgid()}`;

  const { token } = await server.startUnixSocket(socketPath);
  const dockerEnv = { ...process.env };
  for (const key of Object.keys(dockerEnv)) {
    if (key.startsWith("TOOL_CLI_")) delete dockerEnv[key];
  }
  dockerEnv.TOOL_CLI_TOKEN = token;

  const { stdout } = await execFileAsync(
    "docker",
    [
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      containerUser,
      "--mount",
      `type=bind,src=${sessionDirectory},dst=/run/tool-cli,readonly`,
      "--mount",
      `type=bind,src=${root},dst=/workspace,readonly`,
      "--workdir",
      "/workspace",
      "--env",
      `TOOL_CLI_SOCKET=${containerSocketPath}`,
      "--env",
      "TOOL_CLI_TOKEN",
      image,
      "node",
      "/workspace/dist/cli.js",
      "--json",
    ],
    {
      env: dockerEnv,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    },
  );

  const result = JSON.parse(stdout);
  if (
    !Array.isArray(result.servers) ||
    result.servers.length !== 1 ||
    result.servers[0]?.name !== "docker-smoke"
  ) {
    throw new Error("Container did not receive the expected bridge response");
  }
  process.stdout.write(
    `Verified UDS bridge from network-isolated ${image} container.\n`,
  );
} finally {
  await server.stop();
  rmSync(sessionDirectory, { recursive: true, force: true });
}
