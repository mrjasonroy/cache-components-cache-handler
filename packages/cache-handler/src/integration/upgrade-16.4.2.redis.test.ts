/**
 * Upgrade from 16.4.2 against a real Redis: the Redis setups 16.4.2 documented, called exactly the
 * 16.4.2 way, and what 16.4.3 does with the values 16.4.2 left in Redis.
 *
 * - The deprecated data stack (`createCacheHandler`, `createRedisDataCacheHandler`) keeps 16.4.2's
 *   key layout and JSON format, so an entry written by 16.4.2 under the same key is read as a hit
 *   (keys collide only with a build ID that is the same across builds) and a 16.4.2 tag record
 *   still invalidates it.
 * - The page handler and `withCache`'s handlers use build-scoped keys and the binary v2 format: a
 *   16.4.2 value never sits under one of their keys in practice, and if one does it is a miss,
 *   never an error. 16.4.2's tag keys do not get in the way of their revalidations.
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis (see outage.redis.test.ts).
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createCacheHandler } from "../data-cache/factory.js";
import { createIoredisAdapter } from "../data-cache/ioredis-adapter.js";
import { createRedisDataCacheHandler } from "../data-cache/redis.js";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry, DataCacheHandler } from "../data-cache/types.js";
import { RedisCacheHandler, type RedisCacheHandlerOptions } from "../handlers/redis.js";
import { jsonReplacer } from "../helpers/serialization.js";
import { dataKey, pageKey } from "../shared/keys.js";
import { resetCacheState } from "../testing/env.js";
import type { CacheValue } from "../types.js";

const url = process.env.CACHE_TEST_REDIS_URL;

const BUILD = "upgrade-build";

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function textOf(entry: DataCacheEntry | undefined): Promise<string | undefined> {
  return entry ? new Response(entry.value).text() : undefined;
}

function dataEntry(text: string, tags: string[]): DataCacheEntry {
  return {
    value: streamOf(text),
    tags,
    stale: 300,
    timestamp: performance.timeOrigin + performance.now(),
    expire: 3600,
    revalidate: 900,
  };
}

/** What 16.4.2's `createRedisDataCacheHandler` stored under `<keyPrefix><cacheKey>`. */
function entry1642(text: string, tags: string[], timestamp: number): string {
  return JSON.stringify({
    value: Buffer.from(text).toString("base64"),
    tags,
    stale: 300,
    timestamp,
    expire: 3600,
    revalidate: 900,
  });
}

/** What 16.4.2's `RedisCacheHandler` stored under `nextjs:cache:<key>`. */
function page1642(value: CacheValue, tags: string[]): string {
  return JSON.stringify({ lastModified: Date.now(), lifespan: null, tags, value }, jsonReplacer);
}

const fetchValue = (body: string): CacheValue => ({
  kind: "FETCH",
  data: { headers: {}, body, status: 200, url: "https://example.com/api" },
  revalidate: 60,
});

