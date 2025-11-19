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
    if (args[0] === "EX" && typeof args[1] === "number") {
      expireAt = Date.now() + args[1] * 1000;
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
      args: ["EX", 120],
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
});
