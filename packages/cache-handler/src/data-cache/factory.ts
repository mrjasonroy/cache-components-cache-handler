/**
 * Zero-config cache handler factory
 * Automatically configures handlers based on type and environment variables
 */

import { createRequire } from "node:module";
import type { RedisOptions } from "ioredis";
import { createErrorReporter } from "./error-reporter.js";
import { createIoredisAdapter } from "./ioredis-adapter.js";
import { createMemoryDataCacheHandler } from "./memory.js";
import { createRedisDataCacheHandler } from "./redis.js";
import type { DataCacheHandler } from "./types.js";

const nodeRequire = createRequire(import.meta.url);

/**
 * Lazy load ioredis and return the constructor
 */
function loadIoredis(type: string): typeof import("ioredis").default {
  try {
    return nodeRequire("ioredis");
  } catch {
    throw new Error(
      `ioredis is required for ${type} cache handler. Install it with: npm install ioredis`,
    );
  }
}

/**
 * Default per-command timeout for Redis/Valkey/ElastiCache clients, in ms.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 2000;

/**
 * Connection settings shared by every ioredis client the factory creates.
 *
 * A cache must never take the site down with it:
 * - `retryStrategy` never returns `null`. Returning `null` ends the client for
 *   good (status `end`, every later command fails "Connection is closed."), so a
 *   routine failover would disable caching until the process restarts. Instead
 *   it backs off linearly, 200ms per attempt, capped at 5s.
 * - `maxRetriesPerRequest: 1` and `commandTimeout` make commands fail fast while
 *   Redis is unreachable, so a render gets a cache miss instead of hanging.
 *   ioredis applies `commandTimeout` to commands waiting in the offline queue
 *   too, so the queue only smooths over the initial connect and brief blips.
 */
function resilientClientOptions(commandTimeout: number): RedisOptions {
  return {
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: true,
    commandTimeout,
  };
}

/**
 * Log client-level errors (failed connects, dropped connections). Without an
 * "error" listener ioredis prints "Unhandled error event" on every reconnect
 * attempt; this keeps the errors visible but rate-limited.
 */
function reportClientErrors(
  redis: { on(event: "error", listener: (error: Error) => void): unknown },
  errorLogIntervalMs?: number,
) {
  const reportError = createErrorReporter("[RedisDataCache]:", errorLogIntervalMs);
  redis.on("error", (error) => reportError("connection", error));
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

  /**
   * Per-command timeout in ms for redis/valkey/elasticache. A command that gets
   * no reply in time fails and the read is treated as a cache miss, so a slow or
   * unreachable Redis cannot hold up page renders.
   * @default 2000
   */
  commandTimeout?: number;

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
  const { type, debug = false, commandTimeout = DEFAULT_COMMAND_TIMEOUT_MS } = options;

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

      const password = options.password ?? process.env.REDIS_PASSWORD;
      const tlsEnabled = options.tls ?? false;

      const redis = new Redis(url, {
        ...resilientClientOptions(commandTimeout),
        ...(password ? { password } : {}),
        ...(tlsEnabled ? { tls: {} } : {}),
      });
      reportClientErrors(redis, options.errorLogIntervalMs);
      const redisAdapter = createIoredisAdapter(redis);

      return createRedisDataCacheHandler({
        redis: redisAdapter,
        keyPrefix: options.keyPrefix,
        tagPrefix: options.tagPrefix,
        defaultTTL: options.defaultTTL,
        tagTTL: options.tagTTL,
        errorLogIntervalMs: options.errorLogIntervalMs,
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
        ...resilientClientOptions(commandTimeout),
        host: endpoint,
        port,
        tls: tls ? {} : undefined,
        password,
        connectTimeout: 10000,
      });
      reportClientErrors(redis, options.errorLogIntervalMs);

      const redisAdapter = createIoredisAdapter(redis);

      return createRedisDataCacheHandler({
        redis: redisAdapter,
        keyPrefix: options.keyPrefix,
        tagPrefix: options.tagPrefix,
        defaultTTL: options.defaultTTL,
        tagTTL: options.tagTTL,
        errorLogIntervalMs: options.errorLogIntervalMs,
        debug,
      });
    }

    default:
      throw new Error(`Unknown cache handler type: ${type as string}`);
  }
}
