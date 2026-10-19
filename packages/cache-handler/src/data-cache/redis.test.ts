import { afterEach, describe, expect, test, vi } from "vitest";
import { type RedisClient, createRedisDataCacheHandler } from "./redis.js";
import type { DataCacheEntry } from "./types.js";

class FakeRedis {
  private readonly store = new Map<string, { value: string; expireAt?: number }>();
  private readonly hashes = new Map<string, Map<string, string>>();

  public readonly setCalls: Array<{ key: string; args: unknown[] }> = [];
  public readonly delCalls: string[][] = [];
  public readonly expireCalls: Array<{ key: string; seconds: number }> = [];

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

  async expire(key: string, seconds: number): Promise<number> {
    this.expireCalls.push({ key, seconds });
    return this.hashes.has(key) || this.store.has(key) ? 1 : 0;
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

  // Next's "use cache" wrapper serves an entry past `revalidate` and refreshes it
  // in the background, up to `expire`. A persistent handler that drops the entry
  // at `revalidate` turns every later request into a blocking regeneration.
  test("serves entries past revalidate until expire (stale-while-revalidate)", async () => {
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
    if (!result) {
      throw new Error("expected the stale entry to be served until expire");
    }
    // Returned untouched: the wrapper compares timestamp + revalidate itself.
    expect(result.revalidate).toBe(60);
    expect(result.timestamp).toBe(BASE_TIME.getTime());
    expect(await readStream(result.value)).toBe("stale");
    expect(redis.delCalls).toEqual([]);
  });

  test("treats entries past expire as a miss", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    // Simulate a key whose TTL outlives `expire` (e.g. clock skew between
    // instances): the handler must still not serve an entry past `expire`.
    const serialized = JSON.stringify({
      value: Buffer.from("old").toString("base64"),
      tags: [],
      stale: 0,
      timestamp: BASE_TIME.getTime(),
      expire: 10,
      revalidate: 5,
    });
    await redis.set("nextjs:data-cache:old-key", serialized);

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 11_000));
    expect(await handler.get("old-key", [])).toBeUndefined();
  });

  test("returns a fresh stream on every get", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });
    await handler.set("k", Promise.resolve(createEntry("twice")));

    const first = await handler.get("k", []);
    const second = await handler.get("k", []);
    if (!first || !second) {
      throw new Error("expected cache entry");
    }
    expect(await readStream(first.value)).toBe("twice");
    expect(await readStream(second.value)).toBe("twice");
  });

  test("bases the key TTL on the time left until expire, measured from timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    // The render started 10s before set() ran, so 110s of the 120s are left.
    const entry = createEntry("late", {
      expire: 120,
      revalidate: 60,
      timestamp: BASE_TIME.getTime() - 10_000,
    });
    await handler.set("late-key", Promise.resolve(entry));

    expect(redis.setCalls[0].args).toEqual([{ EX: 110 }]);
  });

  test("does not store entries that are already expired (expire: 0)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    // Redis rejects `SET ... EX 0`; Next's own handler skips `expire: 0` too.
    await handler.set("dynamic", Promise.resolve(createEntry("d", { expire: 0, revalidate: 0 })));
    expect(redis.setCalls).toEqual([]);
    expect(await handler.get("dynamic", [])).toBeUndefined();
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

  test("an expiry from before the entry was cached does not delete it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    // revalidateTag("T") with no durations: stale = expired = R0.
    await handler.updateTags(["T"]);

    // Entry re-cached after R0.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 1000));
    await handler.set("k", Promise.resolve(createEntry("v", { tags: ["T"], revalidate: 600 })));

    // A stale-only revalidation (no expire) moves `stale` past the entry but leaves `expired` at R0.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 2000));
    await handler.updateTags(["T"], {});

    const result = await handler.get("k", []);
    if (!result) {
      throw new Error("expected the entry to be served stale, not deleted");
    }
    expect(result.revalidate).toBe(-1);
    expect(redis.delCalls).not.toContainEqual(["nextjs:data-cache:k"]);
  });

  test("hard-expired tag wins over a merely-stale tag in the same entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    const entry = createEntry("v1", {
      tags: ["stale-tag", "expired-tag"],
      timestamp: BASE_TIME.getTime(),
      expire: 600,
      revalidate: 300,
    });
    await handler.set("mixed-key", Promise.resolve(entry));

    vi.setSystemTime(new Date(BASE_TIME.getTime() + 10_000));
    await handler.updateTags(["stale-tag"], {}); // soft-stale only, no hard deadline
    await handler.updateTags(["expired-tag"]); // no durations -> immediate hard expiry

    const result = await handler.get("mixed-key", []);
    expect(result).toBeUndefined();
    expect(redis.delCalls).toContainEqual(["nextjs:data-cache:mixed-key"]);
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

