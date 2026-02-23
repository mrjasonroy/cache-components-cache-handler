import Redis, { type RedisOptions } from "ioredis";
import { calculateLifespan, isExpired } from "../helpers/lifespan.js";
import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerGetResult,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
} from "../types.js";

/**
 * Custom JSON replacer that serializes Map and Buffer instances.
 * - Maps become `{ __serialized_type: "Map", entries: [...] }`
 * - Buffers become `{ __serialized_type: "Buffer", data: "<base64>" }`
 *
 * This is needed because Next.js 16 APP_PAGE entries store `segmentData`
 * as a Map<string, Buffer> and `rscData` as a Buffer, neither of which
 * survive a plain JSON.stringify round-trip.
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return {
      __serialized_type: "Map",
      entries: Array.from(value.entries()),
    };
  }
  if (Buffer.isBuffer(value)) {
    return {
      __serialized_type: "Buffer",
      data: value.toString("base64"),
    };
  }
  return value;
}

/**
 * Custom JSON reviver that restores Map and Buffer instances.
 * Also handles backward-compat with Node's native Buffer JSON
 * representation `{ type: "Buffer", data: [byte, ...] }`.
 */
function jsonReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (
      obj.__serialized_type === "Map" &&
      Array.isArray(obj.entries) &&
      obj.entries.every((e) => Array.isArray(e) && e.length === 2)
    ) {
      return new Map(obj.entries as [unknown, unknown][]);
    }

    if (obj.__serialized_type === "Buffer" && typeof obj.data === "string") {
      return Buffer.from(obj.data, "base64");
    }

    // Backward compat: Node's Buffer.toJSON() format
    if (obj.type === "Buffer" && Array.isArray(obj.data)) {
      return Buffer.from(obj.data as number[]);
    }
  }
  return value;
}

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
 * import { RedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler/handlers/redis";
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

  async get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheHandlerGetResult | null> {
    try {
      const cacheKey = this.getCacheKey(key);
      this.log("GET", cacheKey);

      // Get the cached entry
      const data = await this.redis.get(cacheKey);

      if (!data) {
        this.log("GET", cacheKey, "MISS");
        return null;
      }

      // Parse the stored entry (reviver restores Map/Buffer instances)
      const entry: CacheHandlerValue = JSON.parse(data, jsonReviver);

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

      // Return the cache handler result with value and metadata
      return {
        value: entry.value,
        lastModified: entry.lastModified,
        age: Date.now() - entry.lastModified,
      };
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

      const serialized = JSON.stringify(entry, jsonReplacer);

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
