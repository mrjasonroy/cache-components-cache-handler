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
vi.mock("./node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
    return function Redis() {
      return redis.build?.();
    };
  },
}));

import { resetCacheState } from "../testing/env.js";
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
});
