/**
 * Zero-config cache handler factory
 * Automatically configures handlers based on type and environment variables
 */

import type { Cluster, Redis } from "ioredis";
import { getClientConnection, getRedisConnection } from "../shared/connection.js";
import { resolveConnectionOptions, shouldUseRedis } from "../shared/env.js";
import { createFallbackDataCacheHandler } from "./fallback.js";
import { createIoredisAdapter } from "./ioredis-adapter.js";
import { type IsrWarningOptions, warnMissingIsrHandlerOnce } from "./isr-warning.js";
import { createMemoryDataCacheHandler } from "./memory.js";
import { createRedisDataCacheHandler } from "./redis.js";
import type { DataCacheHandler } from "./types.js";

export type CacheHandlerType = "memory" | "redis" | "valkey" | "elasticache";

export interface CacheHandlerOptions extends IsrWarningOptions {
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
   * @default "nextjs:data-cache:"
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

  /**
   * Per-command timeout in ms for redis/valkey/elasticache. A command that gets
   * no reply in time fails and the call falls back to memory (or misses), so a
   * slow or unreachable Redis cannot hold up page renders.
   * @default 1000
   */
  commandTimeout?: number;

  /**
   * Connect timeout in ms for redis/valkey/elasticache.
   * @default 2000 (10000 for elasticache)
   */
  connectTimeout?: number;

  /**
   * Drop the connection when a pending command gets no reply for this many ms
   * (redis/valkey/elasticache).
   * @default 2000
   */
  socketTimeout?: number;

  /**
   * Drop and rebuild the connection after this many command timeouts in a row; with a
   * `client`, mark it not ready for 2 s instead (redis/valkey/elasticache).
   * @default 3
   */
  maxConsecutiveTimeouts?: number;

  /**
   * An ioredis `Redis` or `Cluster` to use instead of opening a connection
   * (redis/valkey/elasticache). You own its lifecycle and options; it is never closed,
   * disconnected or reconfigured. The handler's own commands on it are bounded by
   * `commandTimeout`, and `maxConsecutiveTimeouts` timeouts in a row switch to the memory
   * fallback for 2 s at a time.
   */
  client?: Redis | Cluster;

  /**
   * While Redis is down, serve and store entries in process memory, each for at
   * most `fallbackTTL` seconds. That memory is emptied when Redis is back. With
   * `false`, calls made during an outage are misses.
   * @default true
   */
  memoryFallback?: boolean;

  /**
   * Longest time in seconds an entry written while Redis is down is served.
   * @default 60
   */
  fallbackTTL?: number;

  /**
   * TTL in seconds for entries without a finite `expire` (redis/valkey/elasticache)
   * @default 86400 (24 hours)
   */
  defaultTTL?: number;

  /**
   * TTL in seconds for tag revalidation records (redis/valkey/elasticache).
   * Entry TTLs are capped at this value so a tag record always outlives its entries.
   * @default 31622400 (366 days)
   */
  tagTTL?: number;

  /**
   * Minimum time in milliseconds between two logged errors of the same operation
   * (redis/valkey/elasticache)
   * @default 60000
   */
  errorLogIntervalMs?: number;
}

/**
 * Check the ISR warning on the handler's first call, when the request's page handler (if the app
 * uses this package's) has already been constructed.
 */
function warnOnFirstUse(handler: DataCacheHandler, options: IsrWarningOptions): DataCacheHandler {
  let checked = false;
  const check = () => {
    if (checked) return;
    checked = true;
    warnMissingIsrHandlerOnce(options);
  };
  return {
    get(cacheKey, softTags) {
      check();
      return handler.get(cacheKey, softTags);
    },
    set(cacheKey, pendingEntry) {
      check();
      return handler.set(cacheKey, pendingEntry);
    },
    refreshTags() {
      check();
      return handler.refreshTags();
    },
    getExpiration(tags) {
      check();
      return handler.getExpiration(tags);
    },
    updateTags(tags, durations) {
      check();
      return handler.updateTags(tags, durations);
    },
  };
}

/**
 * Create a cache handler with zero configuration
 *
 * The Redis-family types run on the process's shared connection (one per set of
 * connection options, see `../shared/connection.ts`) and fall back to bounded
 * process memory while Redis is down (see `./fallback.ts`). During `next build`
 * and with `CACHE_REDIS=off` they use process memory and never connect.
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
    case "valkey":
    case "elasticache": {
      // `next build` and `CACHE_REDIS=off` never connect: entries stay in this process.
      if (!shouldUseRedis()) {
        return createMemoryDataCacheHandler({
          maxSize: options.maxSize ?? 100 * 1024 * 1024,
          debug,
        });
      }
      const connection = options.client
        ? getClientConnection(options.client, {
            ...(options.commandTimeout === undefined
              ? {}
              : { commandTimeout: options.commandTimeout }),
            ...(options.maxConsecutiveTimeouts === undefined
              ? {}
              : { maxConsecutiveTimeouts: options.maxConsecutiveTimeouts }),
          })
        : getRedisConnection(resolveConnectionOptions({ ...options, type }));
      const redis = createRedisDataCacheHandler({
        redis: createIoredisAdapter(connection.client),
        keyPrefix: options.keyPrefix,
        tagPrefix: options.tagPrefix,
        defaultTTL: options.defaultTTL,
        tagTTL: options.tagTTL,
        errorLogIntervalMs: options.errorLogIntervalMs,
        debug,
      });

      return warnOnFirstUse(
        createFallbackDataCacheHandler({
          redis,
          connection,
          memoryFallback: options.memoryFallback,
          fallbackTTL: options.fallbackTTL,
          errorLogIntervalMs: options.errorLogIntervalMs,
        }),
        options,
      );
    }

    default:
      throw new Error(`Unknown cache handler type: ${type as string}`);
  }
}
