import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MAX_ENTRY_AGE_SECONDS } from "../shared/keys.js";
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
    await handler.refreshTags();
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

  test("no value is served past the longest entry age, whatever its revalidate period", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const handler = createLocalCacheHandler();
    const days = 86_400;
    await handler.set("k", entry("x", { revalidate: 500 * days, expire: 600 * days }));
    vi.setSystemTime(Date.now() + MAX_ENTRY_AGE_SECONDS * 1000 - 1_000);
    expect(await read(await handler.get("k", []))).toBe("x");
    vi.setSystemTime(Date.now() + 1_000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("a 500-day value, invalidated, is still a miss after 366+ days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const days = 86_400;
    const handler = createLocalCacheHandler({ client: asClient(new FakeRedis()) });
    await handler.set("k", entry("x", { revalidate: 500 * days, expire: 600 * days }));
    vi.setSystemTime(Date.now() + 10);
    await handler.updateTags(["products"]);
    expect(await handler.get("k", [])).toBeUndefined();

    // Past the 366 days after which tag records used to be pruned, with syncs in between: the
    // record is still there, and the value is past the longest entry age anyway.
    for (let day = 0; day <= 367; day += 61) {
      vi.setSystemTime(Date.now() + 61 * days * 1000);
      await handler.refreshTags();
    }
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("with Redis, a value is a miss until tags have synced since the last (re)connect", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fake = new FakeRedis();
    const handler = createLocalCacheHandler({ client: asClient(fake) });
    await handler.set("k", entry("x"));
    expect(await handler.get("k", [])).toBeUndefined();
    await handler.refreshTags();
    expect(await read(await handler.get("k", []))).toBe("x");

    // Reconnected: another instance may have revalidated meanwhile.
    fake.goDown();
    fake.comeUp();
    expect(await handler.get("k", [])).toBeUndefined();
    await handler.refreshTags();
    expect(await read(await handler.get("k", []))).toBe("x");

    // A failed sync: whatever it missed could invalidate this value.
    vi.spyOn(fake, "zrangebyscore").mockRejectedValueOnce(new Error("LOADING"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.setSystemTime(Date.now() + REFRESH_TAGS_INTERVAL_MS);
    await handler.refreshTags();
    expect(await handler.get("k", [])).toBeUndefined();
  });
});
