/**
 * `closeCache()` never drops an invalidation Redis has not acknowledged: it tries to send it one
 * last time, and what is still unsent passes to the next tag store of the same connection and
 * key prefix in this process, which keeps applying it locally and sends it once Redis takes it.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  created: [] as FakeRedis[],
  /** Tag writes are refused with READONLY (a failover) while set. */
  readonly: false,
  /** When set, the next tag write waits for this promise instead. */
  hold: undefined as Promise<never> | undefined,
}));

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => {
  const { FakeRedis: Fake } = await import("../testing/fake-redis.js");
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
      return function Redis() {
        const client = new Fake(redis.items);
        const evalsha = client.evalsha.bind(client);
        vi.spyOn(client, "evalsha").mockImplementation(async (...args) => {
          const held = redis.hold;
          redis.hold = undefined;
          if (held) await held;
          if (redis.readonly)
            throw new Error("READONLY You can't write against a read only replica.");
          return evalsha(...args);
        });
        redis.created.push(client);
        return client;
      };
    },
  };
});

import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import { closeCache, flushCache } from "../index.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FLUSH_TAG } from "./keys.js";
import { getCacheRuntime } from "./runtime.js";

const url = "redis://pending-test:6379";
const options = { url, keyPrefix: "app:", buildId: "b1" };

function entry(text: string): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    tags: ["products"],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

/** The tag record Redis holds for `tag`, if any. */
function redisRecord(tag: string): string | undefined {
  return (redis.items.get("app:tags")?.value as Map<string, string> | undefined)?.get(tag);
}

/** A sync of the current runtime, and the resend it starts. */
async function syncNow(): Promise<void> {
  await getCacheRuntime(options).tags.sync();
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("closeCache with invalidations Redis has not taken", () => {
  beforeEach(async () => {
    await resetCacheState();
    redis.items = new Map();
    redis.created = [];
    redis.readonly = false;
    redis.hold = undefined;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("a refused update stays in effect after closeCache and reaches Redis once it takes writes", async () => {
    const data = createRemoteCacheHandler(options);
    await data.set("k", entry("old"));
    await new Promise((resolve) => setTimeout(resolve, 2));

    redis.readonly = true;
    await data.updateTags(["products"]);
    expect(redisRecord("products")).toBeUndefined();
    expect(await data.get("k", [])).toBeUndefined();

    await closeCache();

    // Reused after the close, on a new connection: this process still does not serve the entry.
    expect(await data.get("k", [])).toBeUndefined();
    expect(redis.created).toHaveLength(2);

    redis.readonly = false;
    await syncNow();
    expect(redisRecord("products")).toBeDefined();
    expect(getCacheRuntime(options).tags.hasUnsent()).toBe(false);
  });

  test("closeCache sends what is pending one last time when Redis takes it", async () => {
    const data = createRemoteCacheHandler(options);
    redis.readonly = true;
    await data.updateTags(["products"]);
    redis.readonly = false;

    await closeCache();
    expect(redisRecord("products")).toBeDefined();
  });

  test("a shared flush whose barrier was refused records it after closeCache", async () => {
    const data = createRemoteCacheHandler(options);
    await data.set("k", entry("x"));
    redis.readonly = true;
    await flushCache({ ...options, scope: "all" });
    expect(redisRecord(FLUSH_TAG)).toBeUndefined();

    await closeCache();
    expect(getCacheRuntime(options).tags.get(FLUSH_TAG)).toBeDefined();

    redis.readonly = false;
    await syncNow();
    expect(redisRecord(FLUSH_TAG)).toBeDefined();
  });

  test("a send in flight when closeCache starts, and refused after, is kept", async () => {
    const data = createRemoteCacheHandler(options);
    await data.set("k", entry("x"));
    let refuse: (error: Error) => void = () => {};
    redis.hold = new Promise<never>((_, reject) => {
      refuse = reject;
    });
    redis.readonly = true;

    const updating = data.updateTags(["products"]);
    // The batch has left the queue and is waiting for Redis's answer.
    await vi.waitFor(() => expect(redis.hold).toBeUndefined());
    expect(getCacheRuntime(options).tags.hasUnsent()).toBe(false);
    const closing = closeCache();
    refuse(new Error("READONLY You can't write against a read only replica."));
    await Promise.all([updating, closing]);

    expect(getCacheRuntime(options).tags.get("products")).toBeDefined();
    redis.readonly = false;
    await syncNow();
    expect(redisRecord("products")).toBeDefined();
  });

  test("with an application client, the same client's next tag store takes the update over", async () => {
    const client = new FakeRedis();
    let refusing = true;
    const evalsha = client.evalsha.bind(client);
    vi.spyOn(client, "evalsha").mockImplementation(async (...args) => {
      if (refusing) throw new Error("READONLY You can't write against a read only replica.");
      return evalsha(...args);
    });
    const clientOptions = { client: asClient(client), keyPrefix: "app:", buildId: "b1" };
    const data = createRemoteCacheHandler(clientOptions);
    await data.set("k", entry("old"));
    await new Promise((resolve) => setTimeout(resolve, 2));
    await data.updateTags(["products"]);

    await closeCache();
    expect(await data.get("k", [])).toBeUndefined();

    refusing = false;
    await getCacheRuntime(clientOptions).tags.sync();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      (client.items.get("app:tags")?.value as Map<string, string>).get("products"),
    ).toBeDefined();
  });
});
