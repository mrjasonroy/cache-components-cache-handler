/**
 * Type test, checked by vitest's typecheck and `tsc`: every type 16.4.2 exported is still exported
 * from the package entry, and the option objects 16.4.2's README and docs showed still type-check.
 */

import type { Redis, RedisOptions } from "ioredis";
import { describe, expectTypeOf, test } from "vitest";
import {
  type CacheHandler,
  type CacheHandlerConfig,
  type CacheHandlerContext,
  type CacheHandlerGetMeta,
  type CacheHandlerOptions,
  type CacheHandlerType,
  type CacheHandlerValue,
  type CacheValue,
  type CompositeHandlerOptions,
  type DataCacheEntry,
  type DataCacheHandler,
  type DataCacheHandlerOptions,
  type IoredisLike,
  type LifespanParameters,
  MemoryCacheHandler,
  type MemoryCacheHandlerOptions,
  type MemoryDataCacheHandlerOptions,
  RedisCacheHandler,
  type RedisCacheHandlerOptions,
  type RedisClient,
  type RedisDataCacheHandlerOptions,
  type Timestamp,
  createCacheConfig,
  createCacheConfigWithProfiles,
  createCacheHandler,
  createIoredisAdapter,
  createMemoryDataCacheHandler,
  createRedisDataCacheHandler,
} from "./index.js";

