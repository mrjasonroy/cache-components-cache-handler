/**
 * The ISR handlers against the calls Next.js 16.4.2 actually makes
 * (next/dist/server/lib/incremental-cache/index.js). Each describe block is
 * one gap the handlers had against that contract.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";
import type { CacheHandler, CacheValue } from "../types.js";

let fakeRedis: FakeRedis;

vi.mock("ioredis", () => {
  function FakeRedisProxy() {
    return fakeRedis;
  }
  FakeRedisProxy.prototype = {};
  return { default: FakeRedisProxy, Redis: FakeRedisProxy };
});

const { RedisCacheHandler } = await import("./redis.js");
const { MemoryCacheHandler } = await import("./memory.js");

const NOW = new Date("2026-10-18T12:00:00Z").getTime();

/** An App Router page entry as Next.js 16 stores it: tags in a header. */
function appPage(tags: string): CacheValue {
  return {
    kind: "APP_PAGE",
    html: "<html>page</html>",
    rscData: Buffer.from("rsc"),
    headers: { "x-next-cache-tags": tags },
    postponed: undefined,
    status: 200,
    segmentData: undefined,
  };
}

function fetchValue(revalidate: number | false): CacheValue {
  return {
    kind: "FETCH",
    data: { headers: {}, body: "{}", status: 200, url: "https://example.com/api" },
    revalidate,
  };
}

const PAGE_TAGS = "_N_T_/layout,_N_T_/blog/layout,_N_T_/blog/page,_N_T_/blog,posts";
const PAGE_GET = { kind: "APP_PAGE", isRoutePPREnabled: false, isFallback: false } as const;
const PAGE_SET = { cacheControl: { revalidate: 60, expire: 3600 }, isFallback: false };

const handlers: Array<[string, () => CacheHandler]> = [
  ["MemoryCacheHandler", () => new MemoryCacheHandler()],
  ["RedisCacheHandler", () => new RedisCacheHandler()],
];

