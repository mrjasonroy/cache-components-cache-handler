/**
 * Redis-based Data Cache Handler for "use cache" directive
 * For production use with distributed Next.js deployments
 *
 * This handler stores cache entries in Redis, allowing multiple
 * Next.js instances to share the same cache.
 *
 * Contract notes (see `next/dist/server/lib/cache-handlers/types.d.ts`):
 *
 * - Entries are returned until `expire`, not `revalidate`. Next's "use cache"
 *   wrapper serves an entry that is past `revalidate` and regenerates it in the
 *   background (stale-while-revalidate). Next's built-in in-memory handler
 *   deliberately drops entries at `revalidate` in production, because warming an
 *   in-memory entry that is likely to be evicted is not worth it; a shared,
 *   persistent store is the case stale-while-revalidate is designed for.
 * - The key TTL is the time left until `timestamp + expire`, so Redis evicts the
 *   entry exactly when it stops being servable.
 * - A `get` waits for an in-flight `set` of the same key in this process, so
 *   concurrent requests don't each render the same entry.
 * - Errors never throw out of the handler (a cache outage degrades to misses),
 *   but they are always logged with `console.error`, rate-limited per operation.
 * - Only single-key commands are issued, so Redis Cluster and ElastiCache in
 *   cluster mode work (no cross-slot CROSSSLOT errors).
 */

import { DEFAULT_ERROR_LOG_INTERVAL_MS, createErrorReporter } from "./error-reporter.js";
import type { DataCacheEntry, DataCacheHandler } from "./types.js";

/**
 * Next's sentinel for "no expiry" (`INFINITE_CACHE` in next/dist/lib/constants).
 */
const INFINITE_CACHE = 0xfffffffe;

/**
 * Default lifetime of tag revalidation records, in seconds: 366 days.
 *
 * `cacheLife("max")` has the longest built-in `expire`, 365 days. Entry TTLs are
 * capped at this value, so it bounds how long any entry can live; one extra day
 * absorbs clock skew between the Next.js instances that write entries.
 */
const DEFAULT_TAG_TTL = 366 * 24 * 60 * 60;

export interface RedisDataCacheHandlerOptions {
  /**
   * Redis client instance (node-redis)
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
   * TTL in seconds for entries without a finite `expire`
   * (Next's `INFINITE_CACHE`, e.g. the default `cacheLife`)
   * @default 86400 (24 hours)
   */
  defaultTTL?: number;

  /**
   * TTL in seconds for tag revalidation records, refreshed on every revalidation.
   *
   * A tag record must outlive every entry it can invalidate; otherwise an entry
   * cached before a `revalidateTag` would be served as fresh once the record is
   * gone. To guarantee that, entry TTLs are capped at this value, measured from
   * the entry's creation `timestamp`.
   * @default 31622400 (366 days, longer than `cacheLife("max")`'s 365-day expire)
   */
  tagTTL?: number;

  /**
   * Minimum time in milliseconds between two logged errors of the same operation.
   * Errors are always logged with `console.error`; this only stops an outage
   * from producing one log line per request.
   * @default 60000
   */
  errorLogIntervalMs?: number;
}

/**
 * Redis client interface (node-redis compatible)
 * Uses node-redis-style SET with options object: set(key, value, { EX: seconds })
 */
