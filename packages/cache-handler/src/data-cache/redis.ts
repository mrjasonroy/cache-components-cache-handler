/**
 * Redis-based Data Cache Handler for "use cache" directive
 * For production use with distributed Next.js deployments
 *
 * This handler stores cache entries in Redis, allowing multiple
 * Next.js instances to share the same cache.
 */

import type { DataCacheEntry, DataCacheHandler } from "./types.js";

export interface RedisDataCacheHandlerOptions {
  /**
   * Redis client instance (ioredis or node-redis)
   */
  redis: RedisClient;

  /**
   * Key prefix for all cache entries
   * @default "nextjs:data-cache:"
   */
  keyPrefix?: string;

  /**
   * Key prefix for tag manifest
   * @default "nextjs:tags:"
   */
  tagPrefix?: string;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Default TTL for cache entries in seconds
   * Used if entry doesn't specify expiration
   * @default 86400 (24 hours)
   */
  defaultTTL?: number;
}

/**
 * Redis client interface (compatible with ioredis and node-redis)
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  hGet(key: string, field: string): Promise<string | null>;
  hSet(key: string, field: string, value: string): Promise<unknown>;
  hGetAll(key: string): Promise<Record<string, string>>;
}

interface SerializedCacheEntry {
  value: string; // base64 encoded buffer
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/**
 * Convert ReadableStream to Buffer
 */
async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return Buffer.from(result);
}

/**
 * Convert Buffer to ReadableStream
 */
function bufferToStream(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(buffer));
      controller.close();
    },
  });
}

/**
 * Create a Redis-based data cache handler for "use cache" directive
 *
 * @example
 * ```typescript
 * // redis-cache-handler.mjs
 * import { createClient } from 'redis';
 * import { createRedisDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler/data-cache';
 *
 * const redis = createClient({
 *   url: process.env.REDIS_URL
 * });
 *
 * await redis.connect();
 *
 * export default createRedisDataCacheHandler({
 *   redis,
 *   keyPrefix: 'myapp:cache:',
 *   debug: process.env.NODE_ENV === 'development'
 * });
 * ```
 *
 * Then in next.config.js:
 * ```javascript
 * module.exports = {
 *   cacheComponents: true,
 *   cacheHandlers: {
 *     default: require.resolve('./redis-cache-handler.mjs'),
 *     remote: require.resolve('./redis-cache-handler.mjs') // Same handler for remote
 *   }
 * }
 * ```
 */
export function createRedisDataCacheHandler(
  options: RedisDataCacheHandlerOptions,
): DataCacheHandler {
  const {
    redis,
    keyPrefix = "nextjs:data-cache:",
    tagPrefix = "nextjs:tags:",
    defaultTTL = 86400,
    debug = false,
  } = options;

  const log = debug ? console.debug.bind(console, "[RedisDataCache]:") : undefined;

  /**
   * Get cache key with prefix
   */
  function getCacheKey(cacheKey: string): string {
    return `${keyPrefix}${cacheKey}`;
  }

  /**
   * Get tag key with prefix
   */
  function getTagKey(tag: string): string {
    return `${tagPrefix}${tag}`;
  }

  /**
   * Serialize cache entry for Redis storage
   */
  async function serializeEntry(entry: DataCacheEntry): Promise<SerializedCacheEntry> {
    const buffer = await streamToBuffer(entry.value);

    return {
      value: buffer.toString("base64"),
      tags: entry.tags,
      stale: entry.stale,
      timestamp: entry.timestamp,
      expire: entry.expire,
      revalidate: entry.revalidate,
    };
  }

  /**
   * Deserialize cache entry from Redis
   */
  function deserializeEntry(data: SerializedCacheEntry): DataCacheEntry {
    const buffer = Buffer.from(data.value, "base64");

    return {
      value: bufferToStream(buffer),
      tags: data.tags,
      stale: data.stale,
      timestamp: data.timestamp,
      expire: data.expire,
      revalidate: data.revalidate,
    };
  }

  return {
    async get(cacheKey, _softTags) {
      const key = getCacheKey(cacheKey);

      try {
        const data = await redis.get(key);

        if (!data) {
          log?.("get", cacheKey, "not found");
          return undefined;
        }

        const entry = deserializeEntry(JSON.parse(data));
        const now = Date.now();

        // Check expiration
        if (now > entry.timestamp + entry.revalidate * 1000) {
          log?.("get", cacheKey, "expired");
          await redis.del(key);
          return undefined;
        }

        // Check tag expiration
        let revalidate = entry.revalidate;
        for (const tag of entry.tags) {
          const tagData = await redis.hGetAll(getTagKey(tag));

          if (tagData.expired) {
            const expired = Number.parseInt(tagData.expired, 10);
            if (expired > entry.timestamp) {
              log?.("get", cacheKey, "had expired tag", tag);
              await redis.del(key);
              return undefined;
            }
          }

          if (tagData.stale) {
            const stale = Number.parseInt(tagData.stale, 10);
            if (stale > entry.timestamp) {
              log?.("get", cacheKey, "had stale tag", tag);
              revalidate = -1;
            }
          }
        }

        // Tee the stream
        const [returnStream, newSaved] = entry.value.tee();
        entry.value = newSaved;

        log?.("get", cacheKey, "found", {
          tags: entry.tags,
          timestamp: entry.timestamp,
          revalidate,
        });

        return {
          ...entry,
          revalidate,
          value: returnStream,
        };
      } catch (error) {
        log?.("get", cacheKey, "error", error);
        return undefined;
      }
    },

    async set(cacheKey, pendingEntry) {
      const key = getCacheKey(cacheKey);

      try {
        log?.("set", cacheKey, "start");

        const entry = await pendingEntry;
        const serialized = await serializeEntry(entry);

        // Calculate TTL (use expire time or default)
        const ttl = entry.expire < 4294967294 ? entry.expire : defaultTTL;

        // Store in Redis with TTL
        await redis.set(key, JSON.stringify(serialized), "EX", Math.ceil(ttl));

        log?.("set", cacheKey, "done", { ttl });
      } catch (error) {
        log?.("set", cacheKey, "failed", error);
      }
    },

    async refreshTags() {
      // For Redis, tags are stored in a hash and don't need periodic refresh
      // unless you're syncing with an external tags service
      log?.("refreshTags", "no-op for Redis cache");
    },

    async getExpiration(tags) {
      try {
        const expirations = await Promise.all(
          tags.map(async (tag) => {
            const data = await redis.hGet(getTagKey(tag), "expired");
            return data ? Number.parseInt(data, 10) : 0;
          }),
        );

        const expiration = Math.max(...expirations, 0);

        log?.("getExpiration", { tags, expiration });

        return expiration;
      } catch (error) {
        log?.("getExpiration", "error", error);
        return 0;
      }
    },

    async updateTags(tags, durations) {
      const now = Date.now();

      try {
        log?.("updateTags", { tags, timestamp: now, durations });

        await Promise.all(
          tags.map(async (tag) => {
            const key = getTagKey(tag);

            if (durations) {
              // Mark as stale immediately
              await redis.hSet(key, "stale", now.toString());

              // Set expiration if provided
              if (durations.expire !== undefined) {
                const expired = now + durations.expire * 1000;
                await redis.hSet(key, "expired", expired.toString());
              }
            } else {
              // Immediate expiration (default behavior)
              await redis.hSet(key, "expired", now.toString());
            }
          }),
        );
      } catch (error) {
        log?.("updateTags", "error", error);
      }
    },
  };
}