describe("RedisDataCacheHandler cluster safety", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Redis Cluster and ElastiCache (cluster-mode enabled) shard keys across hash
  // slots and reject any command that spans more than one slot with a CROSSSLOT
  // error. The handler stays cluster-compatible only by issuing exclusively
  // single-key commands — no `del(k1, k2)`, `mget`, multi-key transactions, etc.
  // This records every command across the full handler surface (including both
  // tag-driven and TTL-driven deletion paths) and asserts none targets more than
  // one key, so a future multi-key change can't silently break cluster users.
  test("only ever issues single-key commands", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const commands: Array<{ method: string; keys: string[] }> = [];
    const backing = new FakeRedis();

    // Delegate behavior to FakeRedis; record the key(s) each command receives.
    const redis: RedisClient = {
      get: (key) => {
        commands.push({ method: "get", keys: [key] });
        return backing.get(key);
      },
      set: (key, value, ...args) => {
        commands.push({ method: "set", keys: [key] });
        return backing.set(key, value, ...args);
      },
      del: (...keys) => {
        commands.push({ method: "del", keys });
        return backing.del(...keys);
      },
      exists: (...keys) => {
        commands.push({ method: "exists", keys });
        return backing.exists(...keys);
      },
      ttl: (key) => {
        commands.push({ method: "ttl", keys: [key] });
        return backing.ttl(key);
      },
      expire: (key, seconds) => {
        commands.push({ method: "expire", keys: [key] });
        return backing.expire(key, seconds);
      },
      hGet: (key, field) => {
        commands.push({ method: "hGet", keys: [key] });
        return backing.hGet(key, field);
      },
      hSet: (key, field, value) => {
        commands.push({ method: "hSet", keys: [key] });
        return backing.hSet(key, field, value);
      },
      hGetAll: (key) => {
        commands.push({ method: "hGetAll", keys: [key] });
        return backing.hGetAll(key);
      },
    };

    const handler = createRedisDataCacheHandler({ redis });

    // Exercise the full surface, with multiple tags so multi-key ops would show.
    await handler.set(
      "k1",
      Promise.resolve(
        createEntry("v1", { tags: ["t1", "t2"], timestamp: BASE_TIME.getTime(), revalidate: 600 }),
      ),
    );
    await handler.get("k1", []); // read + per-tag hGetAll checks
    await handler.updateTags(["t1", "t2"], { expire: 100 }); // per-tag hSet
    await handler.getExpiration(["t1", "t2"]); // per-tag hGet

    // Tag-driven deletion path: revalidate a tag with immediate hard expiry, then
    // read the now-invalid entry so the handler issues del(key).
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 1000));
    await handler.updateTags(["t1"]);
    await handler.get("k1", []);

    // Stale and expired reads: past revalidate the entry is served, past expire
    // it is a miss. Neither may issue a multi-key command.
    await handler.set(
      "k2",
      Promise.resolve(
        createEntry("v2", { timestamp: BASE_TIME.getTime(), expire: 600, revalidate: 1 }),
      ),
    );
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 5000));
    await handler.get("k2", []);
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 601_000));
    await handler.get("k2", []);

    // The deletion path must have run (otherwise the assertion is vacuous), and
    // must delete exactly the one expected key.
    const delCommands = commands.filter((c) => c.method === "del");
    expect(delCommands).toEqual([{ method: "del", keys: ["nextjs:data-cache:k1"] }]);
    // Tag records are given a TTL one key at a time.
    expect(commands.some((c) => c.method === "expire")).toBe(true);
    // ...and every command issued must target exactly one key.
    const multiKey = commands.filter((c) => c.keys.length !== 1);
    expect(multiKey).toEqual([]);
  });
});

