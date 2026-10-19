import { afterEach, describe, expect, test, vi } from "vitest";
import { createFallbackDataCacheHandler, outageKeyCountForTests } from "./fallback.js";
import type { DataCacheEntry, DataCacheHandler } from "./types.js";

/**
 * A connection whose readiness the test controls. `goReady()` fires the ready
 * listeners like a (re)connect; `isUp = true` alone flips readiness silently.
 */
class FakeConnection {
  isUp = false;
  private readonly listeners = new Set<() => void>();
  initial: Promise<boolean> = Promise.resolve(false);

  isReady = () => this.isUp;
  waitForInitialConnection = vi.fn(() => this.initial);
  onReady = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  goReady() {
    this.isUp = true;
    for (const listener of this.listeners) listener();
  }

  goDown() {
    this.isUp = false;
  }
}

function fakeRedisHandler() {
  return {
    get: vi.fn<DataCacheHandler["get"]>(async () => undefined),
    set: vi.fn<DataCacheHandler["set"]>(async (_key, pending) => {
      await pending;
    }),
    refreshTags: vi.fn<DataCacheHandler["refreshTags"]>(async () => {}),
    getExpiration: vi.fn<DataCacheHandler["getExpiration"]>(async () => 0),
    updateTags: vi.fn<DataCacheHandler["updateTags"]>(async () => {}),
  } satisfies DataCacheHandler;
}

let tagCounter = 0;
/**
 * The memory handler keeps tag state process-wide; every test uses its own tags.
 */
function uniqueTag(): string {
  tagCounter += 1;
  return `fallback-test-tag-${tagCounter}`;
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
    timestamp: Date.now() - 1000,
    expire: 600,
    revalidate: 300,
    ...overrides,
  };
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function setup(options: { memoryFallback?: boolean; fallbackTTL?: number } = {}) {
  const connection = new FakeConnection();
  const redis = fakeRedisHandler();
  const handler = createFallbackDataCacheHandler({ redis, connection, ...options });
  return { connection, redis, handler };
}

