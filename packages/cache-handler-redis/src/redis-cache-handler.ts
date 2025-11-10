import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
} from "@mrjasonroy/cache-components-cache-handler";
import { calculateLifespan, isExpired } from "@mrjasonroy/cache-components-cache-handler";
import Redis, { type RedisOptions } from "ioredis";

export interface RedisCacheHandlerOptions extends CacheHandlerOptions {
  /**
   * Redis connection options (ioredis)
   * Can be a URL string or RedisOptions object
   */
  redis?: string | RedisOptions;

  /**
   * Key prefix for all cache entries
   * @default "nextjs:cache:"
   */
  keyPrefix?: string;

  /**
   * Key prefix for tag tracking
   * @default "nextjs:tags:"
   */
  tagPrefix?: string;

  /**
   * Default TTL in seconds for entries without explicit revalidate
   * @default undefined (no expiration)
   */
  defaultTTL?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * Redis cache handler for Next.js 16+ with Cache Components support
 *
 * Features:
 * - Persistent caching across server restarts
 * - Tag-based revalidation with Redis Sets
 * - TTL support with automatic expiration
 * - Compatible with Redis, ElastiCache, and Valkey
 * - Connection pooling via ioredis
 *
 * @example
 * ```typescript
 * // In cache-handler.mjs or data-cache-handler.mjs
 * import { RedisCacheHandler } from "@mrjasonroy/better-nextjs-cache-handler-redis";
 *
 * export default class NextCacheHandler extends RedisCacheHandler {
 *   constructor(options) {
 *     super({
 *       ...options,
 *       redis: process.env.REDIS_URL || "redis://localhost:6379",
 *       keyPrefix: "nextjs:cache:",
 *       defaultTTL: 3600
 *     });
 *   }
 * }
 * ```
 */
export class RedisCacheHandler implements CacheHandler {
  public readonly name = "redis";

  private redis: Redis;
  private readonly keyPrefix: string;
  private readonly tagPrefix: string;
  private readonly defaultTTL?: number;
  private readonly debug: boolean;

  constructor(options: RedisCacheHandlerOptions = {}) {
    // Initialize Redis connection
    if (typeof options.redis === "string") {
      this.redis = new Redis(options.redis);
    } else {
      this.redis = new Redis(options.redis || {});
    }

    this.keyPrefix = options.keyPrefix ?? "nextjs:cache:";
    this.tagPrefix = options.tagPrefix ?? "nextjs:tags:";
    this.defaultTTL = options.defaultTTL;
    this.debug = options.debug ?? false;

    // Handle Redis connection errors
    this.redis.on("error", (err) => {
      console.error("[RedisCacheHandler] Redis connection error:", err);
    });

    if (this.debug) {
      console.log("[RedisCacheHandler] Initialized", {
        keyPrefix: this.keyPrefix,
        tagPrefix: this.tagPrefix,
        defaultTTL: this.defaultTTL,
      });
    }
  }

  private log(...args: unknown[]) {
    if (this.debug) {
      console.log("[RedisCacheHandler]", ...args);
    }
  }

  private getCacheKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  private getTagKey(tag: string): string {
    return `${this.tagPrefix}${tag}`;
  }

  async get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null> {
    try {
      const cacheKey = this.getCacheKey(key);
      this.log("GET", cacheKey);

      // Get the cached entry
      const data = await this.redis.get(cacheKey);

      if (!data) {
        this.log("GET", cacheKey, "MISS");
        return null;
      }

      // Parse the stored entry
      const entry: CacheHandlerValue = JSON.parse(data);

      // Check if expired based on lifespan
      if (entry.lifespan && isExpired(entry.lifespan)) {
        this.log("GET", cacheKey, "EXPIRED");
        await this.delete(key);
        return null;
      }

      // Check if any tag (explicit or implicit) has been revalidated
      const allTags = [...entry.tags, ...(meta?.implicitTags ?? [])];

      for (const tag of allTags) {
        const tagKey = this.getTagKey(tag);
        const revalidatedAt = await this.redis.get(tagKey);

        // If tag was revalidated after entry was last modified, entry is stale
        if (revalidatedAt && Number.parseInt(revalidatedAt) > entry.lastModified) {
          this.log("GET", cacheKey, "STALE (tag revalidated)", tag);
          await this.delete(key);
          return null;
        }
      }

      this.log("GET", cacheKey, "HIT");
      return entry.value;
    } catch (error) {
      console.error("[RedisCacheHandler] GET error:", error);
      return null;
    }
  }