describe("RedisDataCacheHandler tag revalidation checks", () => {
  test("dispatches per-tag staleness checks concurrently, not sequentially", async () => {
    const backing = new FakeRedis();
    const tagKeys = ["nextjs:tags:t1", "nextjs:tags:t2", "nextjs:tags:t3"];
    const started: string[] = [];
    const releases: Array<() => void> = [];

    // Block hGetAll for a tag key until explicitly released, so we can
    // observe how many are in flight at once.
    const redis: RedisClient = {
      get: (key) => backing.get(key),
      set: (key, value, ...args) => backing.set(key, value, ...args),
      del: (...keys) => backing.del(...keys),
      exists: (...keys) => backing.exists(...keys),
      ttl: (key) => backing.ttl(key),
      hGet: (key, field) => backing.hGet(key, field),
      hSet: (key, field, value) => backing.hSet(key, field, value),
      hGetAll: async (key) => {
        if (!tagKeys.includes(key)) {
          return backing.hGetAll(key);
        }
        started.push(key);
        await new Promise<void>((resolve) => releases.push(resolve));
        return backing.hGetAll(key);
      },
    };

    const handler = createRedisDataCacheHandler({ redis });

    await handler.set(
      "multi-tag-key",
      Promise.resolve(createEntry("v1", { tags: ["t1", "t2", "t3"] })),
    );

    const getPromise = handler.get("multi-tag-key", []);

    // Flush microtasks so every dispatched tag lookup has had a chance to
    // start, without letting any of the blocked ones resolve.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // A sequential loop would only ever have the first tag lookup in
    // flight here, since it can't dispatch the next until this one
    // resolves. All three being in flight proves concurrent dispatch.
    expect(started.slice().sort()).toEqual(tagKeys.slice().sort());

    for (const release of releases) {
      release();
    }
    const result = await getPromise;

    if (!result) {
      throw new Error("expected cache entry");
    }
    expect(await readStream(result.value)).toBe("v1");
  });
});

describe("RedisDataCacheHandler error visibility", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function failingRedis(): RedisClient {
    const fail = () => Promise.reject(new Error("ECONNREFUSED"));
    return {
      get: fail,
      set: fail,
      del: fail,
      exists: fail,
      ttl: fail,
      expire: fail,
      hGet: fail,
      hSet: fail,
      hGetAll: fail,
    };
  }

  // A wrong REDIS_URL in production must not mean "no caching and no logs".
  test("logs Redis errors with console.error even when debug is off", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createRedisDataCacheHandler({ redis: failingRedis() });

    // get degrades to a miss instead of throwing...
    expect(await handler.get("k", [])).toBeUndefined();
    // ...and set, getExpiration and updateTags don't throw either.
    await handler.set("k", Promise.resolve(createEntry("v")));
    expect(await handler.getExpiration(["t"])).toBe(0);
    await handler.updateTags(["t"]);

    const operations = errorSpy.mock.calls.map((call) => String(call[0]));
    for (const op of ["get", "set", "getExpiration", "updateTags"]) {
      expect(operations.some((message) => message.includes(` ${op} failed`))).toBe(true);
    }
    for (const call of errorSpy.mock.calls) {
      expect(call[1]).toBeInstanceOf(Error);
    }
  });

  test("rate-limits error logs per operation so an outage cannot flood the logs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = createRedisDataCacheHandler({
      redis: failingRedis(),
      errorLogIntervalMs: 60_000,
    });

    for (let i = 0; i < 50; i++) {
      await handler.get(`k${i}`, []);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // A different operation has its own budget.
    await handler.set("k", Promise.resolve(createEntry("v")));
    expect(errorSpy).toHaveBeenCalledTimes(2);

    // After the interval, the next error is logged with a count of what was dropped.
    vi.setSystemTime(new Date(BASE_TIME.getTime() + 60_000));
    await handler.get("k", []);
    expect(errorSpy).toHaveBeenCalledTimes(3);
    expect(String(errorSpy.mock.calls[2][0])).toContain("49 similar errors suppressed");
  });

  test("does not report a failed render (rejected pendingEntry) as a Redis error", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    await handler.set("k", Promise.reject(new Error("render failed")));
    expect(redis.setCalls).toEqual([]);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe("RedisDataCacheHandler pending sets", () => {
  // types.d.ts: "If a `get` for the same cache key is called, before the pending
  // entry is complete, the cache handler must wait for the `set` operation to
  // finish, before returning the entry, instead of returning undefined."
  test("get waits for an in-flight set of the same key", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    let resolveEntry: (entry: DataCacheEntry) => void = () => {};
    const pendingEntry = new Promise<DataCacheEntry>((resolve) => {
      resolveEntry = resolve;
    });

    const setPromise = handler.set("k", pendingEntry);
    const getPromise = handler.get("k", []);

    let settled = false;
    void getPromise.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    resolveEntry(createEntry("rendered once"));
    await setPromise;
    const result = await getPromise;
    if (!result) {
      throw new Error("expected get to return the entry the pending set stored");
    }
    expect(await readStream(result.value)).toBe("rendered once");
  });

  test("a failed pending set releases waiting gets", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    const setPromise = handler.set("k", Promise.reject(new Error("render failed")));
    const result = await handler.get("k", []);
    await setPromise;
    expect(result).toBeUndefined();

    // ...and does not leave the key blocked for later readers.
    await handler.set("k", Promise.resolve(createEntry("v2")));
    const later = await handler.get("k", []);
    if (!later) {
      throw new Error("expected cache entry");
    }
    expect(await readStream(later.value)).toBe("v2");
  });

  test("does not wait on a pending set for a different key", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    void handler.set("slow", new Promise<DataCacheEntry>(() => {}));
    expect(await handler.get("other", [])).toBeUndefined();
  });
});

