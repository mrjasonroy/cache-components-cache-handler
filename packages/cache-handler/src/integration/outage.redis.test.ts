/**
 * The page, remote and local handlers against a real Redis: outages, revalidation across
 * instances, the build phase and build-ID scoping.
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis running in the Docker
 * container named by `CACHE_TEST_REDIS_CONTAINER`; the tests stop, start, pause and unpause that
 * container.
 *
 * ```sh
 * docker run -d --name cache-test-redis -p 6390:6379 redis:7-alpine
 * CACHE_TEST_REDIS_URL=redis://localhost:6390 CACHE_TEST_REDIS_CONTAINER=cache-test-redis \
 *   pnpm --filter @mrjasonroy/cache-components-cache-handler test:redis
 * ```
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createLocalCacheHandler } from "../data-cache/local.js";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import type { PageCacheValue } from "../handlers/page-types.js";
import { createPageCacheHandler } from "../handlers/redis.js";
import { flushCache } from "../shared/flush.js";
import { FLUSH_TAG, tagIndexKey, tagsKey } from "../shared/keys.js";
import { getCacheRuntime } from "../shared/runtime.js";
import { TAG_RETENTION_MS } from "../shared/tag-retention.js";
import { resetCacheState } from "../testing/env.js";

const url = process.env.CACHE_TEST_REDIS_URL;
const container = process.env.CACHE_TEST_REDIS_CONTAINER;
const enabled = Boolean(url && container);

function docker(...args: string[]): void {
  execFileSync("docker", args, { stdio: "ignore" });
}

/** Restore the container whatever state a test left it in. */
function restoreContainer(): void {
  for (const command of ["unpause", "start"]) {
    try {
      docker(command, container as string);
    } catch {
      // Not paused, or already running.
    }
  }
}

function waitFor(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting"));
      setTimeout(tick, 50);
    };
    tick();
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function entry(text: string, tags: string[] = ["t1"]): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags,
    stale: 0,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

async function text(found: DataCacheEntry | undefined): Promise<string | undefined> {
  return found ? new Response(found.value).text() : undefined;
}

function page(html: string): PageCacheValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`rsc:${html}`),
    segmentData: new Map([["/_index", Buffer.from(`seg:${html}`)]]),
    headers: { "x-next-cache-tags": "t1,_N_T_/blog/page" },
    status: 200,
  };
}

const pageContext = { cacheControl: { revalidate: 60, expire: 300 } };
const pageGet = { kind: "APP_PAGE" };

