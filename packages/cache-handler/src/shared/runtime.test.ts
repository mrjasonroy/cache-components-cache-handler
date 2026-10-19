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
import { bufferToStream, getCacheRuntime, resolveConnection, streamToBuffer } from "./runtime.js";

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

  test("reconnecting drops the outage fallback stores", () => {
    const fake = new FakeRedis();
    const runtime = getCacheRuntime({ client: asClient(fake) });
    runtime.stores.pageFallback.set("a", 1, 1, null);
    runtime.stores.dataFallback.set("b", 1, 1, null);
    fake.goDown();
    fake.comeUp();
    expect(runtime.stores.pageFallback.size + runtime.stores.dataFallback.size).toBe(0);
  });

  test("stream helpers round-trip bytes", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect([...(await streamToBuffer(bufferToStream(bytes)))]).toEqual([1, 2, 3]);
  });
});
