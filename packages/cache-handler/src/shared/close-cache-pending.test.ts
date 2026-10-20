/**
 * `closeCache()` never drops an invalidation Redis has not acknowledged: it tries to send it one
 * last time, and what is still unsent stays in the tag state of its connection and key prefix,
 * which the next runtime of that key uses: it keeps applying it locally and sends it once Redis
 * takes it. An update on a closed runtime goes to the live runtime of its key.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  created: [] as FakeRedis[],
  /** Tag writes are refused with READONLY (a failover) while set. */
  readonly: false,
  /** When set, the next tag write waits for this promise instead. */
  hold: undefined as Promise<void> | undefined,
  /** Tag index writes (ZADD) are refused while set, whatever happens to the records. */
  refuseIndex: false,
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
        const zadd = client.zadd.bind(client);
        vi.spyOn(client, "zadd").mockImplementation(async (...args) => {
          if (redis.refuseIndex) throw new Error("OOM command not allowed");
          return zadd(...args);
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
import { FLUSH_TAG, tagIndexKey } from "./keys.js";
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

/**
 * The tag state registry, one state per key: connections of the package's own by pool key and
 * prefix, application clients by the client object (a `WeakMap`), then prefix.
 */
function slot(): { pooled: Map<string, unknown>; clients: WeakMap<object, Map<string, unknown>> } {
  const global = globalThis as unknown as Record<symbol, unknown>;
  const value = global[Symbol.for("@mrjasonroy/cache-components-cache-handler/tag-states")];
  if (!value) return { pooled: new Map(), clients: new WeakMap() };
  return value as ReturnType<typeof slot>;
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
    redis.refuseIndex = false;
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

  test("an update whose record was written but whose index write failed is replayed after closeCache", async () => {
    const data = createRemoteCacheHandler(options);
    redis.refuseIndex = true;
    await data.updateTags(["products"]);
    // Redis took the record but not the index entry other processes sync from.
    expect(redisRecord("products")).toBeDefined();
    const index = () =>
      redis.items.get(tagIndexKey("app:"))?.value as Map<string, number> | undefined;
    expect(index()?.get("products")).toBeUndefined();

    await closeCache();
    expect(index()?.get("products")).toBeUndefined();
    expect(getCacheRuntime(options).tags.hasUnsent()).toBe(true);

    redis.refuseIndex = false;
    await syncNow();
    expect(index()?.get("products")).toBeGreaterThan(0);
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
    redis.hold = new Promise<void>((_, reject) => {
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

  test("closeCache waits for a send in flight; once Redis takes it, nothing is kept", async () => {
    const data = createRemoteCacheHandler(options);
    let answer: () => void = () => {};
    redis.hold = new Promise<void>((resolve) => {
      answer = resolve;
    });

    const updating = data.updateTags(["products"]);
    await vi.waitFor(() => expect(redis.hold).toBeUndefined());
    let closed = false;
    const closing = closeCache().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(closed).toBe(false);

    answer();
    await Promise.all([updating, closing]);
    expect(redisRecord("products")).toBeDefined();
    expect(slot().pooled.size).toBe(0);
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

  test("closing 100 prefixes after acknowledged updates leaves nothing in the slot", async () => {
    for (let i = 0; i < 100; i++) {
      await getCacheRuntime({ url, keyPrefix: `tenant${i}:` }).tags.update(["products"]);
    }
    await closeCache();
    expect(slot().pooled.size).toBe(0);
  });

  test("a runtime created mid-close owns the one state of its key; nothing else is kept", async () => {
    await getCacheRuntime(options).tags.update(["products"]);
    const closing = closeCache();
    const adopter = getCacheRuntime(options);
    await closing;
    expect(slot().pooled.size).toBe(1);

    expect(adopter.tags.get("products")).toBeDefined();
    await adopter.tags.update(["orders"]);
    expect(adopter.tags.hasUnsent()).toBe(false);
    expect(redisRecord("orders")).toBeDefined();
    await closeCache();
    expect(slot().pooled.size).toBe(0);
  });

  test("a refused update keeps exactly its entry until it is adopted and replayed", async () => {
    await getCacheRuntime({ url, keyPrefix: "other:" }).tags.update(["products"]);
    redis.readonly = true;
    await getCacheRuntime(options).tags.update(["products"]);
    await closeCache();
    expect(slot().pooled.size).toBe(1);

    redis.readonly = false;
    await syncNow();
    expect(redisRecord("products")).toBeDefined();
    // Now the live runtime's own state; a close with nothing unsent drops it.
    await closeCache();
    expect(slot().pooled.size).toBe(0);
  });

  test("a replaced application client's kept state is held by the client, not the global map", async () => {
    const client = new FakeRedis();
    vi.spyOn(client, "evalsha").mockRejectedValue(new Error("READONLY"));
    await getCacheRuntime({ client: asClient(client), keyPrefix: "app:" }).tags.update([
      "products",
    ]);
    await closeCache();

    expect(slot().pooled.size).toBe(0);
    expect(slot().clients.get(client)?.size).toBe(1);
  });

  test("an update on a closed runtime goes to the live runtime of its key", async () => {
    const old = getCacheRuntime(options);
    await old.tags.update(["products"]);
    await closeCache();
    expect(slot().pooled.size).toBe(0);

    // A handler call that resolved the runtime before the close, and revalidates after it.
    await old.tags.update(["late"]);
    expect(getCacheRuntime(options).tags.get("late")).toBeDefined();
    expect(redisRecord("late")).toBeDefined();
    await closeCache();
    expect(slot().pooled.size).toBe(0);
  });

  test("gate-3 M3: a refused late update on a closed runtime reaches the runtimes after it", async () => {
    const client = new FakeRedis();
    let refusing = false;
    const evalsha = client.evalsha.bind(client);
    vi.spyOn(client, "evalsha").mockImplementation(async (...args) => {
      if (refusing) throw new Error("READONLY You can't write against a read only replica.");
      return evalsha(...args);
    });
    const clientOptions = { client: asClient(client), keyPrefix: "app:" };
    const a = getCacheRuntime(clientOptions);
    await closeCache();
    getCacheRuntime(clientOptions); // B
    refusing = true;
    await a.tags.update(["lost"]);
    await closeCache();

    const c = getCacheRuntime(clientOptions);
    expect(c.tags.get("lost")).toBeDefined();
    expect(c.tags.hasUnsent()).toBe(true);
    refusing = false;
    await c.tags.sync();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((client.items.get("app:tags")?.value as Map<string, string>).get("lost")).toBeDefined();
  });

  test("an application client shared by many prefixes keeps a bounded number of listeners", async () => {
    const client = new FakeRedis();
    getCacheRuntime({ client: asClient(client), keyPrefix: "tenant0:" });
    const baseline = client.listenerCount("ready");
    for (let i = 1; i < 50; i++)
      getCacheRuntime({ client: asClient(client), keyPrefix: `tenant${i}:` });
    expect(client.listenerCount("ready")).toBe(baseline);
    for (let i = 0; i < 20; i++) {
      await closeCache();
      getCacheRuntime({ client: asClient(client), keyPrefix: "tenant0:" });
    }
    expect(client.listenerCount("ready")).toBe(baseline);
    expect(client.listenerCount("error")).toBe(1);
  });

  test("gate-3 M4: acknowledged late updates on 100 closed prefixes leave no state after a close", async () => {
    const client = new FakeRedis();
    for (let i = 0; i < 100; i++) {
      const old = getCacheRuntime({ client: asClient(client), keyPrefix: `tenant${i}:` });
      await closeCache();
      await old.tags.update(["ack"]);
    }
    await closeCache();
    expect(slot().clients.get(client)?.size ?? 0).toBe(0);
    expect(
      (client.items.get("tenant99:tags")?.value as Map<string, string>).get("ack"),
    ).toBeDefined();
  });
});
