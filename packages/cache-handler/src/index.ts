/**
 * @mrjasonroy/cache-components-cache-handler
 *
 * Cache handlers for Next.js 16+: "use cache" / Cache Components (`cacheHandlers` in
 * next.config) and ISR (`cacheHandler`).
 */

// =============================================================================
// ISR cache handlers (`cacheHandler` in next.config)
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
export {
  RedisCacheHandler,
  type RedisCacheHandlerOptions,
} from "./handlers/redis.js";
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
// Data cache handlers ("use cache")
// =============================================================================

// Zero-config factory (recommended)
export {
  type CacheHandlerOptions as DataCacheHandlerOptions,
  type CacheHandlerType,
  createCacheHandler,
} from "./data-cache/factory.js";

// Advanced: direct handler creation
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
