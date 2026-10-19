/**
 * `"use cache"` handler: values in each instance's memory, tag invalidation shared through Redis.
 *
 * This is Next's Distributed Tag Coordination pattern
 * (https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination):
 *
 * - values stay in a per-process LRU and, like Next's built-in handler, are dropped at
 *   `revalidate` (warming an in-memory entry that may be evicted is not worth it), and never kept
 *   past the longest entry age (365 days);
 * - `updateTags` writes the invalidation to local state and to Redis (tag record plus the
 *   tag index);
 * - `refreshTags`, which Next runs once per request before the first read, syncs invalidations
 *   made by other instances since the last sync into local state;
 * - `getExpiration` and the tag check in `get` read local state only, never Redis. With Redis
 *   configured, `get` misses until a sync has completed since the connection was (re)established,
 *   so a failed or skipped sync cannot serve a value another instance invalidated.
 *
 * So `revalidateTag` on one instance also invalidates every other instance's memory copy. During
 * a Redis outage only local tags apply; the next `refreshTags` after reconnecting catches up.
 * Without Redis it is a plain memory handler.
 */

import { isEdgeRuntime } from "../shared/env.js";
import { MAX_ENTRY_AGE_SECONDS } from "../shared/keys.js";
import { type CacheOptions, createDebugLog, getCacheRuntime } from "../shared/runtime.js";
import { missHandler } from "./fallback.js";
import { REFRESH_TAGS_INTERVAL_MS } from "./remote.js";
import {
  type StoredDataEntry,
  createPendingSets,
  readPendingEntry,
  toDataCacheEntry,
} from "./stored-entry.js";
import type { DataCacheHandler } from "./types.js";

/**
 * Options of {@link createLocalCacheHandler}.
 */
export interface LocalCacheHandlerOptions extends CacheOptions {}

/**
 * When a value is dropped, in ms: at `revalidate`, and never past the longest entry age.
 */
function keepUntil(stored: StoredDataEntry): number {
  return stored.timestamp + Math.min(stored.revalidate, MAX_ENTRY_AGE_SECONDS) * 1000;
}

/**
 * Create the `"use cache"` handler: memory values with tag invalidation shared across instances
 * when Redis is configured.
 *
 * @example
 * ```js
 * // cache/default.mjs — a custom handler file for withCache({ handlers: { default } })
 * import { createLocalCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
 * export default createLocalCacheHandler();
 * ```
 */
export function createLocalCacheHandler(options: LocalCacheHandlerOptions = {}): DataCacheHandler {
  if (isEdgeRuntime()) return missHandler;
  const runtime = getCacheRuntime(options);
  const { tags, stores } = runtime;
  const log = createDebugLog("[LocalCache]:", options.debug);
  const pendingSets = createPendingSets();

  return {
    async get(cacheKey) {
      await pendingSets.wait(cacheKey);
      // Until a sync has completed since Redis (re)connected, local state may lack another
      // instance's invalidation of this value.
      if (!tags.isSynced()) {
        log?.("get", cacheKey, "miss (tags not synced)");
        return undefined;
      }
      const stored = stores.local.get(cacheKey) as StoredDataEntry | undefined;
      const entry = stored ? toDataCacheEntry(stored, tags, keepUntil(stored)) : undefined;
      log?.("get", cacheKey, entry ? "hit" : "miss");
      return entry;
    },

    async set(cacheKey, pendingEntry) {
      await pendingSets.track(cacheKey, async () => {
        const stored = await readPendingEntry(pendingEntry);
        if (!stored) return;
        const until = keepUntil(stored);
        if (until <= Date.now()) return;
        stores.local.set(cacheKey, stored, stored.value.byteLength, until);
        log?.("set", cacheKey);
      });
    },

    async refreshTags() {
      await tags.sync(REFRESH_TAGS_INTERVAL_MS);
    },

    async getExpiration(tagList) {
      return tags.getExpiration(tagList);
    },

    async updateTags(tagList, durations) {
      log?.("updateTags", tagList, durations);
      await tags.update(tagList, durations);
    },
  };
}
