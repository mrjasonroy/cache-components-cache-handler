import { isImplicitTag } from "../helpers/is-implicit-tag.js";
import { calculateLifespan, isExpired } from "../helpers/lifespan.js";
import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerGetMeta,
  CacheHandlerOptions,
  CacheHandlerValue,
  CacheValue,
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
  private revalidatedTags: Map<string, number>; // tag -> timestamp (milliseconds)
  private readonly maxItemsNumber: number;
  private readonly maxItemSizeBytes: number;
  private readonly defaultTTL?: number;

  constructor(options: MemoryCacheHandlerOptions = {}) {
    this.cache = new Map();
    this.revalidatedTags = new Map();
    this.maxItemsNumber = options.maxItemsNumber ?? 1000;
    this.maxItemSizeBytes = options.maxItemSizeBytes ?? 104857600; // 100MB
    this.defaultTTL = options.defaultTTL;
  }

  async get(key: string, meta?: CacheHandlerGetMeta): Promise<CacheValue | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if expired based on lifespan
    if (entry.lifespan && isExpired(entry.lifespan)) {
      await this.delete(key);
      return null;
    }

    // Check if any tag (explicit or implicit) has been revalidated
    const allTags = [...entry.tags, ...(meta?.implicitTags ?? [])];

    for (const tag of allTags) {
      const revalidatedAt = this.revalidatedTags.get(tag);

      // If tag was revalidated after entry was last modified, entry is stale
      if (revalidatedAt && revalidatedAt > entry.lastModified) {
        await this.delete(key);
        return null;
      }
    }

    // Move to end for LRU (delete and re-add)
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  async set(key: string, value: CacheValue, context?: CacheHandlerContext): Promise<void> {
    // Calculate size of the entry
    const size = JSON.stringify(value).length;

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

    // Calculate lifespan
    const lifespan = calculateLifespan(context?.revalidate, this.defaultTTL);

    // Combine tags (explicit user tags only - implicit tags are passed in get())
    const tags = context?.tags ?? [];

    const entry: CacheHandlerValue = {
      lastModified: Date.now(),
      lifespan,
      tags,
      value,
    };

    this.cache.set(key, entry);
  }

  async revalidateTag(tag: string, _profile?: string | { expire?: number }): Promise<void> {
    // Store revalidation timestamp
    // Note: profile parameter is used by Next.js for cache-life configuration
    // but for memory handler we just invalidate immediately
    this.revalidatedTags.set(tag, Date.now());

    // For explicit tags (non-implicit), we can directly delete entries
    if (!isImplicitTag(tag)) {
      const keysToDelete: string[] = [];

      for (const [key, entry] of this.cache.entries()) {
        if (entry.tags.includes(tag)) {
          keysToDelete.push(key);
        }
      }

      // Delete all entries with this tag
      for (const key of keysToDelete) {
        await this.delete(key);
      }
    }

    // For implicit tags, we rely on the get() method to check revalidation
    // This is because implicit tags are passed dynamically in meta.implicitTags
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
