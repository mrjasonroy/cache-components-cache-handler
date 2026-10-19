import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { createLocalCacheHandler } from "./local.js";
import { REFRESH_TAGS_INTERVAL_MS } from "./remote.js";
import type { DataCacheEntry } from "./types.js";

function entry(text: string, overrides: Partial<DataCacheEntry> = {}): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags: ["products"],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
    ...overrides,
  });
}

async function read(result: DataCacheEntry | undefined): Promise<string | undefined> {
  return result ? new Response(result.value).text() : undefined;
}

describe("createLocalCacheHandler", () => {
  beforeEach(resetCacheState);

  afterEach(async () => {
    vi.useRealTimers();
    await resetCacheState();
  });

  test("keeps values in process memory, never in Redis", async () => {
    const fake = new FakeRedis();
    const handler = createLocalCacheHandler({ client: asClient(fake) });
    await handler.set("k", entry("hello"));
    expect(await read(await handler.get("k", []))).toBe("hello");
    expect(fake.commands.filter((c) => c === "set")).toHaveLength(0);
  });

  test("drops a value once its revalidate period has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const handler = createLocalCacheHandler();
    await handler.set("k", entry("x"));
    vi.setSystemTime(Date.now() + 60_001);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("a revalidation on one instance invalidates another's memory value", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const shared = new FakeRedis();
    const a = createLocalCacheHandler({ client: asClient(shared) });
    const b = createLocalCacheHandler({ client: asClient(new FakeRedis(shared.items)) });
    await b.set("k", entry("x"));

    vi.setSystemTime(Date.now() + 10);
    await a.updateTags(["products"]);
    vi.setSystemTime(Date.now() + REFRESH_TAGS_INTERVAL_MS);
    await b.refreshTags();
    expect(await b.get("k", [])).toBeUndefined();
  });

  test("updateTags with durations serves stale (revalidate -1)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const handler = createLocalCacheHandler();
    await handler.set("k", entry("x"));
    vi.setSystemTime(Date.now() + 10);
    await handler.updateTags(["products"], { expire: 3600 });
    expect((await handler.get("k", []))?.revalidate).toBe(-1);
  });
});
