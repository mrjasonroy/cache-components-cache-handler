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
  const { createRedisDataCacheHandler } = await import(
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

  // Wrap ioredis to provide node-redis compatible API
  const redis = {
    get: (key) => ioredisClient.get(key),
    set: (key, value, ...args) => ioredisClient.set(key, value, ...args),
    del: (...keys) => ioredisClient.del(...keys),
    exists: (...keys) => ioredisClient.exists(...keys),
    ttl: (key) => ioredisClient.ttl(key),
    hGet: (key, field) => ioredisClient.hget(key, field),
    hSet: (key, field, value) => ioredisClient.hset(key, field, value),
    hGetAll: (key) => ioredisClient.hgetall(key),
  };

  handler = createRedisDataCacheHandler({
    redis,
    keyPrefix: "e2e:cache:",
    tagPrefix: "e2e:tags:",
    defaultTTL: 86400,
    debug: process.env.CACHE_DEBUG === "true",
  });
} else if (cacheType === "elasticache") {
  // ElastiCache handler (password-based auth only)
  const Redis = (await import("ioredis")).default;
  const { createRedisDataCacheHandler } = await import(
    "@mrjasonroy/cache-components-cache-handler"
  );

  const endpoint = process.env.ELASTICACHE_ENDPOINT;
  const port = Number.parseInt(process.env.ELASTICACHE_PORT || "6379", 10);

  if (!endpoint) {
    throw new Error("ELASTICACHE_ENDPOINT environment variable is required");
  }

  const config = {
    host: endpoint,
    port,
    // TLS enabled by default for ElastiCache (disable explicitly with "false")
    tls: process.env.ELASTICACHE_TLS !== "false" ? {} : undefined,
    connectTimeout: 10000,
    retryStrategy: (times) => {
      if (times > 3) {
        console.error("[ElastiCache] Max retry attempts reached");
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  };

  // Password-based authentication
  if (process.env.ELASTICACHE_AUTH_TOKEN) {
    console.log("[ElastiCache] Using auth token authentication");
    config.password = process.env.ELASTICACHE_AUTH_TOKEN;
  } else {
    console.log("[ElastiCache] No authentication configured");
  }

  const ioredisClient = new Redis(config);

  ioredisClient.on("error", (err) => {
    console.error("[ElastiCache] Connection error:", err);
  });

  ioredisClient.on("connect", () => {
    console.log("[ElastiCache] Connected successfully to", endpoint);
  });

  // Wrap ioredis to provide node-redis compatible API
  const redis = {
    get: (key) => ioredisClient.get(key),
    set: (key, value, ...args) => ioredisClient.set(key, value, ...args),
    del: (...keys) => ioredisClient.del(...keys),
    exists: (...keys) => ioredisClient.exists(...keys),
    ttl: (key) => ioredisClient.ttl(key),
    hGet: (key, field) => ioredisClient.hget(key, field),
    hSet: (key, field, value) => ioredisClient.hset(key, field, value),
    hGetAll: (key) => ioredisClient.hgetall(key),
  };

  handler = createRedisDataCacheHandler({
    redis,
    keyPrefix: "e2e:cache:",
    tagPrefix: "e2e:tags:",
    defaultTTL: 86400,
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
