import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ioredisMock = vi.hoisted(() => vi.fn());

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("../shared/node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName === "ioredis") return ioredisMock;
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

import { encodeEntry } from "../shared/codec.js";
import { MAX_ENTRY_AGE_SECONDS } from "../shared/keys.js";
import { getCacheRuntime } from "../shared/runtime.js";
import { REFRESH_TAGS_INTERVAL_MS } from "../shared/tag-store.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { createRemoteCacheHandler } from "./remote.js";
import { INFINITE_CACHE, type StoredDataEntry } from "./stored-entry.js";
import type { DataCacheEntry } from "./types.js";

function entry(text: string, overrides: Partial<DataCacheEntry> = {}): Promise<DataCacheEntry> {
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
    ...overrides,
  });
}

async function read(result: DataCacheEntry | undefined): Promise<string | undefined> {
  return result ? new Response(result.value).text() : undefined;
}

const KEY = "nextjs:b1:data:k";

function storedEntry(text: string): StoredDataEntry {
  return {
    value: new TextEncoder().encode(text),
    tags: [],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  };
}

describe("createRemoteCacheHandler", () => {
  beforeEach(async () => {
    await resetCacheState();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("stores the binary entry under <prefix><buildId>:data: with TTL = expire", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("hello"));
    expect((await fake.getBuffer(KEY))?.subarray(0, 3).toString("latin1")).toBe("NCH");
    expect(fake.ttlOf(KEY)).toBe(300);

    const result = await handler.get("k", []);
    expect(await read(result)).toBe("hello");
    expect(result).toMatchObject({ tags: ["products"], stale: 30, expire: 300, revalidate: 60 });
  });

  test("an entry of 16 KB or more is stored compressed (v3) and read back", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    const text = Array.from({ length: 4000 }, (_, i) => `row ${i % 50} of the listing`).join("\n");
    await handler.set("k", entry(text));

    const stored = await fake.getBuffer(KEY);
    expect(stored?.subarray(0, 3).toString("latin1")).toBe("NCH");
    expect(stored?.[3]).toBe(3);
    expect(stored?.length).toBeLessThan(text.length / 4);

    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const reader = createRemoteCacheHandler({
      client: asClient(new FakeRedis(fake.items)),
      buildId: "b1",
      debug: true,
    });
    expect(await read(await reader.get("k", []))).toBe(text);
    // CACHE_DEBUG shows the value's size and the compressed size in Redis.
    expect(debug).toHaveBeenCalledWith("[RemoteCache]:", "get", "k", "hit", {
      bytes: text.length,
      encodedBytes: stored?.length,
    });
  });

  test("CACHE_COMPRESSION=off stores v2, and a small entry is v2 either way", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("small", entry("hello"));
    expect((await fake.getBuffer("nextjs:b1:data:small"))?.[3]).toBe(2);

    process.env.CACHE_COMPRESSION = "off";
    const text = "x".repeat(64 * 1024);
    await handler.set("k", entry(text));
    expect((await fake.getBuffer(KEY))?.[3]).toBe(2);
    expect(await read(await handler.get("k", []))).toBe(text);
  });

  test("an infinite expire is kept 24 h; an expired entry is not stored", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("x", { expire: INFINITE_CACHE }));
    expect(fake.ttlOf(KEY)).toBe(86_400);
    await handler.set("gone", entry("x", { expire: 0 }));
    expect(await fake.exists("nextjs:b1:data:gone")).toBe(0);
  });

  test("defaultTTL sets how long an infinite expire is kept, capped at the longest entry age", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({
      client: asClient(fake),
      buildId: "b1",
      defaultTTL: 600,
    });
    await handler.set("k", entry("x", { expire: INFINITE_CACHE }));
    expect(fake.ttlOf(KEY)).toBe(600);
    // A finite expire is the entry's own; defaultTTL does not change it.
    await handler.set("finite", entry("x", { expire: 300 }));
    expect(fake.ttlOf("nextjs:b1:data:finite")).toBe(300);

    const capped = createRemoteCacheHandler({
      client: asClient(fake),
      buildId: "b1",
      defaultTTL: 10 * MAX_ENTRY_AGE_SECONDS,
    });
    await capped.set("long", entry("x", { expire: INFINITE_CACHE }));
    expect(fake.ttlOf("nextjs:b1:data:long")).toBe(MAX_ENTRY_AGE_SECONDS);
  });

  test.each([Number.NaN, 0, -60, Number.POSITIVE_INFINITY, "600" as unknown as number])(
    "defaultTTL %s is refused when the handler is created",
    (defaultTTL) => {
      expect(() => createRemoteCacheHandler({ buildId: "b1", defaultTTL })).toThrow(
        /defaultTTL must be a finite number of seconds greater than 0/,
      );
    },
  );

  test("a failed render is not stored", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", Promise.reject(new Error("render failed")));
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("updateTags: immediate expiry, or stale (revalidate -1) until expire", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const handler = createRemoteCacheHandler({ client: asClient(new FakeRedis()), buildId: "b1" });
    await handler.set("k", entry("x"));
    vi.setSystemTime(Date.now() + 10);

    await handler.updateTags(["products"], { expire: 60 });
    expect((await handler.get("k", []))?.revalidate).toBe(-1);
    expect(await handler.getExpiration(["products"])).toBe(Date.now());

    vi.setSystemTime(Date.now() + 61_000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("a revalidation on one instance reaches another after refreshTags", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shared = new FakeRedis();
    const a = createRemoteCacheHandler({ client: asClient(shared), buildId: "b1" });
    const b = createRemoteCacheHandler({
      client: asClient(new FakeRedis(shared.items)),
      buildId: "b1",
    });
    await a.set("k", entry("x"));
    expect(await read(await b.get("k", []))).toBe("x");

    vi.setSystemTime(Date.now() + 10);
    await a.updateTags(["products"]);
    expect(await b.getExpiration(["products"])).toBe(0);

    vi.setSystemTime(Date.now() + REFRESH_TAGS_INTERVAL_MS);
    await b.refreshTags();
    expect(await b.getExpiration(["products"])).toBe(Date.now() - REFRESH_TAGS_INTERVAL_MS);
    expect(await b.get("k", [])).toBeUndefined();
  });

  test("with Redis every entry goes to Redis: no tag keeps one in memory", async () => {
    // 16.4.3 release candidates had a `cache:memory-only` tag; it is an ordinary tag now.
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    const { stores } = getCacheRuntime({ client: asClient(fake) });
    await handler.set("k", entry("x", { tags: ["cache:memory-only"] }));
    expect(await fake.exists(KEY)).toBe(1);
    expect(await read(await handler.get("k", []))).toBe("x");
    expect(stores.data.size).toBe(0);
    expect(stores.dataFallback.size).toBe(0);
  });

  test("with Redis a get reads Redis, never the in-memory data store", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    const { stores } = getCacheRuntime({ client: asClient(fake) });
    const seeded = { stored: storedEntry("seeded"), until: Date.now() + 60_000 };
    stores.data.set("k", seeded, 6, null);
    expect(await handler.get("k", [])).toBeUndefined();

    await handler.set("k", entry("redis"));
    stores.data.set("k", seeded, 6, null);
    expect(await read(await handler.get("k", []))).toBe("redis");
  });

  test("during an outage only the fallback store is written and served", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    const { stores } = getCacheRuntime({ client: asClient(fake) });
    stores.data.set(
      "seeded",
      { stored: storedEntry("seeded"), until: Date.now() + 60_000 },
      6,
      null,
    );
    fake.goDown();
    await handler.set("k", entry("during"));
    expect(stores.dataFallback.size).toBe(1);
    expect(stores.data.size).toBe(1);
    expect(await read(await handler.get("k", []))).toBe("during");
    expect(await handler.get("seeded", [])).toBeUndefined();
  });

  test("CACHE_REDIS=off with REDIS_URL set: round-trips in memory, never connects", async () => {
    process.env.CACHE_REDIS = "off";
    process.env.REDIS_URL = "redis://cache:6379";
    const handler = createRemoteCacheHandler({ buildId: "b1" });
    await handler.set("k", entry("off"));
    expect(await read(await handler.get("k", []))).toBe("off");
    expect(getCacheRuntime().stores.data.size).toBe(1);
    expect(ioredisMock).not.toHaveBeenCalled();
  });

  test("outage: memory fallback for at most 60 s, dropped on reconnect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    fake.goDown();
    await handler.set("k", entry("during"));
    expect(await read(await handler.get("k", []))).toBe("during");
    vi.setSystemTime(Date.now() + 61_000);
    expect(await handler.get("k", [])).toBeUndefined();

    await handler.set("k", entry("again"));
    fake.comeUp();
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("memoryFallback: false misses during an outage", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({
      client: asClient(fake),
      buildId: "b1",
      memoryFallback: false,
    });
    fake.goDown();
    await handler.set("k", entry("during"));
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("a Redis error on get is a reported miss", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("x"));
    fake.failWith = new Error("boom");
    expect(await handler.get("k", [])).toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });

  test("without Redis it is a memory cache", async () => {
    const handler = createRemoteCacheHandler({ buildId: "b1" });
    await handler.set("k", entry("mem"));
    expect(await read(await handler.get("k", []))).toBe("mem");
  });

  test("a get waits for an in-flight set of the same key", async () => {
    const handler = createRemoteCacheHandler({ client: asClient(new FakeRedis()), buildId: "b1" });
    const set = handler.set("k", entry("x"));
    const got = handler.get("k", []);
    await set;
    expect(await read(await got)).toBe("x");
  });

  test("an entry is never kept or served past the longest entry age", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const days = 86_400;
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("x", { revalidate: 400 * days, expire: 500 * days }));
    expect(fake.ttlOf(KEY)).toBe(MAX_ENTRY_AGE_SECONDS);

    // An entry written with a longer TTL (an older version) is still not served past it.
    await fake.set(
      KEY,
      encodeEntry({
        value: new TextEncoder().encode("old"),
        tags: ["products"],
        stale: 30,
        timestamp: Date.now(),
        expire: 500 * days,
        revalidate: 400 * days,
      }),
      "EX",
      500 * days,
    );
    vi.setSystemTime(Date.now() + MAX_ENTRY_AGE_SECONDS * 1000 - 1_000);
    expect(await read(await handler.get("k", []))).toBe("old");
    vi.setSystemTime(Date.now() + 1_000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("memory entries are capped at the longest entry age too", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const days = 86_400;
    const handler = createRemoteCacheHandler({ buildId: "b1" });
    await handler.set("k", entry("x", { revalidate: 400 * days, expire: 500 * days }));
    vi.setSystemTime(Date.now() + MAX_ENTRY_AGE_SECONDS * 1000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("a revalidation on another instance is seen without refreshTags; a tag-read error is a miss", async () => {
    const shared = new FakeRedis();
    const a = createRemoteCacheHandler({ client: asClient(shared), buildId: "b1" });
    const reader = new FakeRedis(shared.items);
    const b = createRemoteCacheHandler({ client: asClient(reader), buildId: "b1" });
    await a.set("k", entry("x"));
    expect(await read(await b.get("k", []))).toBe("x");

    // b's tag sync is skipped or failing; its next get still reads the tag records.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await a.updateTags(["products"]);
    expect(await b.get("k", [])).toBeUndefined();

    await a.set("k2", entry("y", { tags: ["other"] }));
    vi.spyOn(reader, "hmget").mockRejectedValueOnce(new Error("MOVED"));
    expect(await b.get("k2", [])).toBeUndefined();
    expect(await read(await b.get("k2", []))).toBe("y");
  });

  test("soft tag records are read with the entry, for getExpiration", async () => {
    const shared = new FakeRedis();
    const a = createRemoteCacheHandler({ client: asClient(shared), buildId: "b1" });
    const b = createRemoteCacheHandler({
      client: asClient(new FakeRedis(shared.items)),
      buildId: "b1",
    });
    await a.set("k", entry("x"));
    await a.updateTags(["_N_T_/shop"]);
    await b.get("k", ["_N_T_/shop"]);
    expect(await b.getExpiration(["_N_T_/shop"])).toBeGreaterThan(0);
  });
});
