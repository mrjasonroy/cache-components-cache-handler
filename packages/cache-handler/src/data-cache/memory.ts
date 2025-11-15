/**
 * Memory-based Data Cache Handler for "use cache" directive
 * Based on Next.js default handler but with customizable options
 *
 * In-memory caches are fragile and should not use stale-while-revalidate
 * semantics because entries may be evicted before reuse. Stale entries
 * are considered expired/missing.
 */

import type { DataCacheEntry, DataCacheHandler, Timestamp } from "./types.js";

export interface MemoryDataCacheHandlerOptions {
  /**
   * Maximum cache size in bytes
   * @default 50MB (50 * 1024 * 1024)
   */
  maxSize?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

interface PrivateCacheEntry {
  entry: DataCacheEntry;

  /**
   * For the default cache we store errored cache
   * entries and allow them to be used up to 3 times
   * after that we want to dispose it and try for fresh
   */
  isErrored: boolean;
  errorRetryCount: number;

  /**
   * Compute size on set since we need to read size
   * of the ReadableStream for LRU evicting
   */
  size: number;
}

interface TagManifestEntry {
  expired?: number;
  stale?: number;
}

/**
 * Simple LRU cache implementation
 */
class LRUCache<T> {
  private cache = new Map<string, T>();
  private readonly maxSize: number;
  private readonly sizeOf: (value: T) => number;
  private currentSize = 0;

  constructor(maxSize: number, sizeOf: (value: T) => number) {
    this.maxSize = maxSize;
    this.sizeOf = sizeOf;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // Remove existing if present
    const existing = this.cache.get(key);
    if (existing !== undefined) {
      this.currentSize -= this.sizeOf(existing);
      this.cache.delete(key);
    }

    const size = this.sizeOf(value);

    // Evict oldest entries if needed
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        const firstValue = this.cache.get(firstKey);
        if (firstValue !== undefined) {
          this.currentSize -= this.sizeOf(firstValue);
        }
        this.cache.delete(firstKey);
      }
    }

    // Add new entry
    this.cache.set(key, value);
    this.currentSize += size;
  }

  delete(key: string): void {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.currentSize -= this.sizeOf(value);
      this.cache.delete(key);
    }
  }

  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }
}

/**
 * Global tags manifest shared across all handler instances
 *
 * This is necessary because Next.js may create multiple handler instances
 * (e.g., one for "default" profile and one for "remote" profile), but
 * revalidateTag() needs to invalidate entries across ALL instances.
 *
 * ## Tag Revalidation Semantics
 *
 * When `updateTags()` is called, it can operate in two modes:
 *
 * ### 1. Immediate Expiration (deprecated, for testing)
 * ```typescript
 * updateTags(['my-tag'], undefined)
 * // Sets: expired = now (entries expire immediately)
 * ```
 *
 * ### 2. Stale-While-Revalidate (recommended for production)
 * ```typescript
 * updateTags(['my-tag'], { expire: 3600 })
 * // Sets: stale = now, expired = now + 3600 * 1000
 * // Entries are marked stale immediately but won't expire for 1 hour
 * ```
 *
 * ## Entry Lifecycle
 *
 * When `get()` is called, entries go through these checks:
 *
 * 1. **TTL Check**: Entry expires if `now > timestamp + revalidate * 1000`
 * 2. **Tag Expiration Check**: Entry expires if ANY tag was revalidated after entry creation
 *    - Skips tags with future expiration times (stale-while-revalidate)
 * 3. **Tag Staleness Check**: Entry is marked stale (revalidate = -1) if ANY tag's stale
 *    timestamp is after entry creation
 *
 * This allows entries to be served with stale data while revalidating in the background.
 */
const globalTagsManifest = new Map<string, TagManifestEntry>();

/**
 * Check if tags are expired based on manifest
 * Returns true if any tag was revalidated (invalidated) after the entry was created
 */
