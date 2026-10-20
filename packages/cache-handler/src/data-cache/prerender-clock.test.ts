/**
 * With cacheComponents, Next treats a read of the current time (`Date.now()`, `new Date()`)
 * during a prerender as IO and aborts the prerender. Next calls the "use cache" handler's `get`
 * and `set` inside the prerender's async context, so a handler that reads the time through
 * `Date` aborts it: a route handler with two sequential cached calls is then built as dynamic
 * (next.js test/e2e/app-dir/cache-components, `/routes/use_cache-cached`). Next's own default
 * handler reads `performance.timeOrigin + performance.now()` for this reason.
 */

// Next's server environment, as next build and next start set it up: AsyncLocalStorage on
// globalThis, then the Date extension.
import "next/dist/server/node-environment-baseline.js";
import "next/dist/server/node-environment-extensions/date.js";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { createDynamicTrackingState } from "next/dist/server/app-render/dynamic-rendering.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { CompositeHandler } from "../handlers/composite.js";
import { MemoryCacheHandler } from "../handlers/memory.js";
import type { PageCacheValue } from "../handlers/page-types.js";
import { RedisCacheHandler } from "../handlers/redis.js";
import { nowMs, setClockForTests } from "../shared/clock.js";
import { BLOG, appPageCtx, writeBuildOutput } from "../testing/build-output.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { createIoredisAdapter } from "./ioredis-adapter.js";
import { createLocalCacheHandler } from "./local.js";
import { createMemoryDataCacheHandler } from "./memory.js";
import { createRedisDataCacheHandler } from "./redis.js";
import { createRemoteCacheHandler } from "./remote.js";
import type { DataCacheEntry, DataCacheHandler } from "./types.js";

function entry(text: string): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags: [],
    stale: 300,
    timestamp: nowMs(),
    expire: 31536000,
    revalidate: 900,
  });
}

function page(html: string): PageCacheValue {
  return {
    kind: "APP_PAGE",
    html,
    rscData: Buffer.from(`rsc:${html}`),
    segmentData: new Map([["/_index", Buffer.from(`seg:${html}`)]]),
    headers: { "x-next-cache-tags": "products,_N_T_/blog/page" },
    postponed: undefined,
    status: 200,
  };
}

const pageCtx = { fetchCache: false, cacheControl: { revalidate: 60, expire: 300 } };

const fetchValue = {
  kind: "FETCH",
  data: { headers: {}, body: "hello", status: 200, url: "https://example.com" },
  revalidate: 60,
} as const;

/**
 * Run `fn` in a prerender's async context, as Next does for a route handler at build, and
 * return whether the prerender was aborted.
 */
async function abortsPrerender(fn: () => Promise<unknown>): Promise<boolean> {
  const controller = new AbortController();
  const prerenderStore = {
    type: "prerender",
    phase: "action",
    controller,
    renderSignal: controller.signal,
    dynamicTracking: createDynamicTrackingState(undefined),
  };
  await workAsyncStorage.run({ route: "/routes/use_cache-cached" } as never, () =>
    workUnitAsyncStorage.run(prerenderStore as never, fn),
  );
  return controller.signal.aborted;
}

async function exercise(handler: DataCacheHandler): Promise<void> {
  await handler.refreshTags();
  await handler.getExpiration([]);
  await handler.get("miss", []);
  await handler.set("k", entry("hello"));
  await handler.get("k", []);
  await handler.updateTags(["products"], { expire: 60 });
  await handler.get("k", []);
}

