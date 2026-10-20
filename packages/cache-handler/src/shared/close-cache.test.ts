/**
 * `closeCache()`: close the package's own Redis connections and drop its in-process state, so a
 * test runner, script or custom server can exit; handlers created before reconnect on next use.
 * That a process then exits is checked for real in flush-exit.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  created: [] as FakeRedis[],
}));

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => {
  const { FakeRedis: Fake } = await import("../testing/fake-redis.js");
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
      return function Redis() {
        const client = new Fake(redis.items);
        vi.spyOn(client, "quit");
        redis.created.push(client);
        return client;
      };
    },
  };
});

import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import { RedisCacheHandler } from "../handlers/redis.js";
import { closeCache } from "../index.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { getCacheRuntime } from "./runtime.js";

const url = "redis://close-test:6379";
const options = { url, keyPrefix: "app:", buildId: "b1" };

function entry(text: string): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    tags: ["products"],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

async function read(result: DataCacheEntry | undefined): Promise<string | undefined> {
  return result ? new Response(result.value).text() : undefined;
}

function runtimes(): Map<string, unknown> {
  return (globalThis as unknown as Record<symbol, Map<string, unknown>>)[
    Symbol.for("@mrjasonroy/cache-components-cache-handler/runtimes")
  ];
}

describe("closeCache", () => {
  beforeEach(async () => {
    await resetCacheState();
    redis.items = new Map();
    redis.created = [];
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("quits the package's own client once, however often it is called", async () => {
    getCacheRuntime(options);
    expect(redis.created).toHaveLength(1);

    await Promise.all([closeCache(), closeCache()]);
    await closeCache();
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
    expect(runtimes().size).toBe(0);
  });

  test("a closeCache that joins one in progress also closes a connection opened meanwhile", async () => {
    getCacheRuntime(options);
    const first = closeCache();
    // A cache call during the close opens a new connection, which a later closeCache closes.
    getCacheRuntime(options);
    await Promise.all([first, closeCache()]);
    expect(redis.created).toHaveLength(2);
    expect(redis.created.map((client) => vi.mocked(client.quit).mock.calls.length)).toEqual([1, 1]);
    expect(runtimes().size).toBe(0);

    // Opened once the first close has quit its connection, and before it resolves.
    getCacheRuntime(options);
    const third = closeCache();
    await vi.waitFor(() => expect(redis.created[2].quit).toHaveBeenCalled());
    getCacheRuntime(options);
    await Promise.all([third, closeCache()]);
    expect(redis.created).toHaveLength(4);
    expect(redis.created.map((client) => vi.mocked(client.quit).mock.calls.length)).toEqual([
      1, 1, 1, 1,
    ]);
  });

  test("empties the memory stores", async () => {
    const runtime = getCacheRuntime({ keyPrefix: "app:" });
    runtime.stores.local.set("a", 1, 1, null);
    await closeCache();
    expect(runtime.stores.local.size).toBe(0);
  });

  test("never closes a client the application passed in, and its handlers keep working", async () => {
    const client = new FakeRedis();
    vi.spyOn(client, "quit");
    vi.spyOn(client, "disconnect");
    const handler = createRemoteCacheHandler({ client: asClient(client), buildId: "b1" });
    await closeCache();

    expect(client.quit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
    await handler.set("k", entry("still here"));
    expect(await read(await handler.get("k", []))).toBe("still here");
  });

  test("handlers created before reconnect on next use, onto one new connection and tag state", async () => {
    const data = createRemoteCacheHandler(options);
    const page = new RedisCacheHandler(options);
    await data.set("k", entry("before"));
    expect(redis.created).toHaveLength(1);

    await closeCache();
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);

    // Both handlers come back on one fresh client, not the closed one and not memory.
    await data.set("k", entry("after"));
    await page.set("/p", { kind: "APP_ROUTE", body: Buffer.from("x"), headers: {}, status: 200 }, {
      cacheControl: { revalidate: 60 },
    } as never);
    expect(redis.created).toHaveLength(2);
    expect(redis.created[1].commands.length).toBeGreaterThan(0);
    expect(await read(await data.get("k", []))).toBe("after");

    // One runtime, so a revalidation through either handler reaches the other in process.
    expect(runtimes().size).toBe(1);
    // A revalidation in the same millisecond as the entry is not newer than it (as in Next).
    await new Promise((resolve) => setTimeout(resolve, 2));
    await page.revalidateTag("products");
    expect(await data.get("k", [])).toBeUndefined();
  });

  test("the deprecated RedisCacheHandler.close() closes the cache the same way", async () => {
    const page = new RedisCacheHandler(options);
    createRemoteCacheHandler(options);
    await page.close();
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
    expect(runtimes().size).toBe(0);
  });
});