function areTagsExpired(
  tags: string[],
  timestamp: Timestamp,
  debug?: (message: string, data: unknown) => void,
): boolean {
  const now = Math.round(performance.timeOrigin + performance.now());

  for (const tag of tags) {
    const entry = globalTagsManifest.get(tag);
    const expiredAt = entry?.expired;

    debug?.("areTagsExpired checking", {
      tag,
      entryTimestamp: timestamp,
      expiredAt,
      now,
    });

    if (typeof expiredAt === "number") {
      // Match Next.js logic exactly:
      // Entry is expired if:
      // 1. expiredAt <= now (tag revalidation time has passed)
      // 2. expiredAt > timestamp (tag was revalidated AFTER entry was created)
      const isImmediatelyExpired = expiredAt <= now && expiredAt > timestamp;

      debug?.("areTagsExpired result", {
        tag,
        isImmediatelyExpired,
        check1: `expiredAt (${expiredAt}) <= now (${now})`,
        check1Result: expiredAt <= now,
        check2: `expiredAt (${expiredAt}) > timestamp (${timestamp})`,
        check2Result: expiredAt > timestamp,
      });

      if (isImmediatelyExpired) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check if tags are stale based on manifest
 * Returns true if any tag was marked stale AFTER the entry was created
 */
function areTagsStale(tags: string[], timestamp: Timestamp): boolean {
  for (const tag of tags) {
    const entry = globalTagsManifest.get(tag);
    const staleAt = entry?.stale ?? 0;

    // Match Next.js logic: entry is stale if tag's stale timestamp > entry's creation timestamp
    if (typeof staleAt === "number" && staleAt > timestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Create a memory-based data cache handler for "use cache" directive
 *
 * @example
 * ```typescript
 * // cache-handler.mjs
 * import { createMemoryDataCacheHandler } from '@mrjasonroy/better-nextjs-cache-handler/data-cache';
 *
 * export default createMemoryDataCacheHandler({
 *   maxSize: 100 * 1024 * 1024, // 100MB
 *   debug: process.env.NODE_ENV === 'development'
 * });
 * ```
 *
 * Then in next.config.js:
 * ```javascript
 * module.exports = {
 *   cacheComponents: true,
 *   cacheHandlers: {
 *     default: require.resolve('./cache-handler.mjs')
 *   }
 * }
 * ```
 */
export function createMemoryDataCacheHandler(
  options: MemoryDataCacheHandlerOptions = {},
): DataCacheHandler {
  const maxSize = options.maxSize ?? 50 * 1024 * 1024; // 50MB default

  // If max size is 0, return a no-op handler
  if (maxSize === 0) {
    return {
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
      refreshTags: () => Promise.resolve(),
      getExpiration: () => Promise.resolve(0),
      updateTags: () => Promise.resolve(),
    };
  }

  const memoryCache = new LRUCache<PrivateCacheEntry>(maxSize, (entry) => entry.size);
  const pendingSets = new Map<string, Promise<void>>();

  const debug = options.debug ? console.debug.bind(console, "[MemoryDataCache]:") : undefined;

  return {
    async get(cacheKey, _softTags) {
      const pendingPromise = pendingSets.get(cacheKey);

      if (pendingPromise) {
        debug?.("get", cacheKey, "pending");
        await pendingPromise;
      }

      const privateEntry = memoryCache.get(cacheKey);

      if (!privateEntry) {
        debug?.("get", cacheKey, "not found");
        return undefined;
      }

      const entry = privateEntry.entry;
      const now = performance.timeOrigin + performance.now();

      // In-memory caches should expire after revalidate time
      if (now > entry.timestamp + entry.revalidate * 1000) {
        debug?.("get", cacheKey, "expired");
        return undefined;
      }

      let revalidate = entry.revalidate;

      if (areTagsExpired(entry.tags, entry.timestamp, debug)) {
        debug?.("get", cacheKey, "had expired tag");
        return undefined;
      }

      if (areTagsStale(entry.tags, entry.timestamp)) {
        debug?.("get", cacheKey, "had stale tag");
        revalidate = -1;
      }

      // Tee the stream so we can return it and keep a copy
      const [returnStream, newSaved] = entry.value.tee();
      entry.value = newSaved;

      debug?.("get", cacheKey, "found", {
        tags: entry.tags,
        timestamp: entry.timestamp,
        expire: entry.expire,
        revalidate,
      });

      return {
        ...entry,
        revalidate,
        value: returnStream,
      };
    },

    async set(cacheKey, pendingEntry) {
      debug?.("set", cacheKey, "start");

      let resolvePending: () => void = () => {};
      const pendingPromise = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingSets.set(cacheKey, pendingPromise);

      try {
        const entry = await pendingEntry;
        let size = 0;

        // Tee the stream to read size and store value
        const [value, clonedValue] = entry.value.tee();
        entry.value = value;
        const reader = clonedValue.getReader();

        // Calculate total size by reading the stream
        // biome-ignore lint/suspicious/noImplicitAnyLet: Chunk type inferred from reader
        // biome-ignore lint/suspicious/noAssignInExpressions: Idiomatic pattern for stream reading
        for (let chunk; !(chunk = await reader.read()).done; ) {
          size += Buffer.from(chunk.value).byteLength;
        }

        memoryCache.set(cacheKey, {
          entry,
          isErrored: false,
          errorRetryCount: 0,
          size,
        });

        debug?.("set", cacheKey, "done", { size });
      } catch (err) {
        debug?.("set", cacheKey, "failed", err);
      } finally {
        resolvePending();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags() {
      // Nothing to do for in-memory cache
      debug?.("refreshTags", "no-op for memory cache");
    },

    async getExpiration(tags) {
      const expirations = tags.map((tag) => {
        const entry = globalTagsManifest.get(tag);
        if (!entry) return 0;
        // Return the most recent timestamp (either expired or stale)
        return entry.expired || 0;
      });

      const expiration = Math.max(...expirations, 0);

      debug?.("getExpiration", { tags, expiration });

      return expiration;
    },

    async updateTags(tags, durations) {
      const now = Math.round(performance.timeOrigin + performance.now());
      debug?.("updateTags", { tags, timestamp: now, durations });

      for (const tag of tags) {
        const existingEntry = globalTagsManifest.get(tag) || {};

        if (durations) {
          // Use provided durations directly
          const updates: TagManifestEntry = { ...existingEntry };

          // mark as stale immediately
          updates.stale = now;

          if (durations.expire !== undefined) {
            updates.expired = now + durations.expire * 1000; // Convert seconds to ms
          }

          globalTagsManifest.set(tag, updates);
        } else {
          // Update expired field for immediate expiration (default behavior)
          globalTagsManifest.set(tag, { ...existingEntry, expired: now });
        }
      }
    },
  };
}
