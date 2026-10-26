/**
 * Upgrade from 16.4.2: every value 16.4.2 exported is still exported from the package entry, and
 * the setups its README, docs and example app documented still work when called the 16.4.2 way.
 * Redis-backed cases are in integration/upgrade-16.4.2.redis.test.ts; the types are checked in
 * upgrade-16.4.2.test-d.ts. The inventory is implementation/upgrade-16.4.2.md.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as pkg from "./index.js";
import { resetCacheState } from "./testing/env.js";

/**
 * Every runtime export of 16.4.2's `src/index.ts` (`git show v16.4.2:packages/cache-handler/src/index.ts`),
 * with its `typeof`. Classes are functions.
 */
const EXPORTS_16_4_2 = {
  CompositeHandler: "function",
  createCompositeHandler: "function",
  createMemoryCacheHandler: "function",
  MemoryCacheHandler: "function",
  RedisCacheHandler: "function",
  bufferToString: "function",
  stringToBuffer: "function",
  isImplicitTag: "function",
  jsonReplacer: "function",
  jsonReviver: "function",
  calculateLifespan: "function",
  isExpired: "function",
  createCacheConfig: "function",
  createCacheConfigWithProfiles: "function",
  IMPLICIT_TAG_PREFIX: "string",
  createCacheHandler: "function",
  createMemoryDataCacheHandler: "function",
  createRedisDataCacheHandler: "function",
  createIoredisAdapter: "function",
} as const;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function textOf(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function dataEntry(text: string, tags: string[]): pkg.DataCacheEntry {
  return {
    value: streamOf(text),
    tags,
    stale: 300,
    timestamp: performance.timeOrigin + performance.now(),
    expire: 3600,
    revalidate: 900,
  };
}

const fetchValue = (body: string): pkg.CacheValue => ({
  kind: "FETCH",
  data: { headers: {}, body, status: 200, url: "https://example.com/api" },
  revalidate: 60,
});

beforeEach(async () => {
  await resetCacheState();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await resetCacheState();
});

describe("16.4.2 exports", () => {
  test.each(Object.entries(EXPORTS_16_4_2))("%s is still exported", (name, type) => {
    expect(typeof (pkg as Record<string, unknown>)[name]).toBe(type);
  });

  test("IMPLICIT_TAG_PREFIX is unchanged", () => {
    expect(pkg.IMPLICIT_TAG_PREFIX).toBe("_N_T_");
  });
});

describe("16.4.2 next.config helpers", () => {
  test("createCacheConfig returns exactly what 16.4.2 returned for the same arguments", () => {
    expect(
      pkg.createCacheConfig({
        isrHandlerPath: "/app/cache-handler.mjs",
        dataCacheHandlerPath: "/app/data-cache-handler.mjs",
      }),
    ).toStrictEqual({
      cacheHandler: "/app/cache-handler.mjs",
      cacheHandlers: {
        default: "/app/data-cache-handler.mjs",
        remote: "/app/data-cache-handler.mjs",
      },
      cacheMaxMemorySize: 0,
    });
  });

  test("createCacheConfigWithProfiles returns exactly what 16.4.2 returned", () => {
    expect(
      pkg.createCacheConfigWithProfiles({
        isrHandlerPath: "/app/cache-handler.mjs",
        defaultDataCacheHandlerPath: "/app/memory.mjs",
        remoteDataCacheHandlerPath: "/app/redis.mjs",
        disableDefaultMemoryCache: false,
      }),
    ).toStrictEqual({
      cacheHandler: "/app/cache-handler.mjs",
      cacheHandlers: { default: "/app/memory.mjs", remote: "/app/redis.mjs" },
      cacheMaxMemorySize: undefined,
    });
  });
});

describe("16.4.2 data cache handlers (memory)", () => {
  test.each([
    ["createCacheHandler({ type: 'memory' })", () => pkg.createCacheHandler({ type: "memory" })],
    [
      "createCacheHandler with every memory option",
      () => pkg.createCacheHandler({ type: "memory", maxSize: 10 * 1024 * 1024, debug: false }),
    ],
    [
      "createMemoryDataCacheHandler({ maxSize, debug })",
      () => pkg.createMemoryDataCacheHandler({ maxSize: 100 * 1024 * 1024, debug: false }),
    ],
  ])("%s caches, and revalidates by tag", async (_name, create) => {
    const handler = create();
    await handler.set("k", Promise.resolve(dataEntry("v1", ["t"])));
    const hit = await handler.get("k", []);
    expect(hit && (await textOf(hit.value))).toBe("v1");

    await new Promise((resolve) => setTimeout(resolve, 2));
    await handler.updateTags(["t"]);
    expect(await handler.getExpiration(["t"])).toBeGreaterThan(0);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("createCacheHandler({ type: 'redis' }) never connects during next build", async () => {
    process.env.NEXT_PHASE = "phase-production-build";
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    const handler = pkg.createCacheHandler({ type: "redis" });
    await handler.set("k", Promise.resolve(dataEntry("built", [])));
    const hit = await handler.get("k", []);
    expect(hit && (await textOf(hit.value))).toBe("built");
  });
});

describe("16.4.2 page (ISR) handlers", () => {
  test("the 16.4.2 example app's MemoryCacheHandler subclass still works", async () => {
    // apps/e2e-test-app/cache-handler.mjs at v16.4.2
    class NextCacheHandler extends pkg.MemoryCacheHandler {
      constructor(options: pkg.MemoryCacheHandlerOptions) {
        super({ ...options, maxItemsNumber: 100, defaultTTL: 3600 });
      }
    }
    const handler = new NextCacheHandler({ serverDistDir: "/tmp/.next/server" });
    await handler.set("/api", fetchValue("one"), { revalidate: 60, tags: ["t"] });
    expect((await handler.get("/api"))?.value).toEqual(fetchValue("one"));

    await new Promise((resolve) => setTimeout(resolve, 2));
    await handler.revalidateTag("t");
    expect(await handler.get("/api")).toBeNull();
  });

  test("createMemoryCacheHandler and createCompositeHandler still compose", async () => {
    const first = pkg.createMemoryCacheHandler({ maxItemsNumber: 10 });
    const second = pkg.createMemoryCacheHandler();
    const composite = pkg.createCompositeHandler({ handlers: [first, second] });
    await composite.set("/api", fetchValue("both"), { revalidate: 60, tags: ["t"] });
    expect((await second.get("/api"))?.value).toEqual(fetchValue("both"));
    expect((await composite.get("/api"))?.value).toEqual(fetchValue("both"));

    await new Promise((resolve) => setTimeout(resolve, 2));
    await composite.revalidateTag("t");
    expect(await composite.get("/api")).toBeNull();
  });

  test("a RedisCacheHandler subclass with no redis option and no REDIS_URL runs in memory", async () => {
    // 16.4.2 opened `new Redis({})` here, i.e. localhost:6379. 16.4.3 reads REDIS_URL and, with
    // none, keeps entries in process memory (docs/migrating.md).
    class NextCacheHandler extends pkg.RedisCacheHandler {
      constructor(options: pkg.RedisCacheHandlerOptions) {
        super({ ...options, keyPrefix: "nextjs:cache:", defaultTTL: 3600 });
      }
    }
    const handler = new NextCacheHandler({});
    await handler.set("/api", fetchValue("memory"), { revalidate: 60, tags: ["t"] });
    expect((await handler.get("/api", { kind: "FETCH" }))?.value).toEqual(fetchValue("memory"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await handler.revalidateTag("t");
    expect(await handler.get("/api", { kind: "FETCH" })).toBeNull();
  });

  test("a subclass passing defaultTTL: 0 (16.4.2's 'no expiry') still boots", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => new pkg.RedisCacheHandler({ defaultTTL: 0 })).not.toThrow();
  });
});

describe("16.4.2 deprecation warnings", () => {
  const calls: [string, () => unknown][] = [
    ["createCacheHandler", () => pkg.createCacheHandler({ type: "memory" })],
    ["createMemoryDataCacheHandler", () => pkg.createMemoryDataCacheHandler()],
    [
      "createRedisDataCacheHandler",
      () => pkg.createRedisDataCacheHandler({ redis: {} as pkg.RedisClient }),
    ],
    ["createIoredisAdapter", () => pkg.createIoredisAdapter({} as pkg.IoredisLike)],
    ["createCacheConfig", () => pkg.createCacheConfig({ dataCacheHandlerPath: "/d.mjs" })],
    [
      "createCacheConfigWithProfiles",
      () =>
        pkg.createCacheConfigWithProfiles({
          defaultDataCacheHandlerPath: "/d.mjs",
          remoteDataCacheHandlerPath: "/r.mjs",
        }),
    ],
    ["MemoryCacheHandler", () => new pkg.MemoryCacheHandler()],
    ["createMemoryCacheHandler", () => pkg.createMemoryCacheHandler()],
    [
      "CompositeHandler",
      () => new pkg.CompositeHandler({ handlers: [new pkg.MemoryCacheHandler()] }),
    ],
    [
      "createCompositeHandler",
      () => pkg.createCompositeHandler({ handlers: [new pkg.MemoryCacheHandler()] }),
    ],
    ["bufferToString", () => pkg.bufferToString("x")],
    ["stringToBuffer", () => pkg.stringToBuffer("x", false)],
    ["isImplicitTag", () => pkg.isImplicitTag("x")],
    ["calculateLifespan", () => pkg.calculateLifespan(1)],
    ["isExpired", () => pkg.isExpired(null)],
    ["jsonReplacer", () => JSON.stringify({ a: 1 }, pkg.jsonReplacer)],
    ["jsonReviver", () => JSON.parse("{}", pkg.jsonReviver)],
    ["RedisCacheHandler's `redis` option", () => new pkg.RedisCacheHandler({ redis: "redis://h" })],
    [
      "RedisCacheHandler's `tagPrefix` option",
      () => new pkg.RedisCacheHandler({ tagPrefix: "t:" }),
    ],
    ["RedisCacheHandler.close()", () => new pkg.RedisCacheHandler().close()],
  ];

  test.each(calls)("%s logs one deprecation warning per process", async (api, call) => {
    process.env.CACHE_REDIS = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await call();
    await call();
    const ours = warn.mock.calls.filter(([message]) =>
      String(message).includes(`${api} is deprecated and will be removed in 16.5.0`),
    );
    expect(ours).toHaveLength(1);
    expect(String(ours[0][0])).toContain("docs/migrating.md");
  });

  test("the 16.4.3 API logs no deprecation warning", async () => {
    process.env.CACHE_REDIS = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const remote = pkg.createRemoteCacheHandler();
    await remote.set("k", Promise.resolve(dataEntry("v", ["t"])));
    await remote.get("k", []);
    const local = pkg.createLocalCacheHandler();
    await local.set("k", Promise.resolve(dataEntry("v", ["t"])));
    const page = new pkg.RedisCacheHandler({ keyPrefix: "p:" });
    await page.set("/api", fetchValue("v"), { revalidate: 60, tags: ["t"] });
    await page.get("/api", { kind: "FETCH" });
    pkg.withCache({});
    expect(warn.mock.calls.filter(([m]) => String(m).includes("deprecated"))).toEqual([]);
  });
});

describe("one warning line per deprecated API the application called", () => {
  function deprecationLines(warn: ReturnType<typeof vi.spyOn>): string[] {
    return warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes("is deprecated"));
  }

  test("createMemoryCacheHandler() does not also warn for the MemoryCacheHandler it builds", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pkg.createMemoryCacheHandler();
    expect(deprecationLines(warn)).toEqual([
      expect.stringContaining("createMemoryCacheHandler is deprecated"),
    ]);
  });

  test("a composite of factory-built memory handlers logs one line per factory", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    pkg.createCompositeHandler({
      handlers: [pkg.createMemoryCacheHandler(), pkg.createMemoryCacheHandler()],
    });
    const lines = deprecationLines(warn);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("createMemoryCacheHandler is deprecated");
    expect(lines[1]).toContain("createCompositeHandler is deprecated");
  });

  test.each([
    ["memory", {}],
    ["redis", { url: "redis://127.0.0.1:1" }],
    ["valkey", { url: "redis://127.0.0.1:1" }],
    ["elasticache", { endpoint: "127.0.0.1", port: 1, tls: false }],
  ] as const)(
    "createCacheHandler({ type: %s }) logs exactly its own warning",
    async (type, extra) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
      const handler = pkg.createCacheHandler({ type, ...extra });
      await handler.get("k", []);
      await handler.set("k", Promise.resolve(dataEntry("v", ["t"])));
      await handler.updateTags(["t"]);
      expect(deprecationLines(warn)).toEqual([
        expect.stringContaining("createCacheHandler is deprecated"),
      ]);
    },
  );
});

