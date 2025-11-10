/**
 * @mrjasonroy/better-nextjs-cache-handler
 * Modern cache handler for Next.js 16+ with support for ISR and 'use cache' directive
 */

// =============================================================================
// ISR Cache Handlers (for Incremental Static Regeneration)
// =============================================================================

export {
  CompositeHandler,
  type CompositeHandlerOptions,
  createCompositeHandler,
} from "./handlers/composite.js";
// Handlers
export {
  createMemoryCacheHandler,
  MemoryCacheHandler,
  type MemoryCacheHandlerOptions,
} from "./handlers/memory.js";
export { bufferToString, stringToBuffer } from "./helpers/buffer.js";
// Helpers
export { isImplicitTag } from "./helpers/is-implicit-tag.js";
export { calculateLifespan, isExpired } from "./helpers/lifespan.js";
export {
  createCacheConfig,
  createCacheConfigWithProfiles,
  type CacheHandlerConfig,
} from "./helpers/next-config.js";
// Types
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
// Data Cache Handlers (for "use cache" directive)
// =============================================================================

export {
  createMemoryDataCacheHandler,
  type MemoryDataCacheHandlerOptions,
} from "./data-cache/memory.js";
export {
  createRedisDataCacheHandler,
  type RedisClient,
  type RedisDataCacheHandlerOptions,
} from "./data-cache/redis.js";
export type {
  DataCacheEntry,
  DataCacheHandler,
  Timestamp,
} from "./data-cache/types.js";
