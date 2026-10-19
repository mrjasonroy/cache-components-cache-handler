import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MEMORY_ONLY_TAG } from "../shared/runtime.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { REFRESH_TAGS_INTERVAL_MS, createRemoteCacheHandler } from "./remote.js";
import { INFINITE_CACHE } from "./stored-entry.js";
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

  test("an infinite expire is kept 24 h; an expired entry is not stored", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("x", { expire: INFINITE_CACHE }));
    expect(fake.ttlOf(KEY)).toBe(86_400);
    await handler.set("gone", entry("x", { expire: 0 }));
    expect(await fake.exists("nextjs:b1:data:gone")).toBe(0);
  });

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

  test("MEMORY_ONLY_TAG keeps the entry in process memory", async () => {
    const fake = new FakeRedis();
    const handler = createRemoteCacheHandler({ client: asClient(fake), buildId: "b1" });
    await handler.set("k", entry("x", { tags: [MEMORY_ONLY_TAG] }));
    expect(await fake.exists(KEY)).toBe(0);
    expect(await read(await handler.get("k", []))).toBe("x");
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
});
