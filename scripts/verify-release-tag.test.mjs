import { spawnSync } from "node:child_process";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(
  new URL("./verify-release-tag.mjs", import.meta.url),
);
const cleanEnv = { ...process.env };
delete cleanEnv.RELEASE_TAG;

function runGuard(tag) {
  return spawnSync(process.execPath, [scriptPath, tag], {
    encoding: "utf8",
    env: cleanEnv,
  });
}

describe("release tag guard", () => {
  it("accepts the v1.0.3 tag for the 1.0.3 package", () => {
    const result = runGuard("v1.0.3");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Verified release tag v1.0.3 matches package version 1.0.3.",
    );
    expect(result.stderr).toBe("");
  });

  it("rejects a tag that does not exactly match package.json", () => {
    const result = runGuard("v1.0.2");

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("release tag v1.0.2 does not match v1.0.3");
  });
});
