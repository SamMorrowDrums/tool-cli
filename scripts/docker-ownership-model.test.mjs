import { describe, expect, it } from "vitest";
import { classifyDockerOwnershipModel } from "./docker-ownership-model.mjs";

describe("Docker ownership model detection", () => {
  it("recognizes exact rootless and userns-remap option names", () => {
    expect(
      classifyDockerOwnershipModel(
        JSON.stringify([
          "name=seccomp,profile=builtin",
          "name=rootless",
          "name=userns",
          "name=cgroupns",
        ]),
      ),
    ).toBe("rootless");
    expect(
      classifyDockerOwnershipModel(
        JSON.stringify(["name=seccomp,profile=builtin", "name=userns"]),
      ),
    ).toBe("userns-remap");
  });

  it("does not infer rootless mode from another option's profile", () => {
    expect(
      classifyDockerOwnershipModel(
        JSON.stringify([
          "name=apparmor,profile=/etc/rootless-notes",
          "name=seccomp,profile=builtin",
        ]),
      ),
    ).toBe("rootful");
  });

  it.each([
    ["empty output", ""],
    ["invalid JSON", "not-json"],
    ["empty options", "[]"],
    ["non-array JSON", "{}"],
    ["malformed option", JSON.stringify(["rootless"])],
    ["non-string option", JSON.stringify(["name=seccomp", null])],
  ])("fails closed for %s", (_description, securityOptions) => {
    expect(classifyDockerOwnershipModel(securityOptions)).toBe("unknown");
  });
});
