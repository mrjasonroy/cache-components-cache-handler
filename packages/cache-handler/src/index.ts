/**
 * @mrjasonroy/cache-components-cache-handler
 *
 * Data cache handlers for Next.js 16+ "use cache" / Cache Components, configured via
 * `cacheHandlers` in next.config. The legacy ISR `cacheHandler` (singular) is not provided.
 */

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
