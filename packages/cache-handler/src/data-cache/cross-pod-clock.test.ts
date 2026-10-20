/**
 * Two instances sharing Redis whose performance clocks disagree with wall time by 5 s, as a pod
 * after days of uptime or a suspended VM can. Next stamps an entry's `timestamp` on its
 * performance clock; the instances must still order a revalidation and an entry by wall time
 * (../shared/clock.ts).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { asClient } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import type { DataCacheEntry, DataCacheHandler } from "./types.js";

const SKEW_MS = 5_000;
/** `revalidateTag(tag, { expire: 3600 })`: entries from before it are served stale for an hour. */
const REVALIDATE = { expire: 3600 };
const realTimeOrigin = performance.timeOrigin;

/** Make the performance clock read `skew` ms off wall time. */
function skewPerformanceClock(skew: number): void {
  Object.defineProperty(performance, "timeOrigin", {
    value: realTimeOrigin + skew,
    configurable: true,
  });
}

/** What Next's own handler stamps an entry with. */
function nextTimestamp(): number {
  return performance.timeOrigin + performance.now();
}

function entry(text: string, tags: string[]): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags,
    stale: 300,
    timestamp: nextTimestamp(),
    expire: 3600,
    revalidate: 900,
  });
}

/** One instance: its own module graph, so its own clock offset. */
interface Pod {
  skew: number;
  handler: DataCacheHandler;
}

type Kind = "redis data cache" | "remote";

async function startPod(kind: Kind, redis: FakeRedis, skew: number): Promise<Pod> {
  vi.resetModules();
  skewPerformanceClock(skew);
  // The setup file's test clock is on the previous module graph: this one reads the real clocks.
  if (kind === "remote") {
    const { createRemoteCacheHandler } = await import("./remote.js");
    return { skew, handler: createRemoteCacheHandler({ client: asClient(redis) }) };
  }
  const { createRedisDataCacheHandler } = await import("./redis.js");
  const { createIoredisAdapter } = await import("./ioredis-adapter.js");
  return {
    skew,
    handler: createRedisDataCacheHandler({ redis: createIoredisAdapter(asClient(redis) as never) }),
  };
}

/** Run `fn` as `pod`: with its performance clock. */
async function on<T>(pod: Pod, fn: (handler: DataCacheHandler) => Promise<T>): Promise<T> {
  skewPerformanceClock(pod.skew);
  return fn(pod.handler);
}

/** Let the wall clock move on, so two events are distinct milliseconds apart. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe.each<Kind>(["redis data cache", "remote"])("%s: instances with skewed clocks", (kind) => {
  afterEach(() => {
    Reflect.deleteProperty(performance, "timeOrigin");
    vi.resetModules();
  });

  test("an entry rendered after a revalidation stays fresh, though its writer's clock is behind", async () => {
    const redis = new FakeRedis();
    const revalidator = await startPod(kind, redis, 0);
    const writer = await startPod(kind, redis, -SKEW_MS);

    await on(revalidator, (handler) => handler.updateTags(["products"], REVALIDATE));
    await tick();
    await on(writer, (handler) => handler.set("key", entry("new", ["products"])));

    const found = await on(revalidator, (handler) => handler.get("key", []));
    expect(found?.revalidate).toBe(900);
  });

  test("an entry rendered before a revalidation is stale, though its writer's clock is ahead", async () => {
    const redis = new FakeRedis();
    const revalidator = await startPod(kind, redis, 0);
    const writer = await startPod(kind, redis, SKEW_MS);

    await on(writer, (handler) => handler.set("key", entry("old", ["products"])));
    await tick();
    await on(revalidator, (handler) => handler.updateTags(["products"], REVALIDATE));

    const found = await on(revalidator, (handler) => handler.get("key", []));
    expect(found?.revalidate).toBe(-1);
  });

  test("each instance hands Next the entry's timestamp on its own clock", async () => {
    const redis = new FakeRedis();
    const writer = await startPod(kind, redis, SKEW_MS);
    const reader = await startPod(kind, redis, -SKEW_MS);

    const written = await entry("value", []);
    await on(writer, (handler) => handler.set("key", Promise.resolve(written)));

    const found = await on(reader, (handler) => handler.get("key", []));
    // Written 5 s ahead of wall time, read 5 s behind it: 10 s apart on the two clocks.
    expect(found?.timestamp).toBeGreaterThan(written.timestamp - 2 * SKEW_MS - 1_000);
    expect(found?.timestamp).toBeLessThan(written.timestamp - 2 * SKEW_MS + 1_000);
  });
});

describe("page handler: instances with skewed clocks", () => {
  afterEach(() => {
    Reflect.deleteProperty(performance, "timeOrigin");
    vi.resetModules();
  });

  const page = {
    kind: "APP_PAGE",
    html: "<p>old</p>",
    rscData: Buffer.from("rsc"),
    segmentData: new Map(),
    headers: { "x-next-cache-tags": "products" },
    postponed: undefined,
    status: 200,
  } as const;
  const ctx = { kind: "APP_PAGE", isFallback: false } as const;

  async function startPagePod(redis: FakeRedis, skew: number) {
    vi.resetModules();
    skewPerformanceClock(skew);
    const { RedisCacheHandler } = await import("../handlers/redis.js");
    return new RedisCacheHandler({ client: asClient(redis) });
  }

  test("a page rendered before a revalidation is stale, though its writer's clock is ahead", async () => {
    const redis = new FakeRedis();
    const revalidator = await startPagePod(redis, 0);
    const writer = await startPagePod(redis, SKEW_MS);

    skewPerformanceClock(SKEW_MS);
    await writer.set("/blog", page, { cacheControl: { revalidate: 60, expire: 3600 } });
    await tick();
    skewPerformanceClock(0);
    await revalidator.revalidateTag("products", REVALIDATE);

    const found = await revalidator.get("/blog", ctx);
    // Stale: Next sees `lastModified` past the revalidate period on its own clock.
    expect(found?.lastModified).toBeLessThanOrEqual(nextTimestamp() - 60_000);
  });
});
