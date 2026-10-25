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
import { readHeapLimit } from "./memory-budget.js";
import {
  type RuntimeStores,
  acquireCacheRuntime,
  bufferToStream,
  getCacheRuntime,
  resolveConnection,
  resolveMemoryStoreCaps,
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
    process.env.CACHE_MEMORY_MAX_MIB = "98";
    const { stores } = getCacheRuntime();
    const MiB = 1024 * 1024;
    for (const [name, caps] of Object.entries(resolveMemoryStoreCaps())) {
      const store = stores[name as keyof RuntimeStores];
      expect(store.maxBytes, name).toBe(caps.maxBytes);
      const writes = Math.ceil((2 * caps.maxBytes) / MiB);
      for (let i = 0; i < writes; i++) store.set(`${name}:${i}`, [], MiB, null);
      expect(store.byteSize, name).toBeLessThanOrEqual(caps.maxBytes);
      expect(store.byteSize, name).toBeGreaterThan(caps.maxBytes - 2 * MiB);
    }
  });

  test("the stores share 10% of the heap limit by default, split by ratio, summing to <= it", () => {
    const { stores } = getCacheRuntime();
    const budget = Math.floor(((readHeapLimit() ?? 0) * 10) / 100);
    const caps = Object.values(stores).map((store) => store.maxBytes);
    expect(caps.reduce((sum, cap) => sum + cap, 0)).toBeLessThanOrEqual(budget);
    expect(stores.local.maxBytes).toBe(Math.floor((budget * 32) / 98));
    expect(stores.entryTags.maxBytes).toBe(Math.floor((budget * 2) / 98));
    expect(stores.page.maxBytes).toBe(Math.floor((budget * 16) / 98));
    expect(stores.local.maxEntries).toBe(10_000);
    expect(stores.entryTags.maxEntries).toBe(10_000);
  });

  test("the budget is read once, when the runtime is created", () => {
    process.env.CACHE_MEMORY_MAX_MIB = "49";
    const runtime = getCacheRuntime();
    process.env.CACHE_MEMORY_MAX_MIB = "980";
    expect(getCacheRuntime()).toBe(runtime);
    expect(runtime.stores.local.maxBytes).toBe(16 * 1024 * 1024);
  });

  test("an invalid CACHE_MEMORY_* value fails runtime creation, before a connection opens", () => {
    process.env.CACHE_MEMORY_HEAP_PERCENT = "150";
    expect(() => getCacheRuntime()).toThrow("CACHE_MEMORY_HEAP_PERCENT");
    process.env.REDIS_URL = "redis://cache:6379";
    expect(() => acquireCacheRuntime()).toThrow("CACHE_MEMORY_HEAP_PERCENT");
    expect(ioredisMock).not.toHaveBeenCalled();
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