describe.each(handlers)("%s against the Next.js 16 contract", (_name, create) => {
  let handler: CacheHandler;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fakeRedis = new FakeRedis();
    handler = create();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("(a) page tags come from x-next-cache-tags, lifetime from ctx.cacheControl", () => {
    test("revalidateTag on a tag in the header invalidates the page", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["posts"]);
      expect(await handler.get("/blog", PAGE_GET)).toBeNull();
    });

    test("revalidatePath (an implicit tag in the header) invalidates the page", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["_N_T_/blog"]);
      expect(await handler.get("/blog", PAGE_GET)).toBeNull();
    });

    test("get returns the stored cacheControl so another instance knows the lifetime", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      const result = await handler.get("/blog", PAGE_GET);
      expect(result?.cacheControl).toEqual({ revalidate: 60, expire: 3600 });
    });
  });

  describe("(b) get honors ctx.softTags and ctx.tags", () => {
    test("revalidatePath invalidates fetch data read under that path", async () => {
      await handler.set("fetch-key", fetchValue(60), { fetchCache: true, tags: ["products"] });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["_N_T_/shop"]);
      const result = await handler.get("fetch-key", {
        kind: "FETCH",
        revalidate: 60,
        tags: ["products"],
        softTags: ["_N_T_/layout", "_N_T_/shop"],
      });
      expect(result).toBeNull();
    });

    test("a tag the fetch now carries, but was not stored with, invalidates it", async () => {
      await handler.set("fetch-key", fetchValue(60), { fetchCache: true, tags: [] });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["late-tag"]);
      const result = await handler.get("fetch-key", { kind: "FETCH", tags: ["late-tag"] });
      expect(result).toBeNull();
    });

    test("the legacy meta.implicitTags still works", async () => {
      await handler.set("fetch-key", fetchValue(60), { fetchCache: true, tags: [] });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag("_N_T_/shop");
      expect(await handler.get("fetch-key", { implicitTags: ["_N_T_/shop"] })).toBeNull();
    });
  });

  describe("(c) revalidateTag takes an array of tags", () => {
    test("every tag in the array is revalidated", async () => {
      await handler.set("a", fetchValue(60), { fetchCache: true, tags: ["tag-a"] });
      await handler.set("b", fetchValue(60), { fetchCache: true, tags: ["tag-b"] });
      await handler.set("c", fetchValue(60), { fetchCache: true, tags: ["tag-c"] });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["tag-a", "tag-b"]);
      expect(await handler.get("a", { kind: "FETCH" })).toBeNull();
      expect(await handler.get("b", { kind: "FETCH" })).toBeNull();
      expect(await handler.get("c", { kind: "FETCH" })).not.toBeNull();
    });
  });

  describe("(e) stale-while-revalidate", () => {
    test("an entry outlives its revalidate period so Next.js can serve it stale", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 90_000); // past revalidate (60s), before expire
      const result = await handler.get("/blog", PAGE_GET);
      expect(result?.lastModified).toBe(NOW);
    });

    test("an entry is dropped once it can no longer be served stale", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 3_600_000);
      expect(await handler.get("/blog", PAGE_GET)).toBeNull();
    });

    test("fetch data outlives its revalidate period", async () => {
      await handler.set("fetch-key", fetchValue(60), { fetchCache: true, tags: [] });
      vi.setSystemTime(NOW + 90_000);
      expect(await handler.get("fetch-key", { kind: "FETCH", revalidate: 60 })).not.toBeNull();
    });

    test("revalidateTag with durations serves the page stale, not a miss", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["posts"], { expire: 300 });
      vi.setSystemTime(NOW + 2_000);

      const result = await handler.get("/blog", PAGE_GET);

      expect(result).not.toBeNull();
      // Next.js marks it stale when lastModified + revalidate is in the past,
      // and serves it without blocking while lastModified + expire is not.
      const lastModified = result?.lastModified ?? 0;
      expect(lastModified + 60_000).toBeLessThan(NOW + 2_000);
      expect(lastModified + 3_600_000).toBeGreaterThan(NOW + 2_000);
    });

    test("revalidateTag with durations serves fetch data stale", async () => {
      await handler.set("fetch-key", fetchValue(60), { fetchCache: true, tags: ["products"] });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["products"], { expire: 300 });

      const result = await handler.get("fetch-key", { kind: "FETCH", tags: ["products"] });

      expect(result).not.toBeNull();
      expect(Date.now() - (result?.lastModified ?? 0)).toBeGreaterThan(60_000);
    });

    test("an entry stale by tag expires once the durations' expire passes", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["posts"], { expire: 300 });
      vi.setSystemTime(NOW + 302_000);
      expect(await handler.get("/blog", PAGE_GET)).toBeNull();
    });

    test("an entry with no revalidate period cannot be served stale, so it misses", async () => {
      await handler.set("/blog", appPage(PAGE_TAGS), {
        cacheControl: { revalidate: false, expire: undefined },
      });
      vi.setSystemTime(NOW + 1_000);
      await handler.revalidateTag(["posts"], { expire: 300 });
      expect(await handler.get("/blog", PAGE_GET)).toBeNull();
    });

    test("an entry written after the revalidation is fresh", async () => {
      await handler.revalidateTag(["posts"], { expire: 300 });
      vi.setSystemTime(NOW + 1_000);
      await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
      const result = await handler.get("/blog", PAGE_GET);
      expect(result?.lastModified).toBe(NOW + 1_000);
    });
  });
});