describe("RedisCacheHandler without any Redis setting (16.4.2 connected to localhost)", () => {
  function noConnectionLines(warn: ReturnType<typeof vi.spyOn>): unknown[] {
    return warn.mock.calls.filter(([message]) => String(message).includes("localhost:6379"));
  }

  class NextCacheHandler extends pkg.RedisCacheHandler {
    constructor(options: pkg.RedisCacheHandlerOptions) {
      super({ ...options, keyPrefix: "nextjs:cache:" });
    }
  }

  test("warns once in production, and keeps running in memory", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = new NextCacheHandler({});
    new NextCacheHandler({});
    expect(noConnectionLines(warn)).toHaveLength(1);
    expect(String(noConnectionLines(warn)[0])).toContain("set REDIS_URL");
    await handler.set("/api", fetchValue("memory"), { revalidate: 60, tags: ["t"] });
    expect((await handler.get("/api", { kind: "FETCH" }))?.value).toEqual(fetchValue("memory"));
    vi.unstubAllEnvs();
  });

  test.each([
    ["in development", { NODE_ENV: "development" }],
    ["during next build", { NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }],
    ["with REDIS_URL set", { NODE_ENV: "production", REDIS_URL: "redis://127.0.0.1:1" }],
    ["with VALKEY_URL set", { NODE_ENV: "production", VALKEY_URL: "redis://127.0.0.1:1" }],
    ["with CACHE_REDIS=off", { NODE_ENV: "production", CACHE_REDIS: "off" }],
  ])("does not warn %s", (_name, env) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new NextCacheHandler({});
    expect(noConnectionLines(warn)).toEqual([]);
    vi.unstubAllEnvs();
  });

  test("never warns for withCache's built-in page handler (memory-only mode is documented)", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const BuiltIn = pkg.createPageCacheHandler();
    new BuiltIn({});
    expect(noConnectionLines(warn)).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("16.4.2 helpers", () => {
  test("serialization, buffer, lifespan and tag helpers behave as in 16.4.2", () => {
    const value = { map: new Map([["a", Buffer.from("b")]]) };
    const roundTrip = JSON.parse(JSON.stringify(value, pkg.jsonReplacer), pkg.jsonReviver);
    expect(roundTrip.map.get("a").toString()).toBe("b");

    const encoded = pkg.bufferToString(Buffer.from("x")) as string;
    expect(pkg.stringToBuffer(encoded, true).toString()).toBe("x");
    expect(pkg.isImplicitTag("_N_T_/blog")).toBe(true);
    expect(pkg.isImplicitTag("blog")).toBe(false);

    const lifespan = pkg.calculateLifespan(60);
    expect(lifespan?.expireAge).toBe(60);
    expect(pkg.isExpired(lifespan)).toBe(false);
    expect(pkg.calculateLifespan(false)).toBeNull();
  });
});
