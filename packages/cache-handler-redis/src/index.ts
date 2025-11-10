// =============================================================================
// ISR Cache Handler (for cache-handler.mjs)
// =============================================================================
export { RedisCacheHandler } from "./redis-cache-handler.js";
export type { RedisCacheHandlerOptions } from "./redis-cache-handler.js";

// =============================================================================
// Data Cache Handler (for data-cache-handler.mjs with "use cache")
// =============================================================================
export {
  createRedisDataCacheHandler,
  type RedisClient,
  type RedisDataCacheHandlerOptions,
} from "@mrjasonroy/cache-components-cache-handler";
