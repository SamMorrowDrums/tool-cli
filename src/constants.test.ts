import { describe, it, expect, afterEach } from "vitest";
import {
  BIND_HOST_ENV_VAR,
  HOST_ENV_VAR,
  resolveBindHost,
  resolveHost,
} from "./constants.js";

describe("resolveBindHost", () => {
  afterEach(() => {
    delete process.env[BIND_HOST_ENV_VAR];
  });

  it("defaults to 127.0.0.1 when env unset", () => {
    delete process.env[BIND_HOST_ENV_VAR];
    expect(resolveBindHost()).toBe("127.0.0.1");
  });

  it("returns the env value when set", () => {
    process.env[BIND_HOST_ENV_VAR] = "0.0.0.0";
    expect(resolveBindHost()).toBe("0.0.0.0");
  });

  it("falls back to 127.0.0.1 when env is empty", () => {
    process.env[BIND_HOST_ENV_VAR] = "";
    expect(resolveBindHost()).toBe("127.0.0.1");
  });
});

describe("resolveHost", () => {
  afterEach(() => {
    delete process.env[HOST_ENV_VAR];
  });

  it("defaults to 127.0.0.1 when env unset", () => {
    delete process.env[HOST_ENV_VAR];
    expect(resolveHost()).toBe("127.0.0.1");
  });

  it("returns the env value when set", () => {
    process.env[HOST_ENV_VAR] = "host.docker.internal";
    expect(resolveHost()).toBe("host.docker.internal");
  });

  it("falls back to 127.0.0.1 when env is empty", () => {
    process.env[HOST_ENV_VAR] = "";
    expect(resolveHost()).toBe("127.0.0.1");
  });
});