describe("RedisDataCacheHandler tag record expiry", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("gives every revalidated tag record a TTL", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, tagTTL: 1000 });

    await handler.updateTags(["a", "b"], { expire: 60 });
    await handler.updateTags(["c"]);

    expect(redis.expireCalls).toEqual([
      { key: "nextjs:tags:a", seconds: 1000 },
      { key: "nextjs:tags:b", seconds: 1000 },
      { key: "nextjs:tags:c", seconds: 1000 },
    ]);
  });

  test("defaults the tag TTL to longer than cacheLife('max')", async () => {
    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis });

    await handler.updateTags(["a"]);
    // cacheLife("max") has expire = 365 days; the default must exceed it.
    expect(redis.expireCalls[0].seconds).toBeGreaterThan(365 * 24 * 60 * 60);
  });

  // A tag record must outlive every entry it can invalidate, or a pre-revalidation
  // entry would be served as fresh after the record disappears. Capping entry
  // lifetimes at tagTTL (measured from the entry's timestamp, which precedes any
  // revalidation that affects it) guarantees that.
  test("caps entry key TTLs at tagTTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);

    const redis = new FakeRedis();
    const handler = createRedisDataCacheHandler({ redis, tagTTL: 1000, defaultTTL: 5000 });

    await handler.set("long", Promise.resolve(createEntry("v", { expire: 2000 })));
    await handler.set("infinite", Promise.resolve(createEntry("v", { expire: 4294967294 })));

    expect(redis.setCalls.map((call) => call.args)).toEqual([[{ EX: 1000 }], [{ EX: 1000 }]]);
  });

  test("warns once when the client cannot set a TTL on tag records", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const backing = new FakeRedis();
    const redis: RedisClient = {
      get: (key) => backing.get(key),
      set: (key, value, ...args) => backing.set(key, value, ...args),
      del: (...keys) => backing.del(...keys),
      exists: (...keys) => backing.exists(...keys),
      ttl: (key) => backing.ttl(key),
      hGet: (key, field) => backing.hGet(key, field),
      hSet: (key, field, value) => backing.hSet(key, field, value),
      hGetAll: (key) => backing.hGetAll(key),
    };
    const handler = createRedisDataCacheHandler({ redis });

    await handler.updateTags(["a"]);
    await handler.updateTags(["b"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