/** Waits a tick, so a revalidation is strictly newer than the entries written before it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe.runIf(Boolean(url))("upgrade from 16.4.2 (real Redis)", () => {
  let prefix = "";
  let redis: Redis;
  const clients: Redis[] = [];

  /** A new process: nothing shared in memory with handlers created before it. */
  async function newProcess(): Promise<void> {
    await resetCacheState();
  }

  function client(): Redis {
    const created = new Redis(url as string);
    clients.push(created);
    return created;
  }

  /** Reads until the handler serves `expected` (the first set may land in the memory fallback). */
  async function expectHit(handler: DataCacheHandler, key: string, expected: string) {
    await expect
      .poll(async () => textOf(await handler.get(key, [])), { timeout: 5000 })
      .toBe(expected);
  }

  beforeEach(async () => {
    await resetCacheState();
    prefix = `cch-upgrade-test:${randomUUID()}:`;
    redis = client();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await resetCacheState();
    await Promise.all(clients.splice(0).map((created) => created.quit()));
  });

  describe("createCacheHandler (README quick start)", () => {
    test("stores 16.4.2's key layout and JSON, shared across processes, revalidated by tag", async () => {
      const options = {
        type: "redis",
        url,
        keyPrefix: `${prefix}cache:`,
        tagPrefix: `${prefix}tags:`,
        debug: false,
      } as const;
      const first = createCacheHandler(options);
      await expect
        .poll(async () => {
          await first.set("k", Promise.resolve(dataEntry("v1", ["t"])));
          return redis.exists(`${prefix}cache:k`);
        })
        .toBe(1);

      // The value 16.4.2 itself would read: its JSON fields, the payload base64.
      const raw = JSON.parse((await redis.get(`${prefix}cache:k`)) as string);
      expect(Object.keys(raw).sort()).toEqual(
        ["expire", "revalidate", "stale", "tags", "timestamp", "value"].sort(),
      );
      expect(Buffer.from(raw.value, "base64").toString()).toBe("v1");

      await newProcess();
      const second = createCacheHandler(options);
      await expectHit(second, "k", "v1");

      await tick();
      await second.updateTags(["t"]);
      expect(await redis.hgetall(`${prefix}tags:t`)).toMatchObject({
        stale: expect.any(String),
        expired: expect.any(String),
      });
      expect(await second.getExpiration(["t"])).toBeGreaterThan(0);
      await newProcess();
      expect(await createCacheHandler(options).get("k", [])).toBeUndefined();
    });

    test("zero config reads REDIS_URL (type redis) and VALKEY_URL (type valkey)", async () => {
      for (const [type, env] of [
        ["redis", "REDIS_URL"],
        ["valkey", "VALKEY_URL"],
      ] as const) {
        await newProcess();
        process.env[env] = url;
        const handler = createCacheHandler({ type, keyPrefix: `${prefix}${type}:` });
        await expect
          .poll(async () => {
            await handler.set("k", Promise.resolve(dataEntry(type, [])));
            return redis.exists(`${prefix}${type}:k`);
          })
          .toBe(1);
        await newProcess();
        process.env[env] = url;
        await expectHit(createCacheHandler({ type, keyPrefix: `${prefix}${type}:` }), "k", type);
      }
    });

    test("an entry 16.4.2 wrote under the same key is read as a hit, and 16.4.2 tag records apply", async () => {
      // Same key only when the build ID is the same across builds (Next puts it in the key).
      await redis.set(`${prefix}cache:old`, entry1642("from 16.4.2", ["t"], Date.now()), "EX", 600);
      const handler = createCacheHandler({
        type: "redis",
        url,
        keyPrefix: `${prefix}cache:`,
        tagPrefix: `${prefix}tags:`,
      });
      await expectHit(handler, "old", "from 16.4.2");
      expect((await handler.get("old", []))?.tags).toEqual(["t"]);

      // A revalidation 16.4.2 recorded (its hash fields) after the entry was written.
      await tick();
      const now = Date.now().toString();
      await redis.hset(`${prefix}tags:t`, "stale", now, "expired", now);
      expect(await handler.get("old", [])).toBeUndefined();
    });
  });

  test("createRedisDataCacheHandler with createIoredisAdapter (bring your own client)", async () => {
    const handler = createRedisDataCacheHandler({
      redis: createIoredisAdapter(client()),
      keyPrefix: `${prefix}cache:`,
      tagPrefix: `${prefix}tags:`,
      defaultTTL: 3600,
      debug: false,
    });
    await handler.set("k", Promise.resolve(dataEntry("byo", ["t"])));
    expect(await redis.ttl(`${prefix}cache:k`)).toBeGreaterThan(0);
    expect(await textOf(await handler.get("k", []))).toBe("byo");

    await tick();
    await handler.updateTags(["t"]);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  describe("RedisCacheHandler subclass (16.4.2 JSDoc pattern)", () => {
    const forms: [string, () => RedisCacheHandlerOptions["redis"]][] = [
      ["a URL string", () => url],
      [
        "an ioredis options object",
        () => {
          const parsed = new URL(url as string);
          return { host: parsed.hostname, port: Number(parsed.port || 6379) };
        },
      ],
      ["an ioredis client", () => client()],
    ];

    test.each(forms)(
      "redis as %s: shared across processes, revalidateTag(tag)",
      async (_n, form) => {
        const subclass = () =>
          class NextCacheHandler extends RedisCacheHandler {
            constructor(options: RedisCacheHandlerOptions) {
              super({
                ...options,
                redis: form(),
                keyPrefix: prefix,
                tagPrefix: "ignored:",
                defaultTTL: 3600,
                buildId: BUILD,
              });
            }
          };

        const A = subclass();
        // 16.4.2's set context ({ revalidate, tags }) and get meta ({ implicitTags }).
        await new A({}).set("/api", fetchValue("shared"), { revalidate: 60, tags: ["t"] });
        expect(await redis.exists(pageKey(prefix, BUILD, "/api"))).toBe(1);

        await newProcess();
        const B = subclass();
        const hit = await new B({}).get("/api", { kind: "FETCH", tags: ["t"], implicitTags: [] });
        expect(hit?.value).toEqual(fetchValue("shared"));

        await tick();
        await new B({}).revalidateTag("t");
        await newProcess();
        expect(await new (subclass())({}).get("/api", { kind: "FETCH", tags: ["t"] })).toBeNull();
      },
    );
  });

  describe("16.4.2 values left in Redis, read by the 16.4.3 handlers", () => {
    test("a 16.4.2 page entry is a miss for the page handler, under its old key or its new one", async () => {
      const handler = new RedisCacheHandler({
        client: client(),
        keyPrefix: prefix,
        buildId: BUILD,
      });
      // 16.4.2's own key: never read.
      await redis.set(`${prefix}cache:/api`, page1642(fetchValue("old"), ["t"]));
      // Forced under the key 16.4.3 reads: not v2, so a miss, never an error.
      await redis.set(pageKey(prefix, BUILD, "/api"), page1642(fetchValue("old"), ["t"]));
      await expect(handler.get("/api", { kind: "FETCH", tags: ["t"] })).resolves.toBeNull();

      // A new render replaces it.
      await handler.set("/api", fetchValue("new"), { revalidate: 60, tags: ["t"] });
      expect((await handler.get("/api", { kind: "FETCH", tags: ["t"] }))?.value).toEqual(
        fetchValue("new"),
      );
    });

    test('a 16.4.2 data entry is a miss for the "use cache: remote" handler', async () => {
      const handler = createRemoteCacheHandler({
        client: client(),
        keyPrefix: prefix,
        buildId: BUILD,
      });
      await redis.set(dataKey(prefix, BUILD, "k"), entry1642("old", ["t"], Date.now()), "EX", 600);
      await expect(handler.get("k", [])).resolves.toBeUndefined();

      await handler.set("k", Promise.resolve(dataEntry("new", ["t"])));
      expect(await textOf(await handler.get("k", []))).toBe("new");
    });

    test("16.4.2 tag keys (<prefix>tags:<tag> string and :keys set) do not break revalidation", async () => {
      // 16.4.2's RedisCacheHandler wrote these with keyPrefix "nextjs:" defaults' shape.
      await redis.set(`${prefix}tags:t`, Date.now().toString());
      await redis.sadd(`${prefix}tags:t:keys`, `${prefix}cache:/api`);

      const page = new RedisCacheHandler({ client: client(), keyPrefix: prefix, buildId: BUILD });
      const remote = createRemoteCacheHandler({
        client: client(),
        keyPrefix: prefix,
        buildId: BUILD,
      });
      await page.set("/api", fetchValue("v"), { revalidate: 60, tags: ["t"] });
      await remote.set("k", Promise.resolve(dataEntry("v", ["t"])));
      expect(await page.get("/api", { kind: "FETCH", tags: ["t"] })).not.toBeNull();
      expect(await textOf(await remote.get("k", []))).toBe("v");

      await tick();
      await page.revalidateTag(["t"]);
      await remote.updateTags(["t"]);
      expect(await page.get("/api", { kind: "FETCH", tags: ["t"] })).toBeNull();
      expect(await remote.get("k", [])).toBeUndefined();
      // Left as they were: 16.4.3 neither reads nor rewrites them.
      expect(await redis.type(`${prefix}tags:t`)).toBe("string");
      expect(await redis.type(`${prefix}tags:t:keys`)).toBe("set");
    });
  });
});