describe("createFallbackDataCacheHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("uses Redis for every operation while the connection is ready", async () => {
    const { connection, redis, handler } = setup();
    connection.goReady();

    await handler.get("k", ["soft"]);
    await handler.set("k", Promise.resolve(createEntry("v")));
    await handler.refreshTags();
    await handler.getExpiration(["t"]);
    await handler.updateTags(["t"], { expire: 10 });

    expect(redis.get).toHaveBeenCalledWith("k", ["soft"]);
    expect(redis.set).toHaveBeenCalledTimes(1);
    expect(redis.refreshTags).toHaveBeenCalledTimes(1);
    expect(redis.getExpiration).toHaveBeenCalledWith(["t"]);
    expect(redis.updateTags).toHaveBeenCalledWith(["t"], { expire: 10 });
  });

  test("uses process memory while the connection is down", async () => {
    const { redis, handler } = setup();

    await handler.set("k", Promise.resolve(createEntry("from memory")));
    const result = await handler.get("k", []);

    if (!result) {
      throw new Error("expected the outage entry from memory");
    }
    expect(await readStream(result.value)).toBe("from memory");
    expect(await handler.getExpiration([uniqueTag()])).toBe(0);
    await handler.refreshTags();
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.getExpiration).not.toHaveBeenCalled();
    expect(redis.refreshTags).not.toHaveBeenCalled();
  });

  test("serves an outage entry for at most fallbackTTL seconds", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const { handler } = setup({ fallbackTTL: 30 });

    await handler.set(
      "k",
      Promise.resolve(createEntry("short-lived", { timestamp: start - 1000 })),
    );

    now.mockReturnValue(start + 29_000);
    expect(await handler.get("k", [])).toBeDefined();

    now.mockReturnValue(start + 30_000);
    expect(await handler.get("k", [])).toBeUndefined();
    // ...and stays gone.
    now.mockReturnValue(start + 1000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("outage bookkeeping is pruned on set, so it stays bounded during a long outage", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const { handler } = setup({ fallbackTTL: 30 });

    for (let i = 0; i < 50; i++) {
      now.mockReturnValue(start + i * 1000);
      await handler.set(
        `k${i}`,
        Promise.resolve(createEntry("v", { timestamp: start + i * 1000 })),
      );
    }
    // Only keys written in the last 30 s are tracked.
    expect(outageKeyCountForTests(handler)).toBe(30);
  });

  test("defaults fallbackTTL to 60 seconds", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const { handler } = setup();

    await handler.set("k", Promise.resolve(createEntry("v", { timestamp: start - 1000 })));

    now.mockReturnValue(start + 59_000);
    expect(await handler.get("k", [])).toBeDefined();
    now.mockReturnValue(start + 60_000);
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("empties memory on reconnect, so an outage entry never shadows Redis", async () => {
    const { connection, redis, handler } = setup();

    await handler.set("k", Promise.resolve(createEntry("outage")));
    expect(await handler.get("k", [])).toBeDefined();

    // Redis is back: reads go to Redis, which misses.
    connection.goReady();
    expect(await handler.get("k", [])).toBeUndefined();
    expect(redis.get).toHaveBeenCalledWith("k", []);

    // Redis goes down again: the entry from the first outage is gone too.
    connection.goDown();
    expect(await handler.get("k", [])).toBeUndefined();
  });

  test("updateTags reaches memory always and Redis only when ready", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { connection, redis, handler } = setup();
    const downTag = uniqueTag();
    const upTag = uniqueTag();

    // Down: memory only, and the gap is logged.
    await handler.set("down", Promise.resolve(createEntry("v", { tags: [downTag] })));
    await handler.updateTags([downTag]);
    expect(redis.updateTags).not.toHaveBeenCalled();
    expect(await handler.get("down", [])).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("updateTags failed");
    expect(String(errorSpy.mock.calls[0][1])).toContain(downTag);
    expect(String(errorSpy.mock.calls[0][1])).toContain("memory only");

    // Up (without a reconnect event, so memory is kept): both.
    await handler.set("up", Promise.resolve(createEntry("v", { tags: [upTag] })));
    connection.isUp = true;
    await handler.updateTags([upTag]);
    expect(redis.updateTags).toHaveBeenCalledWith([upTag], undefined);
    connection.goDown();
    expect(await handler.get("up", [])).toBeUndefined();
    // No warning when Redis got it.
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("rate-limits the memory-only updateTags warning", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const connection = new FakeConnection();
    const handler = createFallbackDataCacheHandler({
      redis: fakeRedisHandler(),
      connection,
      errorLogIntervalMs: 60_000,
    });

    for (let i = 0; i < 5; i++) {
      await handler.updateTags([uniqueTag()]);
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("waits for the initial connection before choosing Redis or memory", async () => {
    const { connection, redis, handler } = setup();
    let resolveInitial: (ready: boolean) => void = () => {};
    connection.initial = new Promise((resolve) => {
      resolveInitial = resolve;
    });

    let settled = false;
    const getPromise = handler.get("k", []).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(redis.get).not.toHaveBeenCalled();

    connection.goReady();
    resolveInitial(true);
    await getPromise;
    expect(connection.waitForInitialConnection).toHaveBeenCalled();
    expect(redis.get).toHaveBeenCalledWith("k", []);
  });

  test("memoryFallback: false misses during an outage and cancels the entry's stream", async () => {
    const { redis, handler } = setup({ memoryFallback: false });
    const cancel = vi.fn();
    const entry: DataCacheEntry = {
      ...createEntry(""),
      value: new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel,
      }),
    };

    await handler.set("k", Promise.resolve(entry));
    expect(cancel).toHaveBeenCalled();
    expect(await handler.get("k", [])).toBeUndefined();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.get).not.toHaveBeenCalled();
  });

  test("memoryFallback: false tolerates a rejected entry", async () => {
    const { handler } = setup({ memoryFallback: false });
    await expect(handler.set("k", Promise.reject(new Error("render failed")))).resolves.toBe(
      undefined,
    );
  });
});
