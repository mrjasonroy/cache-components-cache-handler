/**
 * Zero-config cache handler factory
 * Automatically configures handlers based on type and environment variables
 */

import { createMemoryDataCacheHandler } from "./memory.js";
import { type RedisClient, createRedisDataCacheHandler } from "./redis.js";
import type { DataCacheHandler } from "./types.js";

/**
 * Lazy load ioredis and return the constructor
 */
function loadIoredis(type: string): typeof import("ioredis").default {
  try {
    return require("ioredis");
  } catch {
    throw new Error(
      `ioredis is required for ${type} cache handler. Install it with: npm install ioredis`,
    );
  }
}

/**
 * Create adapter for ioredis (lowercase methods) to match RedisClient interface (camelCase)
 */
function createRedisAdapter(redis: import("ioredis").default): RedisClient {
  return {
    get: (key) => redis.get(key),
    set: (key, value) => redis.set(key, value) as Promise<unknown>,
    del: (...keys) => redis.del(...keys),
    exists: (...keys) => redis.exists(...keys),
    ttl: (key) => redis.ttl(key),
    hGet: (key, field) => redis.hget(key, field),
    hSet: (key, field, value) => redis.hset(key, field, value) as Promise<unknown>,
    hGetAll: (key) => redis.hgetall(key),
  };
}

export type CacheHandlerType = "memory" | "redis" | "valkey" | "elasticache";

export interface CacheHandlerOptions {
  /**
   * Cache backend type
   */
  type: CacheHandlerType;

  /**
   * Redis/Valkey URL (e.g., "redis://localhost:6379")
   * @default process.env.REDIS_URL || process.env.VALKEY_URL
   */
  url?: string;

  /**
   * ElastiCache/Redis endpoint hostname
   * @default process.env.ELASTICACHE_ENDPOINT
   */
  endpoint?: string;

  /**
   * ElastiCache/Redis port
   * @default process.env.ELASTICACHE_PORT || 6379
   */
  port?: number;

  /**
   * Enable TLS/SSL
   * @default true for elasticache, false for redis/valkey
   */
  tls?: boolean;

  /**
   * Auth token/password
   * @default process.env.ELASTICACHE_AUTH_TOKEN or process.env.REDIS_PASSWORD
   */
  password?: string;

  /**
   * Key prefix for cache entries
   * @default "nextjs:cache:"
   */
  keyPrefix?: string;

  /**
   * Key prefix for tags
   * @default "nextjs:tags:"
   */
  tagPrefix?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Max memory size (for memory handler only)
   * @default 100MB
   */
  maxSize?: number;
}

/**
 * Create a cache handler with zero configuration
 *
 * @example
 * ```javascript
 * // Zero config - uses environment variables
 * export default createCacheHandler({ type: "redis" });
 *
 * // With overrides
 * export default createCacheHandler({
 *   type: "elasticache",
 *   endpoint: "my-cluster.cache.amazonaws.com",
 *   password: process.env.AUTH_TOKEN
 * });
 * ```
 */
export function createCacheHandler(options: CacheHandlerOptions): DataCacheHandler {
  const { type, debug = false } = options;

  switch (type) {
    case "memory":
      return createMemoryDataCacheHandler({
        maxSize: options.maxSize ?? 100 * 1024 * 1024,
        debug,
      });

    case "redis":
    case "valkey": {
      const Redis = loadIoredis(type);

      const url =
        options.url || process.env.REDIS_URL || process.env.VALKEY_URL || "redis://localhost:6379";

      const redis = new Redis(url);
      const redisAdapter = createRedisAdapter(redis);

      return createRedisDataCacheHandler({
        redis: redisAdapter,
        keyPrefix: options.keyPrefix,
        tagPrefix: options.tagPrefix,
        debug,
      });
    }

    case "elasticache": {
      const Redis = loadIoredis(type);

      const endpoint = options.endpoint || process.env.ELASTICACHE_ENDPOINT;
      if (!endpoint) {
        throw new Error(
          "ElastiCache endpoint is required. Set ELASTICACHE_ENDPOINT environment variable or pass 'endpoint' option.",
        );
      }

      const port =
        options.port ||
        (process.env.ELASTICACHE_PORT ? Number.parseInt(process.env.ELASTICACHE_PORT, 10) : 6379);

      const tls = options.tls ?? process.env.ELASTICACHE_TLS !== "false";

      const password =
        options.password || process.env.ELASTICACHE_AUTH_TOKEN || process.env.REDIS_PASSWORD;

      const redis = new Redis({
        host: endpoint,
        port,
        tls: tls ? {} : undefined,
        password,
        connectTimeout: 10000,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 200, 2000);
        },
      });

      const redisAdapter = createRedisAdapter(redis);

      return createRedisDataCacheHandler({
        redis: redisAdapter,
        keyPrefix: options.keyPrefix,
        tagPrefix: options.tagPrefix,
        debug,
      });
    }

    default:
      throw new Error(`Unknown cache handler type: ${type as string}`);
  }
}
