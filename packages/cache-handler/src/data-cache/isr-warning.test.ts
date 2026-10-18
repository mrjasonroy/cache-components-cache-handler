import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fakeRedis = vi.hoisted(() =>
  vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    on: vi.fn(),
  })),
);

vi.mock("node:module", () => ({
  createRequire: () => (moduleName: string) => {
    if (moduleName === "ioredis") {
      return fakeRedis;
    }
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

import { createCacheHandler } from "./factory.js";
import {
  ISR_WARNING_MESSAGE,
  resetIsrWarningForTests,
  warnMissingIsrHandlerOnce,
} from "./isr-warning.js";

describe("ISR handler warning", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetIsrWarningForTests();
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    vi.unstubAllEnvs();
  });

  test("warns once per process in production", () => {
    vi.stubEnv("NODE_ENV", "production");

    warnMissingIsrHandlerOnce();
    warnMissingIsrHandlerOnce();
    warnMissingIsrHandlerOnce({});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(ISR_WARNING_MESSAGE);
  });

  test.each(["development", "test"])("does not warn when NODE_ENV is %s", (env) => {
    vi.stubEnv("NODE_ENV", env);

    warnMissingIsrHandlerOnce();

    expect(warn).not.toHaveBeenCalled();
  });

  test("suppressIsrWarning opts out", () => {
    vi.stubEnv("NODE_ENV", "production");

    warnMissingIsrHandlerOnce({ suppressIsrWarning: true });

    expect(warn).not.toHaveBeenCalled();
  });

  test("an opted-out call does not use up the one-time warning", () => {
    vi.stubEnv("NODE_ENV", "production");

    warnMissingIsrHandlerOnce({ suppressIsrWarning: true });
    warnMissingIsrHandlerOnce();

    expect(warn).toHaveBeenCalledTimes(1);
  });

  describe("via createCacheHandler", () => {
    test("redis-family handlers warn once in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      createCacheHandler({ type: "redis" });
      createCacheHandler({ type: "valkey" });
      createCacheHandler({ type: "elasticache", endpoint: "cache.example.com" });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(ISR_WARNING_MESSAGE);
    });

    test("memory handler never warns", () => {
      vi.stubEnv("NODE_ENV", "production");

      createCacheHandler({ type: "memory" });

      expect(warn).not.toHaveBeenCalled();
    });

    test("suppressIsrWarning option silences the factory warning", () => {
      vi.stubEnv("NODE_ENV", "production");

      createCacheHandler({ type: "redis", suppressIsrWarning: true });

      expect(warn).not.toHaveBeenCalled();
    });

    test("does not warn outside production", () => {
      vi.stubEnv("NODE_ENV", "test");

      createCacheHandler({ type: "redis" });

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
