/**
 * Connection tuning (`connectTimeout`, `socketTimeout`, `maxConsecutiveTimeouts`) is a
 * `CacheOptions` field: every factory takes it, and the same tuning given to several handlers
 * keeps them on one connection.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const redis = vi.hoisted(() => ({ args: [] as unknown[][] }));

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => {
  const { FakeRedis } = await import("../testing/fake-redis.js");
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
      return function Redis(...args: unknown[]) {
        redis.args.push(args);
        return new FakeRedis();
      };
    },
  };
});

import { createCacheHandler } from "../data-cache/factory.js";
import { createLocalCacheHandler } from "../data-cache/local.js";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import { RedisCacheHandler } from "../handlers/redis.js";
import { resetCacheState } from "../testing/env.js";
import { type CacheOptions, getCacheRuntime } from "./runtime.js";

const tuned: CacheOptions = {
  url: "redis://tuned:6379",
  connectTimeout: 5000,
  socketTimeout: 3000,
  maxConsecutiveTimeouts: 5,
};

describe("connection tuning through every factory", () => {
  beforeEach(async () => {
    await resetCacheState();
    redis.args = [];
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("the same tuning through every factory shares one tuned connection", () => {
    createRemoteCacheHandler(tuned);
    createLocalCacheHandler(tuned);
    new RedisCacheHandler(tuned);
    createCacheHandler({ type: "redis", ...tuned });

    expect(redis.args).toHaveLength(1);
    expect(redis.args[0][1]).toMatchObject({ connectTimeout: 5000, socketTimeout: 3000 });
    expect(console.warn).not.toHaveBeenCalled();
    expect(getCacheRuntime(tuned).connection).toBeDefined();
    expect(redis.args).toHaveLength(1);
  });
});
