import { describe, it, expect, afterEach } from "vitest";
import {
  BIND_HOST_ENV_VAR,
  DEFAULT_TIMEOUT_MS,
  HOST_ENV_VAR,
  MAX_TIMEOUT_MS,
  SOCKET_ENV_VAR,
  TIMEOUT_ENV_VAR,
  resolveBindHost,
  resolveHost,
  resolveSocketPath,
  resolveTimeoutMs,
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

  describe("resolveSocketPath", () => {
    afterEach(() => {
      delete process.env[SOCKET_ENV_VAR];
    });

    it("returns undefined when unset or empty", () => {
      delete process.env[SOCKET_ENV_VAR];
      expect(resolveSocketPath()).toBeUndefined();
      process.env[SOCKET_ENV_VAR] = "";
      expect(resolveSocketPath()).toBeUndefined();
    });

    it("returns the configured Unix socket path", () => {
      process.env[SOCKET_ENV_VAR] = "/run/user/1000/tool-cli/bridge.sock";
      expect(resolveSocketPath()).toBe("/run/user/1000/tool-cli/bridge.sock");
    });
  });

  describe("resolveTimeoutMs", () => {
    afterEach(() => {
      delete process.env[TIMEOUT_ENV_VAR];
    });

    it("uses a finite default", () => {
      expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    });

    it("accepts an in-range explicit timeout", () => {
      expect(resolveTimeoutMs(250)).toBe(250);
    });

    it("rejects unbounded or invalid explicit timeouts", () => {
      expect(() => resolveTimeoutMs(0)).toThrow(RangeError);
      expect(() => resolveTimeoutMs(MAX_TIMEOUT_MS + 1)).toThrow(RangeError);
      expect(() => resolveTimeoutMs(Number.POSITIVE_INFINITY)).toThrow(
        RangeError,
      );
    });

    it("uses a valid environment timeout and ignores invalid values", () => {
      process.env[TIMEOUT_ENV_VAR] = "1500";
      expect(resolveTimeoutMs()).toBe(1500);

      process.env[TIMEOUT_ENV_VAR] = "unbounded";
      expect(resolveTimeoutMs()).toBe(DEFAULT_TIMEOUT_MS);
    });
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
