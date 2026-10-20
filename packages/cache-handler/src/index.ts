/**
 * @mrjasonroy/cache-components-cache-handler
 *
 * Cache handlers for Next.js 16+: pages and route handlers (`cacheHandler`), "use cache" and
 * "use cache: remote" (`cacheHandlers`). `withCache(nextConfig)` configures all of them.
 */

// =============================================================================
// The one public way: withCache, plus the handlers it points Next at
// =============================================================================

export {
  createLocalCacheHandler,
  type LocalCacheHandlerOptions,
} from "./data-cache/local.js";
export {
  createRemoteCacheHandler,
  type RemoteCacheHandlerOptions,
} from "./data-cache/remote.js";
export {
  createRedisCacheHandler,
  RedisCacheHandler,
  type RedisCacheHandlerOptions,
} from "./handlers/redis.js";
export type {
  PageCacheControl,
  PageCacheGetContext,
  PageCacheHandlerContext,
  PageCacheHandlerValue,
  PageCacheSetContext,
  PageCacheValue,
} from "./handlers/page-types.js";
export {
  type NextConfigFunction,
  type WithCacheConfig,
  type WithCacheOptions,
  withCache,
} from "./helpers/with-cache.js";
export {
  type FlushCacheOptions,
  type FlushCacheResult,
  flushCache,
} from "./shared/flush.js";
export { type CacheLogger, setCacheLogger } from "./shared/logger.js";
export { type CacheOptions, closeCache, MEMORY_ONLY_TAG } from "./shared/runtime.js";

// =============================================================================
// Deprecated Next 14-era ISR handlers and helpers (kept until the Next 17 line)
// =============================================================================

export {
  CompositeHandler,
  type CompositeHandlerOptions,
  createCompositeHandler,
} from "./handlers/composite.js";
export {
  createMemoryCacheHandler,
  MemoryCacheHandler,
  type MemoryCacheHandlerOptions,
} from "./handlers/memory.js";
export { bufferToString, stringToBuffer } from "./helpers/buffer.js";
export { isImplicitTag } from "./helpers/is-implicit-tag.js";
export { calculateLifespan, isExpired } from "./helpers/lifespan.js";
export { jsonReplacer, jsonReviver } from "./helpers/serialization.js";
export type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
  LifespanParameters,
} from "./types.js";
export { IMPLICIT_TAG_PREFIX } from "./types.js";

// =============================================================================
// Deprecated 16.5 data cache stack (kept until the Next 17 line): use withCache, or
// createRemoteCacheHandler / createLocalCacheHandler
// =============================================================================

export {
  type CacheHandlerOptions as DataCacheHandlerOptions,
  type CacheHandlerType,
  createCacheHandler,
} from "./data-cache/factory.js";

export {
  createMemoryDataCacheHandler,
  type MemoryDataCacheHandlerOptions,
} from "./data-cache/memory.js";
export {
  createRedisDataCacheHandler,
  type RedisClient,
  type RedisDataCacheHandlerOptions,
} from "./data-cache/redis.js";
// Adapter for using an ioredis client with the node-redis-style data cache handler
export {
  createIoredisAdapter,
  type IoredisLike,
} from "./data-cache/ioredis-adapter.js";
export type {
  DataCacheEntry,
  DataCacheHandler,
  Timestamp,
} from "./data-cache/types.js";

// next.config helpers
export {
  type CacheHandlerConfig,
  createCacheConfig,
  createCacheConfigWithProfiles,
} from "./helpers/next-config.js";
