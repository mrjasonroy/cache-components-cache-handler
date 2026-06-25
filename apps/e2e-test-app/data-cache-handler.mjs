/**
 * Unified data cache handler for e2e tests
 * Switches between memory, Redis, and ElastiCache based on CACHE_HANDLER env var
 */

const cacheType = process.env.CACHE_HANDLER || process.env.DATA_CACHE_HANDLER || "memory";

console.log(`[DataCacheHandler] Using cache type: ${cacheType}`);

let handler;

if (cacheType === "redis") {
  // Redis/Valkey handler (using ioredis for consistency)
  const Redis = (await import("ioredis")).default;
  const { createRedisDataCacheHandler, createIoredisAdapter } = await import(
    "@mrjasonroy/cache-components-cache-handler"
  );

  const url = process.env.REDIS_URL || process.env.DATA_CACHE_URL || "redis://localhost:6379";
  const ioredisClient = new Redis(url);

  ioredisClient.on("error", (err) => {
    console.error("[Redis] Connection error:", err);
  });

  ioredisClient.on("connect", () => {
    console.log("[Redis] Connected successfully to", url);
  });

  // Adapt the ioredis client to the node-redis-style RedisClient contract
  // (translates SET { EX } options to ioredis positional args)
  const redis = createIoredisAdapter(ioredisClient);

  handler = createRedisDataCacheHandler({
    redis,
    keyPrefix: "e2e:cache:",
    tagPrefix: "e2e:tags:",
    defaultTTL: 86400,
    debug: process.env.CACHE_DEBUG === "true",
  });
} else if (cacheType === "elasticache") {
  // Drive the PACKAGE factory's elasticache path (zero-config: it reads the ELASTICACHE_*
  // env vars itself — endpoint/port, TLS-on-by-default, ELASTICACHE_AUTH_TOKEN). Going
  // through createCacheHandler rather than hand-wiring ioredis here means the e2e covers
  // the shipped code path, so the TLS + auth round-trip in CI exercises what production runs.
  const { createCacheHandler } = await import("@mrjasonroy/cache-components-cache-handler");

  handler = createCacheHandler({
    type: "elasticache",
    keyPrefix: "e2e:cache:",
    tagPrefix: "e2e:tags:",
    debug: process.env.CACHE_DEBUG === "true",
  });
} else {
  // Memory handler (default)
  const { createMemoryDataCacheHandler } = await import(
    "@mrjasonroy/cache-components-cache-handler"
  );

  handler = createMemoryDataCacheHandler({
    maxSize: 100 * 1024 * 1024, // 100MB
    debug: process.env.CACHE_DEBUG === "true",
  });

  console.log("[MemoryDataCache] Handler initialized");
}

export default handler;
