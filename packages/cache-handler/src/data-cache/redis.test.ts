import { afterEach, describe, expect, test, vi } from "vitest";
import { createRedisDataCacheHandler } from "./redis.js";
import type { DataCacheEntry } from "./types.js";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expireAt?: number }>();
  private readonly hashes = new Map<string, Map<string, string>>();

  public readonly setCalls: Array<{ key: string; args: unknown[] }> = [];
  public readonly delCalls: string[][] = [];

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }

    if (entry.expireAt && entry.expireAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }

    return entry.value;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<unknown> {
    this.setCalls.push({ key, args });

    let expireAt: number | undefined;
    // node-redis style: set(key, value, { EX: seconds })
    const opts = args[0] as { EX?: number } | undefined;
    if (opts && typeof opts === "object" && typeof opts.EX === "number") {
      expireAt = Date.now() + opts.EX * 1000;
    }

    this.store.set(key, { value, expireAt });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.delCalls.push(keys);
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async exists(...keys: string[]): Promise<number> {
    return keys.reduce((count, key) => count + (this.store.has(key) ? 1 : 0), 0);
  }

  async ttl(key: string): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) {
      return -2;
    }

    if (!entry.expireAt) {
      return -1;
    }

    const ttlMs = entry.expireAt - Date.now();
    return ttlMs > 0 ? Math.ceil(ttlMs / 1000) : -2;
  }

  async hGet(key: string, field: string): Promise<string | null> {
    const hash = this.hashes.get(key);
    return hash?.get(field) ?? null;
  }

  async hSet(key: string, field: string, value: string): Promise<unknown> {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    hash.set(field, value);
    return 1;
  }

  async hGetAll(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    if (!hash) {
      return {};
    }
    return Object.fromEntries(hash.entries());
  }
}

function createEntry(content: string, overrides: Partial<DataCacheEntry> = {}): DataCacheEntry {
  return {
    value: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    }),
    tags: [],
    stale: 0,
    timestamp: Date.now(),
    expire: 60,
    revalidate: 30,
    ...overrides,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((len, chunk) => len + chunk.byteLength, 0);
  const merged = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

const BASE_TIME = new Date("2024-02-02T10:00:00.000Z");