describe("16.4.2 types", () => {
  test("every 16.4.2 type export still resolves", () => {
    expectTypeOf<CacheHandler>().not.toBeAny();
    expectTypeOf<CacheHandlerConfig>().not.toBeAny();
    expectTypeOf<CacheHandlerContext>().not.toBeAny();
    expectTypeOf<CacheHandlerGetMeta>().not.toBeAny();
    expectTypeOf<CacheHandlerOptions>().not.toBeAny();
    expectTypeOf<CacheHandlerValue>().not.toBeAny();
    expectTypeOf<CacheValue>().not.toBeAny();
    expectTypeOf<CompositeHandlerOptions>().not.toBeAny();
    expectTypeOf<DataCacheEntry>().not.toBeAny();
    expectTypeOf<DataCacheHandler>().not.toBeAny();
    expectTypeOf<IoredisLike>().not.toBeAny();
    expectTypeOf<LifespanParameters>().not.toBeAny();
    expectTypeOf<MemoryCacheHandlerOptions>().not.toBeAny();
    expectTypeOf<MemoryDataCacheHandlerOptions>().not.toBeAny();
    expectTypeOf<RedisClient>().not.toBeAny();
    expectTypeOf<RedisCacheHandlerOptions>().not.toBeAny();
    expectTypeOf<RedisDataCacheHandlerOptions>().not.toBeAny();
    expectTypeOf<Timestamp>().toEqualTypeOf<number>();
    expectTypeOf<CacheHandlerType>().toEqualTypeOf<"memory" | "redis" | "valkey" | "elasticache">();
  });

  test("the README / docs createCacheHandler options still type-check", () => {
    const elasticache = {
      type: "elasticache",
      endpoint: "cache.prod-cluster.cache.amazonaws.com",
      port: 6380,
      tls: true,
      password: "token",
      keyPrefix: "myapp:cache:",
      tagPrefix: "myapp:tags:",
      debug: false,
    } satisfies DataCacheHandlerOptions;
    const redis = {
      type: "redis",
      url: "redis://localhost:6379",
      password: undefined,
      keyPrefix: "myapp:cache:",
      tagPrefix: "myapp:tags:",
      debug: true,
    } satisfies DataCacheHandlerOptions;
    const memory = {
      type: "memory",
      maxSize: 1024,
      debug: false,
    } satisfies DataCacheHandlerOptions;
    expectTypeOf(createCacheHandler(elasticache)).toEqualTypeOf<DataCacheHandler>();
    expectTypeOf(createCacheHandler(redis)).toEqualTypeOf<DataCacheHandler>();
    expectTypeOf(createCacheHandler(memory)).toEqualTypeOf<DataCacheHandler>();
  });

  test("the bring-your-own-client and memory handler forms still type-check", () => {
    expectTypeOf(createRedisDataCacheHandler)
      .parameter(0)
      .toMatchTypeOf<{ redis: RedisClient; keyPrefix?: string; tagPrefix?: string }>();
    expectTypeOf<{
      redis: RedisClient;
      keyPrefix: string;
      tagPrefix: string;
      defaultTTL: number;
      debug: boolean;
    }>().toMatchTypeOf<RedisDataCacheHandlerOptions>();
    expectTypeOf(createIoredisAdapter).parameter(0).toMatchTypeOf<IoredisLike>();
    expectTypeOf<Redis>().toMatchTypeOf<IoredisLike>();
    expectTypeOf(createIoredisAdapter).returns.toMatchTypeOf<RedisClient>();
    expectTypeOf<{
      maxSize: number;
      debug: boolean;
    }>().toMatchTypeOf<MemoryDataCacheHandlerOptions>();
    expectTypeOf(createMemoryDataCacheHandler).returns.toEqualTypeOf<DataCacheHandler>();
  });

  test("createCacheConfig takes the 16.4.2 arguments and returns 16.4.2's type", () => {
    // 16.4.2's CacheHandlerConfig: cacheHandler was a required string.
    interface CacheHandlerConfig1642 {
      cacheHandler: string;
      cacheHandlers: { default: string; remote: string };
      cacheMaxMemorySize?: number;
    }
    const config = createCacheConfig({
      isrHandlerPath: "/app/cache-handler.mjs",
      dataCacheHandlerPath: "/app/data-cache-handler.mjs",
    });
    expectTypeOf(config.cacheHandler).toEqualTypeOf<string>();
    expectTypeOf(config).toMatchTypeOf<CacheHandlerConfig1642>();
    expectTypeOf(config).toMatchTypeOf<CacheHandlerConfig>();

    const profiles = createCacheConfigWithProfiles({
      isrHandlerPath: "/app/cache-handler.mjs",
      defaultDataCacheHandlerPath: "/app/memory.mjs",
      remoteDataCacheHandlerPath: "/app/redis.mjs",
    });
    expectTypeOf(profiles).toMatchTypeOf<CacheHandlerConfig1642>();

    // Without isrHandlerPath (allowed since 16.4.3) there is no cacheHandler.
    expectTypeOf(
      createCacheConfig({ dataCacheHandlerPath: "/app/d.mjs" }).cacheHandler,
    ).toEqualTypeOf<string | undefined>();
  });

  test("a 16.4.2 RedisCacheHandler subclass still type-checks", () => {
    for (const redis of [
      "redis://localhost:6379",
      { host: "localhost", port: 6379 } satisfies RedisOptions,
      {} as Redis,
    ]) {
      expectTypeOf<{
        redis: typeof redis;
        keyPrefix: string;
        tagPrefix: string;
        defaultTTL: number;
        debug: boolean;
      }>().toMatchTypeOf<RedisCacheHandlerOptions>();
    }
    class NextCacheHandler extends RedisCacheHandler {
      constructor(options: RedisCacheHandlerOptions) {
        super({ ...options, redis: "redis://localhost:6379", keyPrefix: "nextjs:cache:" });
      }
    }
    expectTypeOf(NextCacheHandler).constructorParameters.toMatchTypeOf<
      [RedisCacheHandlerOptions]
    >();
    expectTypeOf<string>().toMatchTypeOf<Parameters<NextCacheHandler["revalidateTag"]>[0]>();
  });

  test("a 16.4.2 MemoryCacheHandler subclass still type-checks", () => {
    class NextCacheHandler extends MemoryCacheHandler {
      constructor(options: MemoryCacheHandlerOptions) {
        super({ ...options, maxItemsNumber: 100, defaultTTL: 3600 });
      }
    }
    expectTypeOf<NextCacheHandler>().toMatchTypeOf<CacheHandler>();
  });
});
