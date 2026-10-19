import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { closeAllRedisConnections } from "../shared/connection.js";
import type { DataCacheHandler } from "./types.js";

/**
 * Enough of an ioredis client for the factory and the shared connection: the
 * data commands, events, `status`, `sendCommand` and the close methods.
 */
class FakeIoredis extends EventEmitter {
  status = "connecting";
  get = vi.fn();
  getBuffer = vi.fn();
  set = vi.fn();
  del = vi.fn();
  exists = vi.fn();
  ttl = vi.fn();
  hget = vi.fn();
  hset = vi.fn();
  hgetall = vi.fn();
  expire = vi.fn();
  sendCommand = vi.fn();
  quit = vi.fn(async () => "OK");
  disconnect = vi.fn();
}

const createFakeRedis = () => new FakeIoredis();

interface ResilienceConfig {
  retryStrategy: (times: number) => number | null;
  maxRetriesPerRequest: number;
  enableOfflineQueue: boolean;
  commandTimeout: number;
}

// Every client the factory builds must keep reconnecting forever (a routine
// failover must not disable caching until restart) and must fail commands fast
// while disconnected (a cache must never hang a page render).
function expectResilientClient(config: ResilienceConfig) {
  for (const times of [1, 3, 4, 10, 100, 10_000]) {
    const delay = config.retryStrategy(times);
    expect(delay).toBeTypeOf("number");
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5000);
  }
  expect(config.retryStrategy(1)).toBe(200);
  expect(config.retryStrategy(4)).toBe(800);
  expect(config.retryStrategy(1000)).toBe(5000);
  expect(config.maxRetriesPerRequest).toBe(1);
  expect(config.commandTimeout).toBeGreaterThan(0);
  expect(config.commandTimeout).toBeLessThanOrEqual(5000);
}

const redisConstructorMock = vi.hoisted(() =>
  vi.fn<[], ReturnType<typeof createFakeRedis>>(() => createFakeRedis()),
);

const redisHandlerFactoryMock = vi.hoisted(() =>
  vi.fn(
    (): DataCacheHandler => ({
      get: vi.fn(),
      set: vi.fn(),
      refreshTags: vi.fn(),
      getExpiration: vi.fn(),
      updateTags: vi.fn(),
    }),
  ),
);

