/**
 * `"use cache: remote"` handler: entries in Redis, shared by every instance, with the memory
 * fallback built in.
 *
 * - Entries live under `<prefix><buildId>:data:<key>` in the binary v2 format, Brotli-compressed
 *   (v3) from 16 KB unless `CACHE_COMPRESSION=off` (`../shared/codec.ts`), with a TTL of `timestamp + expire` capped at the longest entry age
 *   (365 days), which reads enforce too. They are served until `expire`; past `revalidate` Next
 *   serves them and regenerates in the background.
 * - Tags go through the process's shared tag store (`../shared/tag-store.ts`). Like the page
 *   handler, `get` reads the records of the entry's tags and the soft tags from Redis in the same
 *   round trip as the entry (`../shared/read-with-tags.ts`), so it never depends on `refreshTags`
 *   having synced; a tag-read error is a miss. `getExpiration` reads local state only.
 * - While Redis is down, entries go to process memory for at most 60 s and that memory is never
 *   read, and is emptied, once Redis is back. `memoryFallback: false` misses instead.
 * - Entries tagged {@link MEMORY_ONLY_TAG} stay in process memory.
 * - Without Redis (no URL, `next build`, `CACHE_REDIS=off`) everything is kept in memory.
 * - Errors never throw out of the handler: a cache error is a miss plus a rate-limited log line.
 */

import { getBuildId } from "../shared/build-id.js";
import { nowMs, toNextClock } from "../shared/clock.js";
import { decodeStored, encodeEntry, encodeStored } from "../shared/codec.js";
import { isEdgeRuntime } from "../shared/env.js";
import { dataKey } from "../shared/keys.js";
import { readWithTags } from "../shared/read-with-tags.js";
import {
  type CacheOptions,
  type CacheRuntime,
  FALLBACK_TTL_SECONDS,
  MEMORY_ONLY_TAG,
  createDebugLog,
  isRedisReady,
  liveCacheRuntime,
} from "../shared/runtime.js";
import { REFRESH_TAGS_INTERVAL_MS } from "../shared/tag-store.js";
import { missHandler } from "./fallback.js";
import {
  type StoredDataEntry,
  createPendingSets,
  readPendingEntry,
  storedEntryTTL,
  toDataCacheEntry,
} from "./stored-entry.js";
import type { DataCacheHandler } from "./types.js";

/**
 * Options of {@link createRemoteCacheHandler}.
 */
export interface RemoteCacheHandlerOptions extends CacheOptions {
  /**
   * The build ID that scopes entry keys.
   * @default the app's BUILD_ID, read lazily on first use
   */
  buildId?: string;

  /**
   * Seconds to keep an entry whose `expire` is infinite (a `cacheLife` without `expire`). An entry
   * with a finite `expire` is kept until it expires. Both are capped at 365 days.
   * @default 86400 (24 hours)
   */
  defaultTTL?: number;
}

/**
 * Sizes for the debug log of an entry in memory: the value's bytes, and the entry's v2 encoding.
 * Only computed with debug logging on (arguments of an optional call are not evaluated otherwise).
 */
