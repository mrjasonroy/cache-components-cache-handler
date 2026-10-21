import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ioredisMock = vi.hoisted(() => vi.fn());

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName === "ioredis") return ioredisMock;
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import {
  MEMORY_STORE_CAPS,
  type RuntimeStores,
  bufferToStream,
  getCacheRuntime,
  resolveConnection,
  streamToBuffer,
} from "./runtime.js";

describe("cache runtime", () => {
  beforeEach(async () => {
    await resetCacheState();
    ioredisMock.mockReset();
    ioredisMock.mockImplementation(() => new FakeRedis());
  });

  afterEach(resetCacheState);

  test("handlers on the same connection and prefix share one runtime", () => {
    process.env.REDIS_URL = "redis://cache:6379";
    const a = getCacheRuntime({});
    const b = getCacheRuntime({});
    expect(a).toBe(b);
    expect(ioredisMock).toHaveBeenCalledTimes(1);
    expect(getCacheRuntime({ keyPrefix: "other:" })).not.toBe(a);
    expect(getCacheRuntime({ keyPrefix: "other:" }).connection).toBe(a.connection);
  });

  test("next build never connects, even with REDIS_URL or a client", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.REDIS_URL = "redis://cache:6379";
    expect(resolveConnection({})).toBeUndefined();
    expect(resolveConnection({ client: asClient(new FakeRedis()) })).toBeUndefined();
    expect(ioredisMock).not.toHaveBeenCalled();
  });

  test("CACHE_REDIS=off never connects", () => {
    process.env.CACHE_REDIS = "off";
    process.env.REDIS_URL = "redis://cache:6379";
    expect(getCacheRuntime({}).connection).toBeUndefined();
    expect(ioredisMock).not.toHaveBeenCalled();
  });

  test("no URL: memory only", () => {
    expect(getCacheRuntime({}).connection).toBeUndefined();
  });

  test("CACHE_KEY_PREFIX is the default prefix", () => {
    process.env.CACHE_KEY_PREFIX = "shop:";
    expect(getCacheRuntime({}).keyPrefix).toBe("shop:");
  });

  test("every in-process store stays within its byte cap when filled past it", () => {
    const { stores } = getCacheRuntime();
    const MiB = 1024 * 1024;
    for (const [name, caps] of Object.entries(MEMORY_STORE_CAPS)) {
      const store = stores[name as keyof RuntimeStores];
      const writes = Math.ceil((2 * caps.maxBytes) / MiB);
      for (let i = 0; i < writes; i++) store.set(`${name}:${i}`, [], MiB, null);
      expect(store.byteSize, name).toBeLessThanOrEqual(caps.maxBytes);
      expect(store.byteSize, name).toBeGreaterThan(caps.maxBytes - 2 * MiB);
    }
  });

  test("in-process caps: under 100 MiB in all, under 40 MiB for what fills with Redis healthy", () => {
    const MiB = 1024 * 1024;
    const caps = Object.values(MEMORY_STORE_CAPS).map((cap) => cap.maxBytes);
    expect(caps.reduce((sum, cap) => sum + cap, 0)).toBeLessThan(100 * MiB);
    // Without MEMORY_ONLY_TAG entries, only these fill while Redis is up.
    expect(MEMORY_STORE_CAPS.local.maxBytes + MEMORY_STORE_CAPS.entryTags.maxBytes).toBeLessThan(
      40 * MiB,
    );
  });

  test("reconnecting drops the outage fallback stores", () => {
    const fake = new FakeRedis();
    const runtime = getCacheRuntime({ client: asClient(fake) });
    runtime.stores.pageFallback.set("a", 1, 1, null);
    runtime.stores.dataFallback.set("b", 1, 1, null);
    fake.goDown();
    fake.comeUp();
    expect(runtime.stores.pageFallback.size + runtime.stores.dataFallback.size).toBe(0);
  });

  test("connectTimeout, socketTimeout and maxConsecutiveTimeouts reach the connection", () => {
    process.env.REDIS_URL = "redis://cache:6379";
    const tuning = { connectTimeout: 1111, socketTimeout: 2222, maxConsecutiveTimeouts: 1 };
    resolveConnection(tuning);
    expect(ioredisMock).toHaveBeenLastCalledWith(
      "redis://cache:6379",
      expect.objectContaining({ connectTimeout: 1111, socketTimeout: 2222 }),
    );

    // 16.4.2's `redis: RedisOptions` path.
    resolveConnection({ ...tuning, connectTimeout: 3333, redisOptions: { host: "cache" } });
    expect(ioredisMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ host: "cache", connectTimeout: 3333, socketTimeout: 2222 }),
    );
  });

  test("stream helpers round-trip bytes", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect([...(await streamToBuffer(bufferToStream(bytes)))]).toEqual([1, 2, 3]);
  });
});
