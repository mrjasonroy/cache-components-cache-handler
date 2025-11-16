/**
 * Unified data cache handler for e2e tests
 * Switches between memory, Redis, and ElastiCache based on CACHE_HANDLER env var
 */

const cacheType = process.env.CACHE_HANDLER || "memory";

console.log(`[DataCacheHandler] Using cache type: ${cacheType}`);

let handler;

if (cacheType === "redis") {
  // Redis handler
  const { createClient } = await import("redis");
  const { createRedisDataCacheHandler } = await import(
    "@mrjasonroy/cache-components-cache-handler"
  );

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
} else if (cacheType === "elasticache") {
  // ElastiCache handler
  const Redis = (await import("ioredis")).default;
  const { createRedisDataCacheHandler } = await import(
    "@mrjasonroy/cache-components-cache-handler"
  );

  const endpoint = process.env.ELASTICACHE_ENDPOINT;
  const port = Number.parseInt(process.env.ELASTICACHE_PORT || "6379", 10);
  const useIAM = process.env.ELASTICACHE_USE_IAM === "true";

  if (!endpoint) {
    throw new Error("ELASTICACHE_ENDPOINT environment variable is required");
  }

  const config = {
    host: endpoint,
    port,
    tls: process.env.ELASTICACHE_TLS === "true" ? {} : undefined,
    connectTimeout: 10000,
    retryStrategy: (times) => {
      if (times > 3) {
        console.error("[ElastiCache] Max retry attempts reached");
        return null;
      }
      return Math.min(times * 200, 2000);
    },
  };

  // Add authentication
  if (useIAM && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    console.log("[ElastiCache] Using IAM authentication");
    config.username = process.env.ELASTICACHE_USER || "default";
    config.password = process.env.AWS_SECRET_ACCESS_KEY;
  } else if (process.env.ELASTICACHE_AUTH_TOKEN) {
    console.log("[ElastiCache] Using auth token authentication");
    config.password = process.env.ELASTICACHE_AUTH_TOKEN;
  }

  const ioredisClient = new Redis(config);

  ioredisClient.on("error", (err) => {
    console.error("[ElastiCache] Connection error:", err);
  });

  ioredisClient.on("connect", () => {
    console.log("[ElastiCache] Connected successfully to", endpoint);
  });

  // Wrap ioredis to provide node-redis compatible API
  // ioredis uses lowercase methods (hget, hset, hgetall)
  // createRedisDataCacheHandler expects node-redis API (hGet, hSet, hGetAll)
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
