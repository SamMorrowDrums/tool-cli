import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const changelog = readFileSync(resolve(root, "CHANGELOG.md"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
);

describe("published documentation", () => {
  it("pins the audited mcpi integration versions", () => {
    expect(readme).toContain("@sammorrowdrums/mcpi@0.85.0");
    expect(readme).toContain("@sammorrowdrums/mcpi-ext@1.0.0");
    expect(readme).toContain(`@sammorrowdrums/tool-cli@${packageJson.version}`);
    expect(readme).not.toContain("@latest");
  });

  it("links absolute current and pinned mcpi-ext quick starts", () => {
    expect(readme).toContain(
      "https://github.com/SamMorrowDrums/mcpi-ext#quick-start",
    );
    expect(readme).toContain(
      "https://github.com/SamMorrowDrums/mcpi-ext/blob/v1.0.0/README.md#quick-start",
    );
  });

  it("documents the actual invocation and local metadata commands", () => {
    expect(readme).toContain(
      "the agent invokes `tool-cli` **through mcpi's `bash` tool**",
    );
    expect(readme).toContain("tool-cli --help");
    expect(readme).toContain("tool-cli --version");
    expect(readme).toContain("MCP-to-shell on-ramp");
    expect(readme).toContain("pipeline substrate");
    expect(readme).toMatch(/unrelated\s+terminal/);
  });

  it("documents secure Unix socket transport without changing the package version", () => {
    expect(readme).toContain("TOOL_CLI_SOCKET");
    expect(readme).toContain("0700");
    expect(readme).toContain("0600");
    expect(readme).toMatch(/no TCP\s+listener/);
    expect(readme).toMatch(/socket.+token|token.+socket/is);
    expect(readme).toContain("DAC_OVERRIDE");
    expect(readme).toContain("--cap-drop ALL");
    expect(readme).toContain("no-new-privileges");
    expect(readme).toContain("apply to **every ancestor**");
    expect(readme).toContain("/tmp/tool-cli");
    expect(readme).toContain("mkdtemp()");
    expect(changelog).toContain("1.1.0");
    expect(packageJson.version).toBe("1.0.3");
  });

  it("keeps stale release framing out of published docs", () => {
    const publishedDocs = `${readme}\n${changelog}`;
    for (const stale of [
      /\bexperimental\b/i,
      /nuclear[- ]football/i,
      /\bfootball\b/i,
      /\bpersona\b/i,
      /story framing/i,
      /\bbriefcase\b/i,
      /goes rogue/i,
      /after a 1\.x package is available/i,
      /still unreleased/i,
    ]) {
      expect(publishedDocs).not.toMatch(stale);
    }
  });
});
