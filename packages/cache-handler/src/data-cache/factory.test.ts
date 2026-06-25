import { beforeEach, describe, expect, test, vi } from "vitest";
import type { DataCacheHandler } from "./types.js";

const createFakeRedis = () => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  exists: vi.fn(),
  ttl: vi.fn(),
  hget: vi.fn(),
  hset: vi.fn(),
  hgetall: vi.fn(),
});

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

    expect(redisConstructorMock).toHaveBeenCalledWith("redis://valkey.internal:6380");
  });

  test("skips constructor options when no password or tls configured", () => {
    createCacheHandler({
      type: "redis",
      url: "redis://no-auth",
    });

    expect(redisConstructorMock).toHaveBeenCalledWith("redis://no-auth");
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
    // 200ms * attempt, then give up (null) after 3 attempts.
    const config = redisConstructorMock.mock.calls[0][0] as {
      retryStrategy: (times: number) => number | null;
    };
    expect(config.retryStrategy(1)).toBe(200);
    expect(config.retryStrategy(3)).toBe(600);
    expect(config.retryStrategy(4)).toBeNull();
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

    expect(redisConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ tls: undefined }));
  });

  test("disables TLS when options.tls is false (overrides the on-by-default)", () => {
    process.env.ELASTICACHE_ENDPOINT = "my-cluster";

    createCacheHandler({ type: "elasticache", tls: false });

    expect(redisConstructorMock).toHaveBeenCalledWith(expect.objectContaining({ tls: undefined }));
  });

  test("throws when no ElastiCache endpoint is configured", () => {
    expect(() => createCacheHandler({ type: "elasticache" })).toThrow(/endpoint is required/i);
    expect(redisConstructorMock).not.toHaveBeenCalled();
  });
});
