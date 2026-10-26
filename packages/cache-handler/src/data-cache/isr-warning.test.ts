import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const fakeRedis = vi.hoisted(() =>
  vi.fn(() => ({
    status: "connecting",
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    sendCommand: vi.fn(),
    quit: vi.fn(async () => "OK"),
    disconnect: vi.fn(),
  })),
);

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("../shared/node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName === "ioredis") {
      return fakeRedis;
    }
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

import { RedisCacheHandler } from "../handlers/redis.js";
import { closeAllRedisConnections } from "../shared/connection.js";
import { resetCacheRuntimesForTests } from "../shared/runtime.js";
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

  afterEach(async () => {
    warn.mockRestore();
    vi.unstubAllEnvs();
    await closeAllRedisConnections();
    resetCacheRuntimesForTests();
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
    test("redis-family handlers warn once in production, at first use", () => {
      vi.stubEnv("NODE_ENV", "production");

      const handlers = [
        createCacheHandler({ type: "redis" }),
        createCacheHandler({ type: "valkey" }),
        createCacheHandler({ type: "elasticache", endpoint: "cache.example.com" }),
      ];
      expect(warn).not.toHaveBeenCalled();

      for (const handler of handlers) void handler.refreshTags();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(ISR_WARNING_MESSAGE);
    });

    test("does not warn once the package's page handler exists in the process", () => {
      vi.stubEnv("NODE_ENV", "production");

      const handler = createCacheHandler({ type: "redis" });
      // Next constructs the page handler per request, after loading cacheHandlers.
      new RedisCacheHandler({ url: "redis://localhost:6379" });
      void handler.refreshTags();

      expect(warn).not.toHaveBeenCalled();
    });

    test("memory handler never warns", () => {
      vi.stubEnv("NODE_ENV", "production");

      void createCacheHandler({ type: "memory" }).refreshTags();

      expect(warn).not.toHaveBeenCalled();
    });

    test("suppressIsrWarning option silences the factory warning", () => {
      vi.stubEnv("NODE_ENV", "production");

      void createCacheHandler({ type: "redis", suppressIsrWarning: true }).refreshTags();

      expect(warn).not.toHaveBeenCalled();
    });

    test("does not warn during next build", () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("NEXT_PHASE", "phase-production-build");

      void createCacheHandler({ type: "redis" }).refreshTags();

      expect(warn).not.toHaveBeenCalled();
    });

    test("does not warn outside production", () => {
      vi.stubEnv("NODE_ENV", "test");

      void createCacheHandler({ type: "redis" }).refreshTags();

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
