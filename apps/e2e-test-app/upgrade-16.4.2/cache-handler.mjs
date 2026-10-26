// The 16.4.2 page (ISR) handler pattern from RedisCacheHandler's JSDoc ("Option 1: Pass a Redis
// URL or config"), unchanged. Used by the E2E_CONFIG=16.4.2 lane.
import { RedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default class NextCacheHandler extends RedisCacheHandler {
  constructor(options) {
    super({
      ...options,
      redis: process.env.REDIS_URL || "redis://localhost:6379",
      keyPrefix: "nextjs:cache:",
      defaultTTL: 3600,
    });
  }
}
