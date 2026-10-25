/**
 * Which Redis client `flushCache` uses: the handlers' shared one when they have opened it, and
 * otherwise one of its own, closed before it returns or throws. That a process then exits is
 * checked for real in flush-exit.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  items: new Map(),
  created: [] as FakeRedis[],
  // The constructor ioredis is replaced with; set in beforeEach, once FakeRedis is loaded.
  build: undefined as (() => FakeRedis) | undefined,
}));

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
// The AWS packages (for IAM) load for real.
vi.mock("./node-require.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./node-require.js")>();
  return {
    ...original,
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") return original.requireModule(moduleName);
      return function Redis() {
        return redis.build?.();
      };
    },
  };
});

import { resetCacheState } from "../testing/env.js";
import { DEFAULT_INITIAL_CONNECT_WAIT_MS } from "./connection.js";
import { flushCache } from "./flush.js";
import { getCacheRuntime } from "./runtime.js";

const url = "redis://flush-test:6379";

describe("flushCache: the Redis client it uses", () => {
  beforeEach(async () => {
    await resetCacheState();
    redis.items = new Map();
    redis.created = [];
    redis.build = () => {
      const client = new FakeRedis(redis.items);
      vi.spyOn(client, "quit");
      redis.created.push(client);
      return client;
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("no handler opened the connection: it opens its own and quits it", async () => {
    redis.items.set("app:development:page:/a", { value: "x" });
    expect(await flushCache({ url, keyPrefix: "app:" })).toEqual({ deleted: 1 });

    expect(redis.created).toHaveLength(1);
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
    // Nothing was left in the shared pool: a handler opens a client of its own.
    getCacheRuntime({ url, keyPrefix: "app:" });
    expect(redis.created).toHaveLength(2);
  });

  test("its own runtime leaves nothing registered: no memory store outlives the flush", async () => {
    const stores = (globalThis as unknown as Record<symbol, Set<unknown>>)[
      Symbol.for("@mrjasonroy/cache-components-cache-handler/memory-stores")
    ];
    const before = stores.size;
    for (let i = 0; i < 10; i++) await flushCache({ url, keyPrefix: "app:" });
    expect(redis.created).toHaveLength(10);
    expect(stores.size).toBe(before);
  });

  test("a handler opened the connection: it is reused and left open", async () => {
    getCacheRuntime({ url, keyPrefix: "app:" });
    expect(await flushCache({ url, keyPrefix: "app:" })).toEqual({ deleted: 0 });

    expect(redis.created).toHaveLength(1);
    expect(redis.created[0].quit).not.toHaveBeenCalled();
  });

  test("its own connection is quit when the flush throws", async () => {
    await expect(flushCache({ url, keyPrefix: "", scope: "all" })).rejects.toThrow(
      /empty keyPrefix/,
    );
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
  });

  test("its own connection is quit when Redis is unavailable", async () => {
    redis.build = () => {
      const client = new FakeRedis(redis.items);
      client.status = "connecting";
      vi.spyOn(client, "quit");
      redis.created.push(client);
      return client;
    };
    await expect(flushCache({ url, keyPrefix: "app:" })).rejects.toThrow(/unavailable/);
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
  });

  test("on its own connection, a flush whose barrier Redis did not take fails: nothing would resend it", async () => {
    redis.build = () => {
      const client = new FakeRedis(redis.items);
      vi.spyOn(client, "evalsha").mockRejectedValue(new Error("READONLY"));
      vi.spyOn(client, "quit");
      redis.created.push(client);
      return client;
    };
    await expect(flushCache({ url, keyPrefix: "app:" })).rejects.toThrow(
      /could not record the flush/,
    );
    expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
  });

  describe("with IAM, whose first connect waits for credentials and a signed token", () => {
    /** A client created `lazyConnect`, as with IAM: it connects when `connect` is called. */
    const lazyClient = () => {
      const client = Object.assign(new FakeRedis(redis.items), {
        options: {} as Record<string, unknown>,
        connect: async () => client.comeUp(),
      });
      client.status = "wait";
      vi.spyOn(client, "quit");
      redis.created.push(client);
      return client;
    };
    const iamUrl = "rediss://flush-test:6379";
    const iam = (credentialsAfterMs: number) => ({
      userId: "app-user",
      cacheName: "my-cache",
      region: "us-east-1",
      credentials: () =>
        new Promise<{ accessKeyId: string; secretAccessKey: string }>((resolve) => {
          setTimeout(
            () => resolve({ accessKeyId: "AKID", secretAccessKey: "s" }),
            credentialsAfterMs,
          );
        }),
    });

    beforeEach(() => {
      vi.useFakeTimers();
      redis.build = lazyClient;
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("a flush on its own connection waits past the request wait for a slow token", async () => {
      redis.items.set("app:development:page:/a", { value: "x" });
      const result = flushCache({ url: iamUrl, keyPrefix: "app:", iam: iam(3000) });
      await vi.advanceTimersByTimeAsync(3000);

      expect(await result).toEqual({ deleted: 1 });
      expect(
        (redis.created[0] as unknown as { options: Record<string, unknown> }).options.username,
      ).toBe("app-user");
      expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
    });

    test("it gives up after 5 s when no token comes, and quits its connection", async () => {
      const result = flushCache({ url: iamUrl, keyPrefix: "app:", iam: iam(60_000) });
      const settled = vi.fn();
      result.then(settled, settled);

      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).rejects.toThrow(/unavailable/);
      expect(redis.created[0].quit).toHaveBeenCalledTimes(1);
    });

    test("a request on the same IAM connection still waits only the request wait", async () => {
      const runtime = getCacheRuntime({ url: iamUrl, keyPrefix: "app:", iam: iam(3000) });
      const connection = runtime.connection;
      if (!connection) throw new Error("expected a connection");
      const ready = vi.fn();
      void connection.waitForInitialConnection().then(ready);

      await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_CONNECT_WAIT_MS);
      expect(ready).toHaveBeenCalledWith(false);

      // A flush through the handlers' connection waits on until the token comes.
      const result = flushCache({ url: iamUrl, keyPrefix: "app:", iam: iam(3000) });
      await vi.advanceTimersByTimeAsync(2500);
      expect(await result).toEqual({ deleted: 0 });
      expect(redis.created).toHaveLength(1);
    });
  });
});