describe("RedisDataCacheHandler", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("stores and retrieves entries with serialized buffers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, defaultTTL: 600 });

    const entry = createEntry("hello world", { tags: ["tag-a"], expire: 120, revalidate: 60 });
    await handler.set("cache-key", Promise.resolve(entry));

    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0]).toMatchObject({
      key: "nextjs:data-cache:cache-key",
      args: [{ EX: 120 }],
    });

    const result = await handler.get("cache-key", []);
    if (!result) {
      throw new Error("expected cache entry");
    }
    expect(result.tags).toEqual(["tag-a"]);
    expect(result.revalidate).toBe(60);
    expect(await readStream(result.value)).toBe("hello world");
  });

  test("returns undefined and deletes entries that exceed revalidate window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, defaultTTL: 600 });

    const entry = createEntry("stale", {
      expire: 600,
      revalidate: 60,
      timestamp: BASE_TIME.getTime(),
    });
    await handler.set("stale-key", Promise.resolve(entry));

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 61_000));

    const result = await handler.get("stale-key", []);
    expect(result).toBeUndefined();
    expect(redis.delCalls).toContainEqual(["nextjs:data-cache:stale-key"]);
  });

  test("marks entries as stale when tags update without expiration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    const entry = createEntry("tagged", {
      tags: ["article-1"],
      expire: 600,
      revalidate: 120,
      timestamp: BASE_TIME.getTime(),
    });
    await handler.set("tagged-key", Promise.resolve(entry));

    // Advance time so tag updates post-date the entry
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 5_000));
    await handler.updateTags(["article-1"], {});

    const result = await handler.get("tagged-key", []);
    if (!result) {
      throw new Error("expected cache entry");
    }
    expect(result.revalidate).toBe(-1);
    expect(await readStream(result.value)).toBe("tagged");
    expect(redis.delCalls).not.toContainEqual(["nextjs:data-cache:tagged-key"]);
  });

  test("invalidates entries immediately when tag is revalidated without durations", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    const entry = createEntry("invalidate", {
      tags: ["tag-expire"],
      timestamp: BASE_TIME.getTime(),
      expire: 600,
      revalidate: 300,
    });
    await handler.set("invalidate-key", Promise.resolve(entry));

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 10_000));
    await handler.updateTags(["tag-expire"]);

    const result = await handler.get("invalidate-key", []);
    expect(result).toBeUndefined();
    expect(redis.delCalls).toContainEqual(["nextjs:data-cache:invalidate-key"]);
  });

  test("sets TTL correctly with node-redis style options (fixes #16)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, defaultTTL: 300 });

    const entry = createEntry("ttl-test", { expire: 60, revalidate: 30 });
    await handler.set("ttl-key", Promise.resolve(entry));

    // Verify the set call used node-redis style: { EX: seconds }
    expect(redis.setCalls).toHaveLength(1);
    const setCall = redis.setCalls[0];
    expect(setCall.key).toBe("nextjs:data-cache:ttl-key");
    expect(setCall.args).toEqual([{ EX: 60 }]);
  });

  test("TTL causes entry to expire after specified time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    const entry = createEntry("expiring", {
      expire: 10, // 10 second TTL
      revalidate: 5,
      timestamp: BASE_TIME.getTime(),
    });
    await handler.set("expiring-key", Promise.resolve(entry));

    // Should exist immediately
    const resultBefore = await handler.get("expiring-key", []);
    expect(resultBefore).toBeDefined();

    // Advance past TTL
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 11_000));

    // Should be gone due to Redis TTL expiration (simulated in FakeRedis)
    const resultAfter = await handler.get("expiring-key", []);
    expect(resultAfter).toBeUndefined();
  });

  test("uses defaultTTL when entry expire is MAX_SAFE_INTEGER", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, defaultTTL: 3600 });

    // Entry with very large expire (effectively no expiration from entry)
    const entry = createEntry("default-ttl", { expire: 4294967294, revalidate: 60 });
    await handler.set("default-ttl-key", Promise.resolve(entry));

    expect(redis.setCalls).toHaveLength(1);
    expect(redis.setCalls[0].args).toEqual([{ EX: 3600 }]);
  });

  // ISSUE-1 (implementation/ISSUES.md): a tag invalidated with a future expire —
  // what `revalidateTag(tag, "max")` triggers — must still allow re-caching. The
  // invalidation only affects entries created *before* the revalidation event.
  test("re-caches a tag after revalidateTag with a future expire (fixes ISSUE-1)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, defaultTTL: 86400 });

    // Entry cached before the revalidation.
    await handler.set("k1", Promise.resolve(createEntry("v1", { tags: ["T"], revalidate: 600 })));

    // Simulate revalidateTag("T", "max") -> a far-future expire window.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 1000));
    await handler.updateTags(["T"], { expire: 31_536_000 });

    // A new entry written AFTER the revalidation must be cacheable and served.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 2000));
    await handler.set("k2", Promise.resolve(createEntry("v2", { tags: ["T"], revalidate: 600 })));
    const fresh = await handler.get("k2", []);
    if (!fresh) {
      throw new Error("expected the re-cached entry to be served");
    }
    expect(await readStream(fresh.value)).toBe("v2");

    // The pre-existing entry is served stale (revalidate = -1) within the window,
    // not hard-deleted.
    const stale = await handler.get("k1", []);
    if (!stale) {
      throw new Error("expected the pre-existing entry to be served stale");
    }
    expect(stale.revalidate).toBe(-1);
  });

  test("getExpiration returns the latest revalidation event timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    expect(await handler.getExpiration(["T"])).toBe(0);

    // The event timestamp is "now", not now + expire.
    await handler.updateTags(["T"], { expire: 100 });
    expect(await handler.getExpiration(["T"])).toBe(BASE_TIME.getTime());
  });
});