describe.runIf(enabled)("page, remote and local handlers (real Redis)", () => {
  // Unique per test, so runs never see each other's keys.
  let prefix = "";
  let raw: Redis;

  /**
   * One Next instance's handlers. Each instance gets its own connection (a distinct
   * `commandTimeout` resolves to a distinct connection) and so its own tag state.
   */
  function instance(n: number, buildId = "build-1") {
    const options = { url, keyPrefix: prefix, commandTimeout: 500 + n };
    const Page = createPageCacheHandler({ ...options, buildId });
    return {
      page: new Page({}),
      remote: createRemoteCacheHandler({ ...options, buildId }),
      local: createLocalCacheHandler(options),
      connection: () => getCacheRuntime(options).connection,
      maintainTags: () => getCacheRuntime(options).tags.maintain(),
    };
  }

  beforeAll(() => {
    restoreContainer();
    raw = new Redis(url as string);
  });

  afterEach(async () => {
    restoreContainer();
    await resetCacheState();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    raw.disconnect();
    await resetCacheState();
  });

  function setup() {
    prefix = `test:${randomUUID()}:`;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  }

  test("binary entries under <prefix><buildId>:page: and :data:", async () => {
    setup();
    const a = instance(0);
    await a.page.set("/blog", page("p"), pageContext);
    await a.remote.set("k", entry("d"));

    for (const key of [`${prefix}build-1:page:/blog`, `${prefix}build-1:data:k`]) {
      expect((await raw.getBuffer(key))?.subarray(0, 3).toString("latin1")).toBe("NCH");
    }
    expect(await raw.ttl(`${prefix}build-1:page:/blog`)).toBe(90);
  }, 30_000);

  test("Redis down at boot: memory serves, then Redis takes over and outage entries are dropped", async () => {
    setup();
    docker("stop", container as string);
    const a = instance(0);

    const started = Date.now();
    await a.remote.set("outage", entry("outage value"));
    // The first call waits at most the initial-connect window, never for Redis itself.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(await text(await a.remote.get("outage", []))).toBe("outage value");
    await a.page.set("/outage", page("outage page"), pageContext);
    expect((await a.page.get("/outage", pageGet))?.value.html).toBe("outage page");

    docker("start", container as string);
    await waitFor(() => a.connection()?.isReady() === true);

    expect(await a.remote.get("outage", [])).toBeUndefined();
    expect(await a.page.get("/outage", pageGet)).toBeNull();
    await a.page.set("/after", page("after"), pageContext);
    expect(await raw.exists(`${prefix}build-1:page:/after`)).toBe(1);
  }, 60_000);

  test("Redis lost mid-run and back: bounded calls during the outage, Redis after", async () => {
    setup();
    const a = instance(0);
    await a.remote.set("before", entry("before value"));
    await a.page.set("/before", page("before"), pageContext);

    const oldTagTime = Date.now() - TAG_RETENTION_MS - 1000;
    await raw.hset(tagsKey(prefix), "prunable", `${oldTagTime},${oldTagTime}`);
    await raw.zadd(tagIndexKey(prefix), oldTagTime, "prunable");
    docker("stop", container as string);
    await waitFor(() => a.connection()?.isReady() === false);
    await a.maintainTags();

    const started = Date.now();
    expect(await a.remote.get("before", [])).toBeUndefined();
    expect(await a.page.get("/before", pageGet)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);

    await a.page.set("/during", page("during"), pageContext);
    expect((await a.page.get("/during", pageGet))?.value.html).toBe("during");
    // A revalidation during the outage still applies in this process.
    await sleep(2);
    await a.page.revalidateTag(["t1"]);
    expect(await a.page.get("/during", pageGet)).toBeNull();

    docker("start", container as string);
    await waitFor(() => a.connection()?.isReady() === true);
    await a.maintainTags();
    expect(await raw.hget(tagsKey(prefix), "prunable")).toBeNull();
    await a.remote.set("again", entry("again value", ["other"]));
    expect(await text(await a.remote.get("again", []))).toBe("again value");
    expect(await raw.exists(`${prefix}build-1:data:again`)).toBe(1);
  }, 60_000);

  test("a stalled Redis is dropped after consecutive timeouts, memory serves, then it is back", async () => {
    setup();
    const a = instance(0);
    await a.remote.set("warm", entry("warm value"));

    docker("pause", container as string);
    for (let i = 0; i < 3; i++) {
      const started = Date.now();
      expect(await a.remote.get("warm", [])).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(1_500);
    }
    await waitFor(() => a.connection()?.isReady() === false, 5_000);

    const started = Date.now();
    await a.remote.set("stalled", entry("stalled value"));
    expect(await text(await a.remote.get("stalled", []))).toBe("stalled value");
    expect(Date.now() - started).toBeLessThan(200);

    docker("unpause", container as string);
    await waitFor(() => a.connection()?.isReady() === true);
    expect(await text(await a.remote.get("warm", []))).toBe("warm value");
    expect(await a.remote.get("stalled", [])).toBeUndefined();
  }, 60_000);

  test("a revalidation on one instance reaches page, remote and local on another", async () => {
    setup();
    const a = instance(0);
    const b = instance(1);
    await a.page.set("/blog", page("p"), pageContext);
    await a.remote.set("k", entry("d"));
    await b.local.set("k", entry("l"));
    expect((await b.page.get("/blog", pageGet))?.value.html).toBe("p");
    expect(await text(await b.remote.get("k", []))).toBe("d");

    // What Next does for revalidateTag("t1"): every cacheHandlers entry, then the cacheHandler.
    await sleep(2);
    await a.remote.updateTags(["t1"]);
    await a.local.updateTags(["t1"]);
    await a.page.revalidateTag(["t1"]);

    // The page handler reads tag records with the entry; refreshTags runs before "use cache" reads.
    expect(await b.page.get("/blog", pageGet)).toBeNull();
    await b.remote.refreshTags();
    await b.local.refreshTags();
    expect(await b.remote.get("k", [])).toBeUndefined();
    expect(await b.local.get("k", [])).toBeUndefined();
  }, 30_000);

  test("revalidateTag and revalidatePath on one instance: the very next page get on another misses", async () => {
    setup();
    const a = instance(0);
    const b = instance(1);
    const soft = { kind: "APP_PAGE", softTags: ["_N_T_/layout", "_N_T_/shop"] };

    await a.page.set("/blog", page("p"), pageContext);
    await a.page.set(
      "/shop",
      { ...page("s"), headers: { "x-next-cache-tags": "t9" } },
      pageContext,
    );
    expect((await b.page.get("/blog", pageGet))?.value.html).toBe("p");
    expect((await b.page.get("/shop", soft))?.value.html).toBe("s");

    await sleep(2);
    await a.page.revalidateTag(["t1"]);
    expect(await b.page.get("/blog", pageGet)).toBeNull();

    // revalidatePath("/shop"): the path tag reaches the page handler only as a soft tag.
    await a.page.revalidateTag(["_N_T_/shop"]);
    expect(await b.page.get("/shop", soft)).toBeNull();
  }, 30_000);

  test("stale-until-expire reaches the other instance as stale, not gone", async () => {
    setup();
    const a = instance(0);
    const b = instance(1);
    await a.page.set("/blog", page("p"), pageContext);
    await a.remote.set("k", entry("d"));
    await sleep(2);
    await a.remote.updateTags(["t1"], { expire: 3600 });
    await a.page.revalidateTag(["t1"], { expire: 3600 });

    const stalePage = await b.page.get("/blog", pageGet);
    expect(stalePage?.value.html).toBe("p");
    expect(stalePage?.lastModified).toBeLessThan(Date.now() - 60_000);
    await b.remote.refreshTags();
    expect((await b.remote.get("k", []))?.revalidate).toBe(-1);
  }, 30_000);

  test("next build never connects, even with a URL", async () => {
    setup();
    process.env.NEXT_PHASE = "phase-production-build";
    const a = instance(0);
    await a.page.revalidateTag(["t1"]);
    await sleep(2);
    await a.page.set("/blog", page("build"), pageContext);
    await a.remote.set("k", entry("build"));
    expect(a.connection()).toBeUndefined();
    expect((await a.page.get("/blog", pageGet))?.value.html).toBe("build");
    expect(await raw.keys(`${prefix}*`)).toEqual([]);
  }, 30_000);

  test("entries are scoped to their build; tags cross builds; flushCache scopes", async () => {
    setup();
    const oldBuild = instance(0, "old");
    const newBuild = instance(1, "new");
    await oldBuild.page.set("/blog", page("old"), pageContext);
    await oldBuild.remote.set("k", entry("old"));
    expect(await newBuild.page.get("/blog", pageGet)).toBeNull();
    expect(await newBuild.remote.get("k", [])).toBeUndefined();

    await sleep(2);
    await newBuild.page.revalidateTag(["t1"]);
    expect(await oldBuild.page.get("/blog", pageGet)).toBeNull();
    await oldBuild.remote.refreshTags();
    expect(await oldBuild.remote.get("k", [])).toBeUndefined();

    await newBuild.page.set("/x", page("new"), pageContext);
    const options = { url, keyPrefix: prefix, commandTimeout: 500 };
    expect((await flushCache({ ...options, buildId: "old" })).deleted).toBe(2);
    expect(await raw.exists(`${prefix}new:page:/x`)).toBe(1);
    await flushCache({ ...options, scope: "all" });
    // Only the flush's own record is left: build output older than it is never served again.
    expect((await raw.keys(`${prefix}*`)).sort()).toEqual([`${prefix}tag-index`, `${prefix}tags`]);
    expect(Object.keys(await raw.hgetall(`${prefix}tags`))).toEqual([FLUSH_TAG]);
  }, 30_000);
});