function sizes(stored: StoredDataEntry): { bytes: number; encodedBytes: number } {
  return { bytes: stored.value.byteLength, encodedBytes: encodeEntry(stored).byteLength };
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
  if (isEdgeRuntime()) return missHandler;
  // Read on every call: after `closeCache()` it is a new runtime, on a new connection.
  const currentRuntime = liveCacheRuntime(options);
  const memoryFallback = options.memoryFallback ?? true;
  const log = createDebugLog("[RemoteCache]:", options.debug);
  const pendingSets = createPendingSets();
  const keyOf = (cacheKey: string) =>
    dataKey(currentRuntime().keyPrefix, options.buildId ?? getBuildId(), cacheKey);

  function fromMemory(runtime: CacheRuntime, cacheKey: string) {
    const found = runtime.stores.dataFallback.get(cacheKey) as InMemoryEntry | undefined;
    return found ? toDataCacheEntry(found.stored, runtime.tags, found.until) : undefined;
  }

  return {
    async get(cacheKey, softTags) {
      await pendingSets.wait(cacheKey);
      const runtime = currentRuntime();
      const { connection, tags, stores } = runtime;
      const inMemory = stores.data.get(cacheKey) as InMemoryEntry | undefined;

      if (!connection) {
        const entry = inMemory
          ? toDataCacheEntry(inMemory.stored, tags, inMemory.until)
          : undefined;
        log?.("get", cacheKey, entry ? "memory hit" : "miss", inMemory && sizes(inMemory.stored));
        return entry;
      }

      if (!(await isRedisReady(runtime))) {
        log?.("get", cacheKey, "Redis down");
        if (inMemory) return toDataCacheEntry(inMemory.stored, tags, inMemory.until);
        return memoryFallback ? fromMemory(runtime, cacheKey) : undefined;
      }

      // The entry's tag records (and the soft tags', for `getExpiration`) come from Redis with the
      // entry, so a failed or skipped `refreshTags` never serves an invalidated entry.
      try {
        const key = keyOf(cacheKey);
        let encodedBytes = 0;
        const stored = await readWithTags(runtime, key, inMemory?.stored, softTags, async () => {
          const raw = await connection.client.getBuffer(key);
          encodedBytes = raw?.byteLength ?? 0;
          const found = await decodeStored<StoredDataEntry>(raw);
          return found && found.value instanceof Uint8Array ? found : undefined;
        });
        if (!stored) {
          log?.("get", cacheKey, "miss");
          return undefined;
        }
        const until = inMemory ? inMemory.until : stored.timestamp + stored.expire * 1000;
        const entry = toDataCacheEntry(stored, tags, until);
        log?.("get", cacheKey, entry ? "hit" : "invalidated", {
          bytes: stored.value.byteLength,
          encodedBytes: encodedBytes || encodeEntry(stored).byteLength,
        });
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
        const runtime = currentRuntime();
        const { connection, stores } = runtime;
        const ttl = storedEntryTTL(stored, options.defaultTTL);
        // Already expired (e.g. `expire: 0`); Redis rejects `EX 0`.
        if (ttl <= 0) return;
        const now = nowMs();

        if (!connection || stored.tags.includes(MEMORY_ONLY_TAG)) {
          stores.data.set(
            cacheKey,
            { stored, until: now + ttl * 1000 },
            stored.value.byteLength,
            now + ttl * 1000,
          );
          log?.("set", cacheKey, "memory", { ttl, bytes: stored.value.byteLength });
          return;
        }

        if (await isRedisReady(runtime)) {
          try {
            const key = keyOf(cacheKey);
            const encoded = await encodeStored(stored);
            await connection.client.set(key, encoded, "EX", ttl);
            stores.entryTags.set(key, stored.tags, stored.tags.length, null);
            log?.("set", cacheKey, "redis", {
              ttl,
              bytes: stored.value.byteLength,
              encodedBytes: encoded.byteLength,
            });
            return;
          } catch (error) {
            runtime.reportError("set", error);
          }
        }

        if (!memoryFallback) return;
        const until = now + Math.min(ttl, FALLBACK_TTL_SECONDS) * 1000;
        stores.dataFallback.set(cacheKey, { stored, until }, stored.value.byteLength, until);
        log?.("set", cacheKey, "fallback memory", { bytes: stored.value.byteLength });
      });
    },

    async refreshTags() {
      await currentRuntime().tags.sync(REFRESH_TAGS_INTERVAL_MS);
    },

    async getExpiration(tagList) {
      // Next compares it with an entry's `timestamp`, on its own clock.
      const expiration = currentRuntime().tags.getExpiration(tagList);
      return expiration > 0 ? toNextClock(expiration) : expiration;
    },

    async updateTags(tagList, durations) {
      log?.("updateTags", tagList, durations);
      await currentRuntime().tags.update(tagList, durations);
    },
  };
}