export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  exists(...keys: string[]): Promise<number>;
  ttl(key: string): Promise<number>;
  /**
   * Set a key's TTL in seconds. Used to expire tag revalidation records.
   * node-redis and ioredis (via `createIoredisAdapter`) both provide it. Without
   * it, tag records never expire and a warning is logged once.
   */
  expire?(key: string, seconds: number): Promise<unknown>;
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
 * // Without an "error" listener, a dropped connection throws (node-redis) or logs
 * // "Unhandled error event" (ioredis).
 * redis.on("error", (error) => console.error("Redis error:", error));
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
    tagTTL = DEFAULT_TAG_TTL,
    errorLogIntervalMs = DEFAULT_ERROR_LOG_INTERVAL_MS,
    debug = false,
  } = options;

  const log = debug ? console.debug.bind(console, "[RedisDataCache]:") : undefined;
  const reportError = createErrorReporter("[RedisDataCache]:", errorLogIntervalMs);

  /**
   * In-flight `set` operations by cache key. Holds a promise this handler owns
   * (never the caller's `pendingEntry`) and is cleared as soon as the set ends.
   */
  const pendingSets = new Map<string, Promise<void>>();

  let warnedMissingExpire = false;

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
   * Seconds the entry should stay in Redis: the time left until it expires,
   * measured from its creation timestamp and capped at `tagTTL`.
   */
  function getEntryTTL(entry: DataCacheEntry): number {
    const expire = entry.expire >= INFINITE_CACHE ? defaultTTL : entry.expire;
    const lifetime = Math.min(expire, tagTTL);
    return Math.ceil((entry.timestamp + lifetime * 1000 - Date.now()) / 1000);
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
   * Deserialize cache entry from Redis. Every call builds a new value stream.
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

  async function writeEntry(cacheKey: string, pendingEntry: Promise<DataCacheEntry>) {
    let serialized: SerializedCacheEntry;
    let ttl: number;

    // A rejected entry or an errored stream is a failed render, which Next
    // already reports; it is not a cache backend failure.
    try {
      const entry = await pendingEntry;
      ttl = getEntryTTL(entry);
      if (ttl <= 0) {
        // Already expired (e.g. `expire: 0`, a dynamic entry Next regenerates on
        // every read). Redis rejects `EX 0`, and storing it would be wasted.
        log?.("set", cacheKey, "skipped expired entry");
        return;
      }
      serialized = await serializeEntry(entry);
    } catch (error) {
      log?.("set", cacheKey, "entry failed", error);
      return;
    }

    try {
      await redis.set(getCacheKey(cacheKey), JSON.stringify(serialized), { EX: ttl });
      log?.("set", cacheKey, "done", { ttl });
    } catch (error) {
      log?.("set", cacheKey, "failed", error);
      reportError("set", error);
    }
  }

  return {
    async get(cacheKey, _softTags) {
      const pendingSet = pendingSets.get(cacheKey);
      if (pendingSet) {
        log?.("get", cacheKey, "pending");
        await pendingSet;
      }

      const key = getCacheKey(cacheKey);

      try {
        const data = await redis.get(key);

        if (!data) {
          log?.("get", cacheKey, "not found");
          return undefined;
        }

        const entry = deserializeEntry(JSON.parse(data));

        // Past `expire` the entry must not be served. The key TTL normally evicts
        // it first; this guards against clock skew between instances. Past
        // `revalidate` (but before `expire`) the entry is returned as-is and
        // Next's wrapper serves it while regenerating in the background.
        if (Date.now() > entry.timestamp + entry.expire * 1000) {
          log?.("get", cacheKey, "expired");
          return undefined;
        }

        // Check tag invalidation. A revalidation only affects entries created
        // *before* the event — `stale` records when the tag was revalidated, so
        // entries cached afterward stay valid (this is what makes a tag
        // re-cacheable after `revalidateTag(tag, "max")`). `expired`, when set,
        // is the hard-deletion deadline; before it, the entry is served stale.
        let revalidate = entry.revalidate;
        const tagResults = await Promise.all(
          entry.tags.map((tag) => redis.hGetAll(getTagKey(tag))),
        );

        let hasStaleTag = false;
        let expiredTag: string | undefined;

        for (let i = 0; i < entry.tags.length; i++) {
          const tag = entry.tags[i];
          const tagData = tagResults[i];
          const revalidatedAt = tagData.stale ? Number.parseInt(tagData.stale, 10) : 0;
          const expireAt = tagData.expired ? Number.parseInt(tagData.expired, 10) : 0;

          if (revalidatedAt && revalidatedAt > entry.timestamp) {
            // Like Next's areTagsExpired: an expiry that predates the entry doesn't apply to it.
            if (expireAt && expireAt > entry.timestamp && Date.now() >= expireAt) {
              expiredTag = tag;
              break;
            }
            hasStaleTag = true;
          }
        }

        if (expiredTag) {
          log?.("get", cacheKey, "had expired tag", expiredTag);
          await redis.del(key);
          return undefined;
        }

        if (hasStaleTag) {
          // A negative revalidate makes Next serve the entry once more and
          // regenerate it in the background, as its built-in handler does.
          log?.("get", cacheKey, "had stale tag");
          revalidate = -1;
        }

        log?.("get", cacheKey, "found", {
          tags: entry.tags,
          timestamp: entry.timestamp,
          revalidate,
        });

        return { ...entry, revalidate };
      } catch (error) {
        // Degrade to a miss so the page still renders, but make it visible.
        log?.("get", cacheKey, "error", error);
        reportError("get", error);
        return undefined;
      }
    },

    async set(cacheKey, pendingEntry) {
      log?.("set", cacheKey, "start");

      let resolvePending: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSets.set(cacheKey, pending);

      try {
        await writeEntry(cacheKey, pendingEntry);
      } finally {
        resolvePending();
        // A newer set of the same key may have replaced ours; leave it in place.
        if (pendingSets.get(cacheKey) === pending) {
          pendingSets.delete(cacheKey);
        }
      }
    },

    async refreshTags() {
      // For Redis, tags are stored in a hash and don't need periodic refresh
      // unless you're syncing with an external tags service
      log?.("refreshTags", "no-op for Redis cache");
    },

    async getExpiration(tags) {
      try {
        // Per the Next.js contract, this returns the maximum timestamp of a
        // revalidate *event* for the tags (when they were last revalidated),
        // not a future deadline.
        const expirations = await Promise.all(
          tags.map(async (tag) => {
            const data = await redis.hGet(getTagKey(tag), "stale");
            return data ? Number.parseInt(data, 10) : 0;
          }),
        );

        const expiration = Math.max(...expirations, 0);

        log?.("getExpiration", { tags, expiration });

        return expiration;
      } catch (error) {
        log?.("getExpiration", "error", error);
        reportError("getExpiration", error);
        return 0;
      }
    },

    async updateTags(tags, durations) {
      const now = Date.now();
      const expire = redis.expire?.bind(redis);

      if (!expire && !warnedMissingExpire) {
        warnedMissingExpire = true;
        console.warn(
          "[RedisDataCache]: the Redis client has no expire() method, so tag revalidation records will never expire.",
        );
      }

      try {
        log?.("updateTags", { tags, timestamp: now, durations });

        await Promise.all(
          tags.map(async (tag) => {
            const key = getTagKey(tag);

            // Always record the revalidation event time. Entries created before
            // `now` are affected; entries cached afterward remain valid.
            await redis.hSet(key, "stale", now.toString());

            if (!durations) {
              // No durations -> immediate hard expiration.
              await redis.hSet(key, "expired", now.toString());
            } else if (durations.expire !== undefined) {
              // Hard-expire affected entries once the expire window elapses;
              // until then they are served stale.
              const expired = now + durations.expire * 1000;
              await redis.hSet(key, "expired", expired.toString());
            }
            // `durations` without `expire` -> stale only, no hard deadline.

            // Every entry this record can affect was created before `now` and
            // lives at most `tagTTL` from its creation, so after `tagTTL` the
            // record has nothing left to invalidate.
            await expire?.(key, tagTTL);
          }),
        );
      } catch (error) {
        log?.("updateTags", "error", error);
        reportError("updateTags", error);
      }
    },
  };
}
