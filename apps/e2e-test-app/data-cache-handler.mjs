/**
 * Unified data cache handler for e2e tests
 * Switches between memory and Redis based on CACHE_HANDLER env var
 */

const cacheType = process.env.CACHE_HANDLER || "memory";

console.log(`[DataCacheHandler] Using cache type: ${cacheType}`);

let handler;

if (cacheType === "redis") {
  // Redis handler
  const { createClient } = await import("redis");
  const { createRedisDataCacheHandler } = await import("@mrjasonroy/better-nextjs-cache-handler");

  const redis = createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
  });

  redis.on("error", (err) => {
    console.error("[Redis] Connection error:", err);
  });

  try {
    await redis.connect();
    console.log("[Redis] Connected successfully");
  } catch (error) {
    console.error("[Redis] Failed to connect:", error);
    throw error;
  }

  handler = createRedisDataCacheHandler({
    redis,
    keyPrefix: "e2e:cache:",
    tagPrefix: "e2e:tags:",
    defaultTTL: 86400,
    debug: process.env.CACHE_DEBUG === "true",
  });
} else {
  // Memory handler (default)
  const { createMemoryDataCacheHandler } = await import("@mrjasonroy/better-nextjs-cache-handler");

  handler = createMemoryDataCacheHandler({
    maxSize: 100 * 1024 * 1024, // 100MB
    debug: process.env.CACHE_DEBUG === "true",
  });

  console.log("[MemoryDataCache] Handler initialized");
}

export default handler;