vi.mock("node:module", () => ({
  createRequire: () => (moduleName: string) => {
    if (moduleName === "ioredis") {
      return redisConstructorMock;
    }
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

vi.mock("./redis.js", async () => {
  const actual = await vi.importActual<typeof import("./redis.js")>("./redis.js");
  return {
    ...actual,
    createRedisDataCacheHandler: redisHandlerFactoryMock,
  };
});

import { createCacheHandler } from "./factory.js";

describe("createCacheHandler factory", () => {
  afterEach(async () => {
    // Connections are shared per process; each test starts with none.
    await closeAllRedisConnections();
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    redisConstructorMock.mockClear();
    redisConstructorMock.mockImplementation(() => createFakeRedis());
    redisHandlerFactoryMock.mockClear();
    redisHandlerFactoryMock.mockImplementation(
      () =>
        ({
          get: vi.fn(),
          set: vi.fn(),
          refreshTags: vi.fn(),
          getExpiration: vi.fn(),
          updateTags: vi.fn(),
        }) satisfies DataCacheHandler,
    );
    Reflect.deleteProperty(process.env, "REDIS_URL");
    Reflect.deleteProperty(process.env, "VALKEY_URL");
    Reflect.deleteProperty(process.env, "REDIS_PASSWORD");
    Reflect.deleteProperty(process.env, "ELASTICACHE_ENDPOINT");
    Reflect.deleteProperty(process.env, "ELASTICACHE_PORT");
    Reflect.deleteProperty(process.env, "ELASTICACHE_TLS");
    Reflect.deleteProperty(process.env, "ELASTICACHE_AUTH_TOKEN");
  });

  test("creates memory handler when type is memory", () => {
    const handler = createCacheHandler({ type: "memory" });
    expect(handler).toBeDefined();
    expect(handler.get).toBeTypeOf("function");
    expect(redisConstructorMock).not.toHaveBeenCalled();
  });

  test("passes password and tls overrides to ioredis constructor", () => {
    process.env.REDIS_PASSWORD = "env-secret";

    createCacheHandler({
      type: "redis",
      url: "redis://cache:6379",
      tls: true,
    });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      "redis://cache:6379",
      expect.objectContaining({
        password: "env-secret",
        tls: {},
      }),
    );
  });

  test("falls back to VALKEY_URL when no explicit url provided", () => {
    process.env.VALKEY_URL = "redis://valkey.internal:6380";

    createCacheHandler({
      type: "valkey",
    });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      "redis://valkey.internal:6380",
      expect.any(Object),
    );
  });

  test("passes no password or tls when none configured", () => {
    createCacheHandler({
      type: "redis",
      url: "redis://no-auth",
    });

    expect(redisConstructorMock).toHaveBeenCalledWith("redis://no-auth", expect.any(Object));
    const config = redisConstructorMock.mock.calls[0][1] as Record<string, unknown>;
    expect(config).not.toHaveProperty("password");
    expect(config).not.toHaveProperty("tls");
  });

  test("redis/valkey client reconnects forever and fails commands fast", () => {
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    expectResilientClient(redisConstructorMock.mock.calls[0][1] as ResilienceConfig);
  });

  test("elasticache client reconnects forever and fails commands fast", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster";
    createCacheHandler({ type: "elasticache" });
    expectResilientClient(redisConstructorMock.mock.calls[0][0] as ResilienceConfig);
  });

  test("fails fast while disconnected: no offline queue, 1s command timeout by default", () => {
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    expect(redisConstructorMock).toHaveBeenCalledWith(
      "redis://cache:6379",
      expect.objectContaining({ enableOfflineQueue: false, commandTimeout: 1000 }),
    );
  });

  test("handlers created with the same options share one client", () => {
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    createCacheHandler({ type: "valkey", url: "redis://cache:6379" });
    expect(redisConstructorMock).toHaveBeenCalledTimes(1);

    createCacheHandler({ type: "redis", url: "redis://other:6379" });
    createCacheHandler({ type: "redis", url: "redis://cache:6379", commandTimeout: 250 });
    createCacheHandler({ type: "redis", url: "redis://cache:6379", password: "secret" });
    expect(redisConstructorMock).toHaveBeenCalledTimes(4);
  });

  test("a closed connection is reopened on next use", async () => {
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    await closeAllRedisConnections();
    createCacheHandler({ type: "redis", url: "redis://cache:6379" });
    expect(redisConstructorMock).toHaveBeenCalledTimes(2);
  });

  test("uses a passed client instead of opening one, and never closes it", async () => {
    const client = createFakeRedis();
    createCacheHandler({
      type: "redis",
      client: client as unknown as NonNullable<Parameters<typeof createCacheHandler>[0]["client"]>,
    });
    expect(redisConstructorMock).not.toHaveBeenCalled();
    await closeAllRedisConnections();
    expect(client.quit).not.toHaveBeenCalled();
  });

  test("never connects during next build or with CACHE_REDIS=off", () => {
    process.env.NEXT_PHASE = "phase-production-build";
    expect(createCacheHandler({ type: "redis", url: "redis://cache:6379" }).get).toBeTypeOf(
      "function",
    );
    Reflect.deleteProperty(process.env, "NEXT_PHASE");
    process.env.CACHE_REDIS = "off";
    createCacheHandler({ type: "elasticache", endpoint: "cache.internal" });
    Reflect.deleteProperty(process.env, "CACHE_REDIS");
    expect(redisConstructorMock).not.toHaveBeenCalled();
    expect(redisHandlerFactoryMock).not.toHaveBeenCalled();
  });

  test("passes commandTimeout through to the client", () => {
    createCacheHandler({ type: "redis", commandTimeout: 250 });
    expect(redisConstructorMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ commandTimeout: 250 }),
    );
  });

  // Without an "error" listener ioredis prints "Unhandled error event" on every
  // reconnect attempt; with one that swallows, a dead Redis is invisible.
  test("logs client connection errors, rate-limited", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createFakeRedis();
    redisConstructorMock.mockImplementation(() => client);

    createCacheHandler({ type: "redis" });

    expect(client.listenerCount("error")).toBeGreaterThan(0);
    client.emit("error", new Error("ECONNREFUSED"));
    client.emit("error", new Error("ECONNREFUSED"));
    client.emit("error", new Error("ECONNREFUSED"));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0][0])).toContain("connection");
  });

  // ElastiCache differs from plain Redis only in how it maps env vars to the ioredis
  // config object (host/port instead of a URL, TLS on by default, auth-token password,
  // connect timeout + retry). These assert that mapping so the AWS-specific glue can't
  // silently break — the matching live round-trip over TLS + auth is the e2e-elasticache
  // CI job.
  test("maps ELASTICACHE_* env vars to the ioredis config object", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster.cache.amazonaws.com";
    process.env.ELASTICACHE_PORT = "6380";
    process.env.ELASTICACHE_AUTH_TOKEN = "env-token";

    createCacheHandler({ type: "elasticache" });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "my-cluster.cache.amazonaws.com",
        port: 6380,
        tls: {},
        password: "env-token",
        connectTimeout: 10000,
        retryStrategy: expect.any(Function),
      }),
    );

    // Verify the backoff itself, not just that a function was passed: linear
    // 200ms * attempt, capped at 5s, and never giving up. Returning null would
    // end the ioredis client for good after a routine failover.
    const config = redisConstructorMock.mock.calls[0][0] as ResilienceConfig;
    expect(config.retryStrategy(1)).toBe(200);
    expect(config.retryStrategy(3)).toBe(600);
    expect(config.retryStrategy(4)).toBe(800);
    expect(config.retryStrategy(1000)).toBe(5000);
  });

  test("explicit options override ElastiCache env vars", () => {
    process.env.ELASTICACHE_ENDPOINT = "env-host";
    process.env.ELASTICACHE_AUTH_TOKEN = "env-token";

    createCacheHandler({
      type: "elasticache",
      endpoint: "opt-host",
      port: 7000,
      password: "opt-token",
    });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "opt-host",
        port: 7000,
        password: "opt-token",
      }),
    );
  });

  test("defaults ElastiCache port to 6379 and TLS on", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster";

    createCacheHandler({ type: "elasticache" });

    expect(redisConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 6379, tls: {} }),
    );
  });

  test("disables TLS when ELASTICACHE_TLS is 'false'", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster";
    process.env.ELASTICACHE_TLS = "false";

    createCacheHandler({ type: "elasticache" });

    expect(redisConstructorMock).toHaveBeenCalledTimes(1);
    expect(redisConstructorMock.mock.calls[0][0]).not.toHaveProperty("tls");
  });

  test("disables TLS when options.tls is false (overrides the on-by-default)", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster";

    createCacheHandler({ type: "elasticache", tls: false });

    expect(redisConstructorMock).toHaveBeenCalledTimes(1);
    expect(redisConstructorMock.mock.calls[0][0]).not.toHaveProperty("tls");
  });

  test("throws when no ElastiCache endpoint is configured", () => {
    expect(() => createCacheHandler({ type: "elasticache" })).toThrow(/endpoint is required/i);
    expect(redisConstructorMock).not.toHaveBeenCalled();
  });
});
