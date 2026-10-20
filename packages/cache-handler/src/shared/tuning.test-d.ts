/**
 * Every factory takes the connection tuning, not only the 16.5 `RedisCacheHandler`.
 */

import { describe, expectTypeOf, test } from "vitest";
import type { createCacheHandler } from "../data-cache/factory.js";
import type { LocalCacheHandlerOptions } from "../data-cache/local.js";
import type { RemoteCacheHandlerOptions } from "../data-cache/remote.js";
import type { RedisCacheHandlerOptions } from "../handlers/redis.js";
import type { CacheOptions, flushCache } from "../index.js";

interface Tuning {
  connectTimeout?: number;
  socketTimeout?: number;
  maxConsecutiveTimeouts?: number;
}

describe("connection tuning on CacheOptions", () => {
  test("CacheOptions and every factory's options take it", () => {
    expectTypeOf<Pick<CacheOptions, keyof Tuning>>().toEqualTypeOf<Tuning>();
    expectTypeOf<Pick<RemoteCacheHandlerOptions, keyof Tuning>>().toEqualTypeOf<
      Pick<CacheOptions, keyof Tuning>
    >();
    expectTypeOf<Pick<LocalCacheHandlerOptions, keyof Tuning>>().toEqualTypeOf<
      Pick<CacheOptions, keyof Tuning>
    >();
    expectTypeOf<Pick<RedisCacheHandlerOptions, keyof Tuning>>().toEqualTypeOf<
      Pick<CacheOptions, keyof Tuning>
    >();
    expectTypeOf<NonNullable<Parameters<typeof flushCache>[0]>>().toMatchTypeOf<Tuning>();
    expectTypeOf<NonNullable<Parameters<typeof createCacheHandler>[0]>>().toMatchTypeOf<Tuning>();
  });
});