describe("handlers do not read the time through Date during a prerender", () => {
  // The other test files read the time from the (fakeable) Date: see testing/clock-setup.ts.
  beforeAll(() => setClockForTests(undefined));
  afterAll(() => setClockForTests(() => Date.now()));
  beforeEach(resetCacheState);
  afterEach(resetCacheState);

  test("the Date extension aborts a prerender (guards this test's setup)", async () => {
    expect(await abortsPrerender(async () => Date.now())).toBe(true);
  });

  test("Next before 16.4 (no storage on globalThis): the storage module Next loaded is used", async () => {
    const globals = globalThis as unknown as Record<symbol, unknown>;
    const key = Object.getOwnPropertySymbols(globalThis).find((symbol) =>
      symbol.description?.startsWith("@next/work-unit-async-storage@"),
    ) as symbol;
    const storage = globals[key];
    Reflect.deleteProperty(globalThis, key);
    Object.defineProperty(performance, "timeOrigin", {
      value: performance.timeOrigin + 5_000,
      configurable: true,
    });
    setClockForTests(undefined);
    try {
      // Date is extended, so only a found storage lets the clock re-anchor here.
      expect(Math.abs(nowMs() - Date.now())).toBeLessThanOrEqual(2);
      expect(await abortsPrerender(async () => nowMs())).toBe(false);
    } finally {
      globals[key] = storage;
      Reflect.deleteProperty(performance, "timeOrigin");
      setClockForTests(undefined);
    }
  });

  test("the clock stays on wall time inside a prerender, though the performance clock is 5 s off", async () => {
    Object.defineProperty(performance, "timeOrigin", {
      value: performance.timeOrigin + 5_000,
      configurable: true,
    });
    try {
      // Anchored outside the prerender, where reading Date is safe.
      nowMs();
      let inside = 0;
      const before = Date.now();
      expect(
        await abortsPrerender(async () => {
          inside = nowMs();
        }),
      ).toBe(false);
      expect(inside).toBeGreaterThanOrEqual(before - 2);
      expect(inside).toBeLessThanOrEqual(Date.now() + 2);
    } finally {
      Reflect.deleteProperty(performance, "timeOrigin");
    }
  });

  describe('"use cache" handlers', () => {
    test("the local handler without Redis", async () => {
      const handler = createLocalCacheHandler();
      expect(await abortsPrerender(() => exercise(handler))).toBe(false);
    });

    test("the local handler with Redis", async () => {
      const handler = createLocalCacheHandler({ client: asClient(new FakeRedis()) });
      expect(await abortsPrerender(() => exercise(handler))).toBe(false);
    });

    test("the remote handler", async () => {
      const handler = createRemoteCacheHandler({ client: asClient(new FakeRedis()) });
      expect(await abortsPrerender(() => exercise(handler))).toBe(false);
    });

    test("the memory handler", async () => {
      const handler = createMemoryDataCacheHandler();
      expect(await abortsPrerender(() => exercise(handler))).toBe(false);
    });

    test("the Redis data cache handler", async () => {
      const handler = createRedisDataCacheHandler({
        redis: createIoredisAdapter(asClient(new FakeRedis()) as never),
      });
      expect(await abortsPrerender(() => exercise(handler))).toBe(false);
    });
  });

  describe("page and ISR handlers", () => {
    test("the page handler", async () => {
      const handler = new RedisCacheHandler({ client: asClient(new FakeRedis()) });
      const aborted = await abortsPrerender(async () => {
        await handler.get("/blog", { kind: "APP_PAGE", isFallback: false });
        await handler.set("/blog", page("hello"), pageCtx);
        await handler.get("/blog", { kind: "APP_PAGE", isFallback: false });
        await handler.revalidateTag("products");
        await handler.get("/blog", { kind: "APP_PAGE", isFallback: false });
      });
      expect(aborted).toBe(false);
    });

    test("the page handler reading the build output", async () => {
      const build = writeBuildOutput({ routes: { "/blog": { revalidate: 60, expire: 300 } } });
      try {
        const handler = new RedisCacheHandler({
          fs: build.fs,
          serverDistDir: build.serverDistDir,
          client: asClient(new FakeRedis()),
        });
        expect(await abortsPrerender(() => handler.get(BLOG, appPageCtx))).toBe(false);
      } finally {
        rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
      }
    });

    test("the ISR memory and composite handlers", async () => {
      const memory = new MemoryCacheHandler();
      const composite = new CompositeHandler({ handlers: [new MemoryCacheHandler()] });
      const aborted = await abortsPrerender(async () => {
        for (const handler of [memory, composite]) {
          await handler.set("fetch", fetchValue, { tags: ["products"] });
          await handler.get("fetch", { kind: "FETCH" });
          await handler.revalidateTag("products");
          await handler.get("fetch", { kind: "FETCH" });
        }
      });
      expect(aborted).toBe(false);
    });
  });
});