describe("RedisCacheHandler storage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fakeRedis = new FakeRedis();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("(a) the Redis TTL keeps the entry past revalidate, capped by expire", async () => {
    const handler = new RedisCacheHandler();
    await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
    // revalidate 60 x the default expireFactor of 2
    expect(fakeRedis.getStored("nextjs:cache:/blog")?.ttl).toBe(120);

    await handler.set("/short", appPage(PAGE_TAGS), {
      cacheControl: { revalidate: 60, expire: 90 },
    });
    expect(fakeRedis.getStored("nextjs:cache:/short")?.ttl).toBe(90);
  });

  test("(a) a page stored by an older version, with no tags, is still invalidated", async () => {
    const handler = new RedisCacheHandler();
    // Older versions read ctx.tags only, so they stored page entries with tags: [].
    const legacy = { lastModified: NOW, lifespan: null, tags: [], value: appPage(PAGE_TAGS) };
    await fakeRedis.set("nextjs:cache:/blog", JSON.stringify(legacy));
    vi.setSystemTime(NOW + 1);
    await handler.revalidateTag(["posts"]);
    expect(await handler.get("/blog", PAGE_GET)).toBeNull();
  });

  test("(a) expireFactor sets how long an entry is kept past revalidate", async () => {
    const handler = new RedisCacheHandler({ expireFactor: 1.5 });
    await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
    expect(fakeRedis.getStored("nextjs:cache:/blog")?.ttl).toBe(90);
  });

  test("(d) set writes one key per entry, with no tag index", async () => {
    const handler = new RedisCacheHandler();
    for (let i = 0; i < 50; i++) {
      await handler.set(`/part/${i}`, appPage(`_N_T_/part/${i},pricing`), PAGE_SET);
    }
    expect(fakeRedis.keys()).toHaveLength(50);
    expect(fakeRedis.commands).not.toContain("sadd");
  });

  test("(d) revalidateTag writes one record per tag and reads no index", async () => {
    const handler = new RedisCacheHandler();
    await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
    fakeRedis.commands.length = 0;

    vi.setSystemTime(NOW + 1_000);
    await handler.revalidateTag(["posts", "_N_T_/blog"]);

    expect(fakeRedis.commands).not.toContain("smembers");
    expect(fakeRedis.keys().sort()).toEqual([
      "nextjs:cache:/blog",
      "nextjs:tags:_N_T_/blog",
      "nextjs:tags:posts",
    ]);
  });

  test("(d) revalidateTag removes a tag index left by an older version", async () => {
    const handler = new RedisCacheHandler();
    await fakeRedis.sadd("nextjs:tags:posts:keys", "nextjs:cache:/blog");
    await handler.revalidateTag(["posts"]);
    expect(fakeRedis.keys()).not.toContain("nextjs:tags:posts:keys");
  });

  test("(d) a tag record from an older version still invalidates", async () => {
    const handler = new RedisCacheHandler();
    await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
    // Older versions stored the revalidation time as a plain number.
    await fakeRedis.set("nextjs:tags:posts", String(NOW + 1));
    vi.setSystemTime(NOW + 2);
    expect(await handler.get("/blog", PAGE_GET)).toBeNull();
  });

  test("(e) durations without an expire keep an earlier immediate expiry", async () => {
    const handler = new RedisCacheHandler();
    await handler.set("/blog", appPage(PAGE_TAGS), PAGE_SET);
    vi.setSystemTime(NOW + 1_000);
    await handler.revalidateTag(["posts"]);
    vi.setSystemTime(NOW + 2_000);
    await handler.revalidateTag(["posts"], {});
    expect(await handler.get("/blog", PAGE_GET)).toBeNull();
  });

  test("(d) revalidateTag succeeds when the server has no UNLINK", async () => {
    const handler = new RedisCacheHandler({ logger: { warn: vi.fn() } });
    fakeRedis.unlink = async () => {
      throw new Error("ERR unknown command 'unlink'");
    };
    await handler.revalidateTag(["posts"]);
    expect(fakeRedis.getStored("nextjs:tags:posts")).toBeDefined();
  });

  test("(d) a revalidation with durations still invalidates on an older reader", () => {
    // Older readers parse the record with Number.parseInt, which keeps the
    // leading revalidation time, so they expire the entry: safe in a mixed
    // rollout.
    const record = `${NOW}:${NOW + 300_000}`;
    expect(Number.parseInt(record)).toBe(NOW);
  });

  test("(f) a flapping Redis is logged once per interval, not per operation", async () => {
    const warn = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = new RedisCacheHandler({ logger: { warn } });
    fakeRedis.get = async () => {
      throw new Error("Connection is closed.");
    };

    for (let i = 0; i < 100; i++) {
      expect(await handler.get(`/page/${i}`, PAGE_GET)).toBeNull();
      fakeRedis.emit("error", new Error("ECONNREFUSED"));
    }

    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2); // one for get, one for the connection

    vi.setSystemTime(NOW + 61_000);
    await handler.get("/page/again", PAGE_GET);
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[2][1]).toMatchObject({ operation: "get", suppressed: 99 });
  });
});
