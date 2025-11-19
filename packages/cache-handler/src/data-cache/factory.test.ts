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
});
