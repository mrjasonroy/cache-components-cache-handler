/**
 * `"use cache: remote"` handler: entries in Redis, shared by every instance, with the memory
 * fallback built in.
 *
 * - Entries live under `<prefix><buildId>:data:<key>` in the binary v2 format
 *   (`../shared/codec.ts`), with a TTL of `timestamp + expire` capped at the tag TTL. They are
 *   served until `expire`; past `revalidate` Next serves them and regenerates in the background.
 * - Tags go through the process's shared tag store (`../shared/tag-store.ts`): `refreshTags`
 *   syncs, `getExpiration` and the tag check in `get` read local state only.
 * - While Redis is down, entries go to process memory for at most 60 s and that memory is never
 *   read, and is emptied, once Redis is back. `memoryFallback: false` misses instead.
 * - Entries tagged {@link MEMORY_ONLY_TAG} stay in process memory.
 * - Without Redis (no URL, `next build`, `CACHE_REDIS=off`) everything is kept in memory.
 * - Errors never throw out of the handler: a cache error is a miss plus a rate-limited log line.
 */

import { getBuildId } from "../shared/build-id.js";
import { decodeEntry, encodeEntry } from "../shared/codec.js";
import { dataKey } from "../shared/keys.js";
import {
  type CacheOptions,
  FALLBACK_TTL_SECONDS,
  MEMORY_ONLY_TAG,
  createDebugLog,
  getCacheRuntime,
  isRedisReady,
} from "../shared/runtime.js";
import {
  type StoredDataEntry,
  createPendingSets,
  readPendingEntry,
  storedEntryTTL,
  toDataCacheEntry,
} from "./stored-entry.js";
import type { DataCacheHandler } from "./types.js";

/**
 * How often `refreshTags` may sync tags, at most, in ms. Concurrent requests share one sync.
 */
export const REFRESH_TAGS_INTERVAL_MS = 100;

/**
 * Options of {@link createRemoteCacheHandler}.
 */
export interface RemoteCacheHandlerOptions extends CacheOptions {
  /**
   * The build ID that scopes entry keys.
   * @default the app's BUILD_ID, read lazily on first use
   */
  buildId?: string;
}

interface InMemoryEntry {
  stored: StoredDataEntry;
  until: number;
}

/**
 * Create the `"use cache: remote"` handler: Redis plus a bounded memory fallback.
 *
 * @example
 * ```js
 * // cache/remote.mjs — a custom handler file for withCache({ handlers: { remote } })
 * import { createRemoteCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
 * import { client } from "./redis.mjs";
 * export default createRemoteCacheHandler({ client });
 * ```
 */
export function createRemoteCacheHandler(
  options: RemoteCacheHandlerOptions = {},
): DataCacheHandler {
  const runtime = getCacheRuntime(options);
  const { connection, tags, stores } = runtime;
  const memoryFallback = options.memoryFallback ?? true;
  const log = createDebugLog("[RemoteCache]:", options.debug);
  const pendingSets = createPendingSets();
  const keyOf = (cacheKey: string) =>
    dataKey(runtime.keyPrefix, options.buildId ?? getBuildId(), cacheKey);

  function fromMemory(store: typeof stores.data, cacheKey: string) {
    const found = store.get(cacheKey) as InMemoryEntry | undefined;
    return found ? toDataCacheEntry(found.stored, tags, found.until) : undefined;
  }

  return {
    async get(cacheKey) {
      await pendingSets.wait(cacheKey);

      const local = fromMemory(stores.data, cacheKey);
      if (local || !connection) {
        log?.("get", cacheKey, local ? "memory hit" : "miss");
        return local;
      }

      if (!(await isRedisReady(runtime))) {
        log?.("get", cacheKey, "Redis down");
        return memoryFallback ? fromMemory(stores.dataFallback, cacheKey) : undefined;
      }

      try {
        const stored = decodeEntry<StoredDataEntry>(
          await connection.client.getBuffer(keyOf(cacheKey)),
        );
        if (!stored || !(stored.value instanceof Uint8Array)) {
          log?.("get", cacheKey, "miss");
          return undefined;
        }
        const entry = toDataCacheEntry(stored, tags, stored.timestamp + stored.expire * 1000);
        log?.("get", cacheKey, entry ? "hit" : "invalidated");
        return entry;
      } catch (error) {
        runtime.reportError("get", error);
        return undefined;
      }
    },

    async set(cacheKey, pendingEntry) {
      await pendingSets.track(cacheKey, async () => {
        const stored = await readPendingEntry(pendingEntry);
        if (!stored) return;
        const ttl = storedEntryTTL(stored);
        // Already expired (e.g. `expire: 0`); Redis rejects `EX 0`.
        if (ttl <= 0) return;
        const now = Date.now();

        if (!connection || stored.tags.includes(MEMORY_ONLY_TAG)) {
          stores.data.set(
            cacheKey,
            { stored, until: now + ttl * 1000 },
            stored.value.byteLength,
            now + ttl * 1000,
          );
          log?.("set", cacheKey, "memory", { ttl });
          return;
        }

        if (await isRedisReady(runtime)) {
          try {
            await connection.client.set(keyOf(cacheKey), encodeEntry(stored), "EX", ttl);
            log?.("set", cacheKey, "redis", { ttl });
            return;
          } catch (error) {
            runtime.reportError("set", error);
          }
        }

        if (!memoryFallback) return;
        const until = now + Math.min(ttl, FALLBACK_TTL_SECONDS) * 1000;
        stores.dataFallback.set(cacheKey, { stored, until }, stored.value.byteLength, until);
        log?.("set", cacheKey, "fallback memory");
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