  async set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void> {
    try {
      const cacheKey = this.getCacheKey(key);

      // Calculate lifespan and TTL
      const lifespan = calculateLifespan(context?.revalidate, this.defaultTTL);
      const tags = context?.tags ?? [];

      const entry: CacheHandlerValue = {
        lastModified: Date.now(),
        lifespan,
        tags,
        value,
      };

      const serialized = JSON.stringify(entry);

      // Determine TTL for Redis
      let ttl: number | undefined;
      if (lifespan?.expireAt) {
        // Use expire time as TTL
        ttl = Math.ceil((lifespan.expireAt - Date.now()) / 1000);
        if (ttl <= 0) {
          this.log("SET", cacheKey, "SKIP (already expired)");
          return;
        }
      }

      // Store in Redis with optional TTL
      if (ttl) {
        await this.redis.setex(cacheKey, ttl, serialized);
        this.log("SET", cacheKey, `TTL=${ttl}s`, `kind=${value.kind}`);
      } else {
        await this.redis.set(cacheKey, serialized);
        this.log("SET", cacheKey, "NO_TTL", `kind=${value.kind}`);
      }

      // Track tags -> keys mapping for revalidation
      if (tags.length > 0) {
        const pipeline = this.redis.pipeline();

        for (const tag of tags) {
          const tagKey = this.getTagKey(tag);
          // Use a set to store all cache keys with this tag
          pipeline.sadd(`${tagKey}:keys`, cacheKey);
          // Set expiration on the tag's key set if we have a TTL
          if (ttl) {
            pipeline.expire(`${tagKey}:keys`, ttl);
          }
        }

        await pipeline.exec();
        this.log("SET", cacheKey, "tags:", tags);
      }
    } catch (error) {
      console.error("[RedisCacheHandler] SET error:", error);
    }
  }

  async revalidateTag(tag: string, _profile?: string | { expire?: number }): Promise<void> {
    try {
      const tagKey = this.getTagKey(tag);

      // Store revalidation timestamp
      await this.redis.set(tagKey, Date.now().toString());
      this.log("revalidateTag", tag);

      // Delete all cache keys associated with this tag
      const keysSetKey = `${tagKey}:keys`;
      const cacheKeys = await this.redis.smembers(keysSetKey);

      if (cacheKeys.length > 0) {
        const pipeline = this.redis.pipeline();

        for (const cacheKey of cacheKeys) {
          pipeline.del(cacheKey);
        }

        // Clear the tag's keys set
        pipeline.del(keysSetKey);

        await pipeline.exec();
        this.log("revalidateTag", tag, `deleted ${cacheKeys.length} entries`);
      }
    } catch (error) {
      console.error("[RedisCacheHandler] revalidateTag error:", error);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const cacheKey = this.getCacheKey(key);
      await this.redis.del(cacheKey);
      this.log("DELETE", cacheKey);
    } catch (error) {
      console.error("[RedisCacheHandler] DELETE error:", error);
    }
  }

  /**
   * Close the Redis connection
   * Call this when shutting down your application
   */
  async close(): Promise<void> {
    try {
      await this.redis.quit();
      this.log("Connection closed");
    } catch (error) {
      console.error("[RedisCacheHandler] close error:", error);
    }
  }
}
