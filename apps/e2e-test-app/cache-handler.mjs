import { MemoryCacheHandler, RedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

// ISR cache handler (pages, route handlers, fetch). Uses Redis when the e2e
// suite runs against Redis/Valkey (CACHE_HANDLER=redis), memory otherwise.
const useRedis = process.env.CACHE_HANDLER === "redis";

// Next.js expects a class that it will instantiate
export default useRedis
  ? class NextCacheHandler extends RedisCacheHandler {
      constructor(options) {
        super({
          ...options,
          redis: process.env.REDIS_URL || "redis://localhost:6379",
          keyPrefix: "e2e:isr:",
          tagPrefix: "e2e:isr-tags:",
          debug: process.env.CACHE_DEBUG === "true",
        });
      }
    }
  : class NextCacheHandler extends MemoryCacheHandler {
      constructor(options) {
        super({
          ...options,
          maxItemsNumber: 100,
          defaultTTL: 3600,
        });
      }
    };
