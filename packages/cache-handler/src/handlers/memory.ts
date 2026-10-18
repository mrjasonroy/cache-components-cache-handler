import {
  DEFAULT_EXPIRE_FACTOR,
  type TagRevalidation,
  createTagRevalidation,
  getCacheControl,
  getEntryLifespan,
  getEntryTags,
  getStaleLastModified,
  getTagFreshness,
  getTagsToCheck,
} from "../helpers/isr.js";
import { isExpired } from "../helpers/lifespan.js";
import { jsonReplacer } from "../helpers/serialization.js";
import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerGetResult,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
  RevalidateTagDurations,
} from "../types.js";

export interface MemoryCacheHandlerOptions extends CacheHandlerOptions {
  /**
   * Maximum number of items to store (LRU eviction when exceeded)
   * @default 1000
   */
  maxItemsNumber?: number;

  /**
   * Maximum size in bytes for a single item
   * @default 104857600 (100MB)
   */
  maxItemSizeBytes?: number;

  /**
   * Default TTL in seconds for entries without explicit revalidate
   * @default undefined (no expiration)
   */
  defaultTTL?: number;

  /**
   * How long an entry with a revalidate period is kept, as a multiple of that
   * period, so Next.js can serve it stale while it regenerates. Never longer
   * than Next.js's `expire` for the entry.
   * @default 2
   */
  expireFactor?: number;
}

/**
 * In-memory LRU cache handler for Next.js 16+
 * Suitable for development and single-instance deployments
 *
 * Features:
 * - LRU eviction based on item count and size
 * - Implicit tag tracking for ISR
 * - Proper expiration handling
 * - Tag-based revalidation
 *
 * @example
 * ```typescript
 * const handler = createMemoryCacheHandler({
 *   maxItemsNumber: 1000,
 *   maxItemSizeBytes: 100 * 1024 * 1024, // 100MB
 *   defaultTTL: 3600 // 1 hour
 * });
 * ```
 */
export class MemoryCacheHandler implements CacheHandler {
  public readonly name = "local-lru";

  private cache: Map<string, CacheHandlerValue>;
  private revalidatedTags: Map<string, TagRevalidation>;
  private readonly maxItemsNumber: number;
  private readonly maxItemSizeBytes: number;
  private readonly defaultTTL?: number;
  private readonly expireFactor: number;

  constructor(options: MemoryCacheHandlerOptions = {}) {
    this.cache = new Map();
    this.revalidatedTags = new Map();
    this.maxItemsNumber = options.maxItemsNumber ?? 1000;
    this.maxItemSizeBytes = options.maxItemSizeBytes ?? 104857600; // 100MB
    this.defaultTTL = options.defaultTTL;
    this.expireFactor = options.expireFactor ?? DEFAULT_EXPIRE_FACTOR;
  }

  async get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheHandlerGetResult | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired based on lifespan
    if (entry.lifespan && isExpired(entry.lifespan)) {
      await this.delete(key);
      return null;
    }

    // Check every tag (stored, header, soft and implicit) against its revalidation
    const records = getTagsToCheck(entry, meta).map((tag) => this.revalidatedTags.get(tag));
    const now = Date.now();
    const freshness = getTagFreshness(records, entry.lastModified, now);

    let lastModified = entry.lastModified;
    if (freshness === "stale") {
      const staleLastModified = getStaleLastModified(entry, meta, now);
      if (staleLastModified === null) return null;
      lastModified = staleLastModified;
    } else if (freshness === "expired") {
      return null;
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);

    // Return the cache handler result with value and metadata
    return {
      value: entry.value,
      lastModified,
      age: now - lastModified,
      ...(entry.cacheControl && { cacheControl: entry.cacheControl }),
    };
  }

  async set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void> {
    // Calculate size of the entry (use replacer to account for Map/Buffer)
    const size = JSON.stringify(value, jsonReplacer).length;

    // Check if entry exceeds max size
    if (size > this.maxItemSizeBytes) {
      // Skip storing oversized entries
      return;
    }

    // Enforce max items (LRU eviction)
    if (this.cache.size >= this.maxItemsNumber) {
      // Delete the oldest entry (first in Map)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        await this.delete(firstKey);
      }
    }

    const cacheControl = getCacheControl(value, context);
    const lifespan = getEntryLifespan(cacheControl, this.defaultTTL, this.expireFactor);

    // Tags from ctx.tags (fetch) and the x-next-cache-tags header (pages);
    // the request's implicit tags are passed to get()
    const tags = getEntryTags(value, context);

    const entry: CacheHandlerValue = {
      lastModified: Date.now(),
      lifespan,
      tags,
      value,
      ...(cacheControl && { cacheControl }),
    };

    this.cache.set(key, entry);
  }

  /**
   * Records the revalidation of each tag, as Next.js's own tags manifest does:
   * without durations tagged entries expire now; with them they are served
   * stale until `durations.expire` seconds pass. get() applies it.
   */
  async revalidateTag(
    tags: string | string[],
    durations?: RevalidateTagDurations | string,
  ): Promise<void> {
    const now = Date.now();
    const record = createTagRevalidation(durations, now);
    for (const tag of typeof tags === "string" ? [tags] : tags) {
      const existing = this.revalidatedTags.get(tag);
      // An earlier immediate expiry still applies unless these durations set a new one
      this.revalidatedTags.set(
        tag,
        existing && record.expired === undefined
          ? { ...record, expired: existing.expired }
          : record,
      );
    }
  }

  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  /**
   * Clear all cache entries (useful for testing)
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.revalidatedTags.clear();
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxItemsNumber,
      revalidatedTags: this.revalidatedTags.size,
    };
  }
}

/**
 * Create a memory cache handler instance
 *
 * @example
 * ```typescript
 * const handler = createMemoryCacheHandler({
 *   maxItemsNumber: 500,
 *   defaultTTL: 3600
 * });
 * ```
 */
export function createMemoryCacheHandler(options?: MemoryCacheHandlerOptions): MemoryCacheHandler {
  return new MemoryCacheHandler(options);
}
