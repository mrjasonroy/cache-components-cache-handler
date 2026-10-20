import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { MEMORY_ONLY_TAG } from "../shared/runtime.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import type { PageCacheValue } from "./page-types.js";
import {
  RedisCacheHandler,
  createRedisCacheHandler,
  getEntryLifetime,
  getEntryTags,
} from "./redis.js";

function page(html: string, tags = "t1,_N_T_/blog/layout,_N_T_/blog/page"): PageCacheValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`rsc:${html}`),
    segmentData: new Map([["/_index", Buffer.from(`seg:${html}`)]]),
    headers: { "x-next-cache-tags": tags },
    postponed: undefined,
    status: 200,
  };
}

const pageCtx = { fetchCache: false, cacheControl: { revalidate: 60, expire: 300 } };
const KEY = "nextjs:development:page:/blog";

function handlerFor(fake: FakeRedis, options = {}) {
  return new RedisCacheHandler({ client: asClient(fake), ...options });
}

describe("RedisCacheHandler (Next 16 singular cacheHandler)", () => {
  beforeEach(async () => {
    await resetCacheState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetCacheState();
  });

  describe("get / set shapes", () => {
    test("round-trips APP_PAGE with Buffers and a Map, binary, under the build-scoped key", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.set("/blog", page("hello"), pageCtx);

      const raw = await fake.getBuffer(KEY);
      expect(raw?.subarray(0, 3).toString("latin1")).toBe("NCH");

      const result = await handler.get("/blog", { kind: "APP_PAGE", isFallback: false });
      expect(result?.value.html).toBe("hello");
      expect(Buffer.isBuffer(result?.value.rscData)).toBe(true);
      expect((result?.value.segmentData as Map<string, Buffer>).get("/_index")?.toString()).toBe(
        "seg:hello",
      );
      // cacheControl comes back so another instance revalidates on the page's schedule.
      expect(result?.cacheControl).toEqual({ revalidate: 60, expire: 300 });
      expect(typeof result?.lastModified).toBe("number");
    });

    test("returns null for a miss and ignores null data", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/nothing", null, pageCtx);
      expect(await handler.get("/nothing", { kind: "APP_PAGE" })).toBeNull();
    });

    test("APP_ROUTE and FETCH round-trip; FETCH does not return cacheControl", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set(
        "/api",
        { kind: "APP_ROUTE", body: Buffer.from([0, 255, 1]), status: 200, headers: {} },
        pageCtx,
      );
      const route = await handler.get("/api", { kind: "APP_ROUTE" });
      expect([...(route?.value.body as Buffer)]).toEqual([0, 255, 1]);

      const fetchValue: PageCacheValue = {
        kind: "FETCH",
        data: { headers: {}, body: "{}", status: 200, url: "https://x" },
        revalidate: 30,
      };
      await handler.set("fetch-key", fetchValue, {
        fetchCache: true,
        tags: ["products"],
        cacheControl: { revalidate: 30 },
      });
      const fetched = await handler.get("fetch-key", { kind: "FETCH", tags: ["products"] });
      expect(fetched?.value.kind).toBe("FETCH");
      expect(fetched?.cacheControl).toBeUndefined();
    });

    test("resetRequestCache is a no-op", () => {
      expect(() => handlerFor(new FakeRedis()).resetRequestCache()).not.toThrow();
    });

    test("a corrupt or foreign value reads as a miss", async () => {
      const fake = new FakeRedis();
      await fake.set(KEY, "not an entry");
      expect(await handlerFor(fake).get("/blog", { kind: "APP_PAGE" })).toBeNull();
    });

    test("a Redis error on get is a miss and is logged", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      fake.failWith = new Error("boom");
      expect(await handler.get("/blog", { kind: "APP_PAGE" })).toBeNull();
      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("tags", () => {
    test("getEntryTags reads the x-next-cache-tags header, or ctx.tags for fetches", () => {
      expect(getEntryTags(page("a", "a,b,,c"))).toEqual(["a", "b", "c"]);
      expect(getEntryTags({ kind: "FETCH" }, { tags: ["x"] })).toEqual(["x"]);
      expect(getEntryTags({ kind: "PAGES" })).toEqual([]);
      expect(
        getEntryTags({ kind: "APP_ROUTE", headers: { "x-next-cache-tags": ["a", "b"] } }),
      ).toEqual(["a", "b"]);
    });

    test("a Pages Router value's header tags are stored and checked, across a restart", async () => {
      expect(
        getEntryTags({ kind: "PAGES", headers: { "x-next-cache-tags": "products,other" } }),
      ).toEqual(["products", "other"]);

      const fake = new FakeRedis();
      await handlerFor(fake).set(
        "/about",
        {
          kind: "PAGES",
          html: "<html>about</html>",
          pageData: { title: "about" },
          headers: { "x-next-cache-tags": "products" },
          status: 200,
        },
        pageCtx,
      );
      await new Promise((r) => setTimeout(r, 2));
      await handlerFor(fake).revalidateTag("products");

      await resetCacheState();
      expect(await handlerFor(fake).get("/about", { kind: "PAGES" })).toBeNull();
    });

    test("revalidateTag without durations expires entries with a header tag at once", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/blog", page("v1"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["t1"]);
      expect(await handler.get("/blog", { kind: "APP_PAGE" })).toBeNull();

      // Rendered again after the revalidation: fresh.
      await handler.set("/blog", page("v2"), pageCtx);
      expect((await handler.get("/blog", { kind: "APP_PAGE" }))?.value.html).toBe("v2");
    });

    test("revalidatePath's implicit _N_T_ tags in the header invalidate the page", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/blog", page("v1"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag("_N_T_/blog/page");
      expect(await handler.get("/blog", { kind: "APP_PAGE" })).toBeNull();
    });

    test("fetch soft tags and ctx tags are checked on get", async () => {
      const handler = handlerFor(new FakeRedis());
      const value: PageCacheValue = { kind: "FETCH", data: {}, revalidate: 30 };
      await handler.set("f", value, { fetchCache: true, tags: [] });
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["_N_T_/shop"]);
      expect(await handler.get("f", { kind: "FETCH", tags: [], softTags: [] })).not.toBeNull();
      expect(
        await handler.get("f", { kind: "FETCH", tags: [], softTags: ["_N_T_/shop"] }),
      ).toBeNull();
    });

    test("revalidateTag with durations serves the entry stale, with lastModified past revalidate", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/blog", page("v1"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["t1"], { expire: 3600 });

      const result = await handler.get("/blog", { kind: "APP_PAGE" });
      expect(result?.value.html).toBe("v1");
      expect(result?.lastModified).toBeLessThan(Date.now() - 60_000);
      // Still within expire, so Next serves it stale instead of blocking.
      expect((result?.lastModified ?? 0) + 300_000).toBeGreaterThan(Date.now());
    });

    test("a stale entry is stale by Next's clock (performance), even when it lags Date.now()", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/blog", page("v1"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["t1"], { expire: 3600 });
      // Next's clock runs 500 ms behind the wall clock.
      const lag = Date.now() - 500 - performance.timeOrigin;
      vi.spyOn(performance, "now").mockReturnValue(lag);

      const result = await handler.get("/blog", { kind: "APP_PAGE" });
      const age = (performance.timeOrigin + performance.now() - (result?.lastModified ?? 0)) / 1000;
      expect(age).toBeGreaterThan(60);
    });

    test("a stale FETCH uses the larger of ctx.revalidate and the entry's revalidate", async () => {
      const handler = handlerFor(new FakeRedis());
      const value: PageCacheValue = { kind: "FETCH", data: {}, revalidate: 30 };
      await handler.set("f", value, { fetchCache: true, tags: ["products"] });
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["products"], { expire: 3600 });

      const result = await handler.get("f", { kind: "FETCH", tags: ["products"], revalidate: 120 });
      const age = (performance.timeOrigin + performance.now() - (result?.lastModified ?? 0)) / 1000;
      // Next: `ctx.revalidate || value.revalidate`, stale once age > that.
      expect(age).toBeGreaterThan(120);
    });

    test("a stale entry without a revalidate period is a miss", async () => {
      const handler = handlerFor(new FakeRedis());
      await handler.set("/static", page("v1"), { cacheControl: { revalidate: false } });
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["t1"], { expire: 3600 });
      expect(await handler.get("/static", { kind: "APP_PAGE" })).toBeNull();
    });

    test("writes the tag record to the tags hash and the tag index", async () => {
      const fake = new FakeRedis();
      await handlerFor(fake).revalidateTag(["t1"], { expire: 10 });
      const [raw] = await fake.hmget("nextjs:tags", "t1");
      const [stale, expired] = (raw ?? "").split(",");
      const record = { stale, expired };
      expect(Number(record.expired) - Number(record.stale)).toBe(10_000);
      expect(fake.ttlOf("nextjs:tags")).toBe(-1);
      expect(await fake.zrangebyscore("nextjs:tag-index", "-inf", "+inf")).toContain("t1");
    });

    test("revalidateTag on one instance: the very next get on another is a miss", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const instanceA = new FakeRedis();
      const a = handlerFor(instanceA);
      const b = handlerFor(new FakeRedis(instanceA.items));

      await a.set("/blog", page("v1"), pageCtx);
      expect((await b.get("/blog", { kind: "APP_PAGE" }))?.value.html).toBe("v1");

      vi.setSystemTime(Date.now() + 1);
      await a.revalidateTag(["t1"]);
      expect(await b.get("/blog", { kind: "APP_PAGE" })).toBeNull();
    });

    test("revalidatePath on one instance: the very next get on another is a miss", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const instanceA = new FakeRedis();
      const a = handlerFor(instanceA);
      const b = handlerFor(new FakeRedis(instanceA.items));
      // The entry's header lacks the path tag; Next passes it as a soft tag on get.
      const soft = { kind: "APP_PAGE", softTags: ["_N_T_/layout", "_N_T_/shop"] };

      await a.set("/shop", page("v1", "t9"), pageCtx);
      expect((await b.get("/shop", soft))?.value.html).toBe("v1");

      vi.setSystemTime(Date.now() + 1);
      await a.revalidateTag(["_N_T_/shop"]);
      expect(await b.get("/shop", soft)).toBeNull();
    });

    test("one round trip per get once the entry's tags are known; two the first time", async () => {
      const instanceA = new FakeRedis();
      const a = handlerFor(instanceA);
      const instanceB = new FakeRedis(instanceA.items);
      const b = handlerFor(instanceB);
      const soft = { kind: "APP_PAGE", softTags: ["_N_T_/layout", "_N_T_/blog/page"] };
      await a.set("/blog", page("v1", "t1,t2,_N_T_/blog/page"), pageCtx);
      // Let the background tag sync from instance B's first get finish before counting.
      await b.get("/other", soft);
      await new Promise((r) => setTimeout(r, 0));

      const count = async (handler: RedisCacheHandler, fake: FakeRedis) => {
        const [trips, gets] = [fake.roundTrips, fake.commands.length];
        await handler.get("/blog", soft);
        const issued = fake.commands.slice(gets);
        return {
          trips: fake.roundTrips - trips,
          commands: issued.length,
        };
      };

      // Instance B has never seen the entry: GET + HMGET of the soft tags, then HMGET of t1, t2.
      expect(await count(b, instanceB)).toEqual({ trips: 2, commands: 3 });
      // Then GET + one HMGET of every tag.
      expect(await count(b, instanceB)).toEqual({ trips: 1, commands: 2 });
      // Instance A wrote it, so it knows the tags already.
      expect(await count(a, instanceA)).toMatchObject({ trips: 1 });
    });

    test("a page get reads tag records with one HMGET, never the tag index", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.get("/a", { kind: "APP_PAGE", softTags: ["_N_T_/a"] });
      await new Promise((r) => setTimeout(r, 0));
      expect(fake.commands).toEqual(["getBuffer", "hmget"]);
    });

    test("a memory-only entry still has its tags checked against Redis", async () => {
      const instanceA = new FakeRedis();
      const a = handlerFor(instanceA);
      const b = handlerFor(new FakeRedis(instanceA.items));
      await b.set("/health", page("ok", `t1,${MEMORY_ONLY_TAG}`), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await a.revalidateTag(["t1"]);
      expect(await b.get("/health", { kind: "APP_PAGE" })).toBeNull();
    });

    test("a Redis error reading tag records is a miss", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.set("/blog", page("v1"), pageCtx);
      const hmget = vi.spyOn(fake, "hmget").mockRejectedValue(new Error("boom"));
      expect(await handler.get("/blog", { kind: "APP_PAGE" })).toBeNull();
      expect(hmget).toHaveBeenCalled();
    });
  });

  describe("lifetime", () => {
    test("1.5 × revalidate, capped at expire", () => {
      const value = page("x");
      expect(getEntryLifetime(value, { cacheControl: { revalidate: 60, expire: 300 } })).toBe(90);
      expect(getEntryLifetime(value, { cacheControl: { revalidate: 60, expire: 70 } })).toBe(70);
      expect(getEntryLifetime(value, { cacheControl: { revalidate: 7 } })).toBe(11);
    });

    test("expire without revalidate, else the fallback, never past the longest entry age", () => {
      const value = page("x");
      expect(getEntryLifetime(value, { cacheControl: { revalidate: false, expire: 500 } })).toBe(
        500,
      );
      expect(getEntryLifetime(value, { cacheControl: { revalidate: false } })).toBe(
        MAX_ENTRY_AGE_SECONDS,
      );
      expect(getEntryLifetime(value, undefined, 42)).toBe(42);
      expect(getEntryLifetime(value, undefined, MAX_ENTRY_AGE_SECONDS * 2)).toBe(
        MAX_ENTRY_AGE_SECONDS,
      );
      expect(getEntryLifetime(value, { cacheControl: { expire: MAX_ENTRY_AGE_SECONDS * 2 } })).toBe(
        MAX_ENTRY_AGE_SECONDS,
      );
      expect(getEntryLifetime(value, { cacheControl: { revalidate: 300 * 86_400 } })).toBe(
        MAX_ENTRY_AGE_SECONDS,
      );
    });

    test("a page of 16 KB or more is stored compressed (v3) and read back by another instance", async () => {
      const fake = new FakeRedis();
      const html = "<p>large</p>".repeat(4_000);
      await handlerFor(fake).set("/blog", page(html), pageCtx);

      const raw = await fake.getBuffer(KEY);
      expect(raw?.[3]).toBe(3);
      expect(raw?.length).toBeLessThan(html.length);

      await resetCacheState();
      const result = await handlerFor(fake).get("/blog", { kind: "APP_PAGE", isFallback: false });
      expect(result?.value.html).toBe(html);
    });

    test("with CACHE_COMPRESSION=off a large page is stored uncompressed (v2)", async () => {
      process.env.CACHE_COMPRESSION = "off";
      const fake = new FakeRedis();
      const html = "<p>large</p>".repeat(4_000);
      await handlerFor(fake).set("/blog", page(html), pageCtx);

      expect((await fake.getBuffer(KEY))?.[3]).toBe(2);
      const result = await handlerFor(fake).get("/blog", { kind: "APP_PAGE", isFallback: false });
      expect(result?.value.html).toBe(html);
    });

    test("an entry older than the longest entry age is never served", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      // Written with a longer TTL (an older version, or a defaultTTL past the cap).
      const days = 86_400;
      await fake.set(
        KEY,
        encodeEntry({ value: page("old"), tags: ["t1"], lastModified: Date.now() }),
        "EX",
        500 * days,
      );
      const ctx = { kind: "APP_PAGE" as const, isFallback: false };
      vi.setSystemTime(Date.now() + MAX_ENTRY_AGE_SECONDS * 1000 - 1_000);
      expect((await handler.get("/blog", ctx))?.value.html).toBe("old");
      vi.setSystemTime(Date.now() + 1_000);
      expect(await handler.get("/blog", ctx)).toBeNull();

      // A memory-only entry is capped the same way.
      const memory = new RedisCacheHandler();
      await memory.set("/m", page("m"), { cacheControl: { revalidate: false } });
      vi.setSystemTime(Date.now() + MAX_ENTRY_AGE_SECONDS * 1000);
      expect(await memory.get("/m", ctx)).toBeNull();
    });

    test("FETCH uses data.revalidate; 16.4.2 ctx.revalidate still works", () => {
      expect(getEntryLifetime({ kind: "FETCH", revalidate: 10 }, { fetchCache: true })).toBe(15);
      expect(getEntryLifetime(page("x"), { revalidate: 20 })).toBe(30);
    });

    test("the Redis TTL follows the lifetime; an expired entry is not stored", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.set("/blog", page("x"), pageCtx);
      expect(fake.ttlOf(KEY)).toBe(90);

      await handler.set("/gone", page("x"), { cacheControl: { revalidate: 0, expire: 0 } });
      expect(await fake.exists("nextjs:development:page:/gone")).toBe(0);
    });
  });

  describe("MEMORY_ONLY_TAG", () => {
    test("entries tagged memory-only never reach Redis but are served", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.set("/health", page("ok", `a,${MEMORY_ONLY_TAG}`), pageCtx);
      expect(await fake.exists("nextjs:development:page:/health")).toBe(0);
      expect((await handler.get("/health", { kind: "APP_PAGE" }))?.value.html).toBe("ok");
    });
  });

  describe("outage fallback", () => {
    test("serves from memory while Redis is down and drops that memory on reconnect", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      fake.goDown();

      await handler.set("/outage", page("during"), pageCtx);
      expect(await fake.exists("nextjs:development:page:/outage")).toBe(0);
      expect((await handler.get("/outage", { kind: "APP_PAGE" }))?.value.html).toBe("during");

      fake.comeUp();
      expect(await handler.get("/outage", { kind: "APP_PAGE" })).toBeNull();
    });

    test("an outage entry is served for at most 60 s", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      fake.goDown();
      await handler.set("/outage", page("during"), { cacheControl: { revalidate: 3600 } });
      vi.setSystemTime(Date.now() + 59_000);
      expect(await handler.get("/outage", { kind: "APP_PAGE" })).not.toBeNull();
      vi.setSystemTime(Date.now() + 2_000);
      expect(await handler.get("/outage", { kind: "APP_PAGE" })).toBeNull();
    });

    test("a failed Redis write falls back to memory", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      fake.failWith = new Error("OOM");
      await handler.set("/x", page("x"), pageCtx);
      fake.failWith = undefined;
      fake.goDown();
      expect((await handler.get("/x", { kind: "APP_PAGE" }))?.value.html).toBe("x");
    });

    test("memoryFallback: false misses during an outage", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake, { memoryFallback: false });
      fake.goDown();
      await handler.set("/outage", page("during"), pageCtx);
      expect(await handler.get("/outage", { kind: "APP_PAGE" })).toBeNull();
    });

    test("revalidateTag during an outage applies locally and warns", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      fake.goDown();
      await handler.set("/outage", page("during"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await handler.revalidateTag(["t1"]);
      expect(await handler.get("/outage", { kind: "APP_PAGE" })).toBeNull();
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("updateTags failed"),
        expect.any(Error),
      );
    });
  });

  describe("without Redis", () => {
    test("no URL: everything in memory", async () => {
      const handler = new RedisCacheHandler({});
      await handler.set("/blog", page("mem"), pageCtx);
      expect((await handler.get("/blog", { kind: "APP_PAGE" }))?.value.html).toBe("mem");
      expect(ioredisMock).not.toHaveBeenCalled();
    });

    test("next build never connects, even with REDIS_URL", async () => {
      process.env.NEXT_PHASE = "phase-production-build";
      process.env.REDIS_URL = "redis://cache:6379";
      const handler = new RedisCacheHandler({});
      await handler.set("/blog", page("build"), pageCtx);
      expect((await handler.get("/blog", { kind: "APP_PAGE" }))?.value.html).toBe("build");
      expect(ioredisMock).not.toHaveBeenCalled();
    });
  });

  describe("build ID", () => {
    test("reads BUILD_ID next to the serverDistDir Next passes", async () => {
      const distDir = mkdtempSync(join(tmpdir(), "gn1618-"));
      mkdirSync(join(distDir, "server"));
      writeFileSync(join(distDir, "BUILD_ID"), "abc123\n");
      const fake = new FakeRedis();
      const handler = new RedisCacheHandler({
        client: asClient(fake),
        serverDistDir: join(distDir, "server"),
      });
      await handler.set("/blog", page("x"), pageCtx);
      expect(await fake.exists("nextjs:abc123:page:/blog")).toBe(1);
    });

    test("entries of another build are not read; tags cross builds", async () => {
      const fake = new FakeRedis();
      const oldBuild = handlerFor(fake, { buildId: "old" });
      const newBuild = handlerFor(fake, { buildId: "new" });
      await oldBuild.set("/blog", page("old"), pageCtx);
      expect(await newBuild.get("/blog", { kind: "APP_PAGE" })).toBeNull();

      await new Promise((r) => setTimeout(r, 2));
      await newBuild.revalidateTag(["t1"]);
      expect(await oldBuild.get("/blog", { kind: "APP_PAGE" })).toBeNull();
    });
  });

  describe("16.4.2 constructor options", () => {
    test("redis client, keyPrefix, tagPrefix (ignored), defaultTTL and debug still work", async () => {
      const fake = new FakeRedis();
      const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
      const handler = new RedisCacheHandler({
        redis: asClient(fake),
        keyPrefix: "app:",
        tagPrefix: "ignored:",
        defaultTTL: 120,
        debug: true,
      });
      await handler.set("/blog", page("x", "t1"), { cacheControl: { revalidate: false } });
      expect(fake.ttlOf("app:development:page:/blog")).toBe(120);
      await handler.revalidateTag("t1");
      expect(await fake.hmget("app:tags", "t1")).not.toEqual([null]);
      expect(debug).toHaveBeenCalled();
    });

    test("a fractional defaultTTL is rounded up to whole seconds", async () => {
      const fake = new FakeRedis();
      const handler = new RedisCacheHandler({
        redis: asClient(fake),
        keyPrefix: "app:",
        defaultTTL: 0.5,
      });
      await handler.set("/blog", page("x", "t1"), { cacheControl: { revalidate: false } });
      expect(fake.ttlOf("app:development:page:/blog")).toBe(1);
    });

    test("an invalid defaultTTL throws at construction, as for the remote handler", () => {
      for (const defaultTTL of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "60" as never]) {
        expect(
          () => new RedisCacheHandler({ client: asClient(new FakeRedis()), defaultTTL }),
        ).toThrow(
          /RedisCacheHandler: defaultTTL must be a finite number of seconds greater than 0/,
        );
      }
    });

    test("a URL string opens a connection from the URL", () => {
      ioredisMock.mockImplementation(() => new FakeRedis());
      new RedisCacheHandler({ redis: "redis://legacy:6379" });
      expect(ioredisMock).toHaveBeenCalledWith(
        "redis://legacy:6379",
        expect.objectContaining({ enableOfflineQueue: false, commandTimeout: 1000 }),
      );
    });

    test("an ioredis options object opens a connection from it", () => {
      ioredisMock.mockImplementation(() => new FakeRedis());
      new RedisCacheHandler({ redis: { host: "legacy-host", port: 6390 } });
      expect(ioredisMock).toHaveBeenCalledWith(
        expect.objectContaining({ host: "legacy-host", port: 6390, enableOfflineQueue: false }),
      );
    });

    test("connectTimeout and socketTimeout reach the ioredis client opened from a URL", () => {
      ioredisMock.mockImplementation(() => new FakeRedis());
      const Handler = createRedisCacheHandler({
        url: "redis://timeouts:6379",
        connectTimeout: 1234,
        socketTimeout: 2345,
      });
      new Handler({});
      expect(ioredisMock).toHaveBeenCalledWith(
        "redis://timeouts:6379",
        expect.objectContaining({ connectTimeout: 1234, socketTimeout: 2345 }),
      );
    });

    test("connectTimeout and socketTimeout reach the ioredis client opened from options", () => {
      ioredisMock.mockImplementation(() => new FakeRedis());
      const Handler = createRedisCacheHandler({
        redis: { host: "h" },
        connectTimeout: 1234,
        socketTimeout: 2345,
      });
      new Handler({});
      expect(ioredisMock).toHaveBeenCalledWith(
        expect.objectContaining({ host: "h", connectTimeout: 1234, socketTimeout: 2345 }),
      );
    });

    test("close() never quits a client the application passed in", async () => {
      const fake = new FakeRedis();
      const quit = vi.spyOn(fake, "quit");
      await handlerFor(fake).close();
      expect(quit).not.toHaveBeenCalled();
    });

    test("delete removes the entry", async () => {
      const fake = new FakeRedis();
      const handler = handlerFor(fake);
      await handler.set("/blog", page("x"), pageCtx);
      await handler.delete("/blog");
      expect(await fake.exists(KEY)).toBe(0);
    });
  });

  describe("createRedisCacheHandler", () => {
    test("returns a subclass Next can construct with its ctx", async () => {
      const fake = new FakeRedis();
      const Handler = createRedisCacheHandler({ client: asClient(fake), keyPrefix: "p:" });
      const handler = new Handler({ serverDistDir: "/nonexistent/server", dev: false });
      expect(handler).toBeInstanceOf(RedisCacheHandler);
      await handler.set("/blog", page("x"), pageCtx);
      expect(await fake.exists("p:development:page:/blog")).toBe(1);
    });

    test("instances constructed per request share one runtime and tag state", async () => {
      const fake = new FakeRedis();
      const Handler = createRedisCacheHandler({ client: asClient(fake) });
      await new Handler({}).set("/blog", page("x"), pageCtx);
      await new Promise((r) => setTimeout(r, 2));
      await new Handler({}).revalidateTag(["t1"]);
      expect(await new Handler({}).get("/blog", { kind: "APP_PAGE" })).toBeNull();
    });
  });
});
