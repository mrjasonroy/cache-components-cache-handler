/**
 * Delete this app's cache entries.
 */

import { getBuildId } from "./build-id.js";
import { clearAllMemoryStores } from "./memory-store.js";
import { type CacheOptions, getCacheRuntime, isRedisReady } from "./runtime.js";
import { escapeGlob, unlinkMatching } from "./scan.js";

/**
 * Options of {@link flushCache}.
 */
export interface FlushCacheOptions extends CacheOptions {
  /**
   * `"build"` deletes the current build's entries (`<prefix><buildId>:*`); `"all"` deletes every
   * key under the prefix, tag records included.
   * @default "build"
   */
  scope?: "build" | "all";

  /**
   * The build whose entries `scope: "build"` deletes.
   * @default the app's BUILD_ID
   */
  buildId?: string;
}

/**
 * Result of {@link flushCache}.
 */
export interface FlushCacheResult {
  /** Redis keys deleted; without Redis, in-process entries dropped. */
  deleted: number;
}

/**
 * Delete this app's cache entries with SCAN + UNLINK (every master of a Cluster is scanned), and
 * empty this process's memory stores. Without Redis configured it only empties the memory stores
 * and returns how many entries they held. Throws, deleting nothing, if Redis is configured but
 * unavailable, or for `scope: "all"` with an empty `keyPrefix`.
 *
 * Put it behind your own authenticated route; the package ships no HTTP endpoint.
 *
 * @example
 * ```ts
 * import { flushCache } from "@mrjasonroy/cache-components-cache-handler";
 * await flushCache();                  // this build
 * await flushCache({ scope: "all" });  // everything under CACHE_KEY_PREFIX
 * ```
 */
export async function flushCache(options: FlushCacheOptions = {}): Promise<FlushCacheResult> {
  const runtime = getCacheRuntime(options);
  const connection = runtime.connection;
  if (!connection) return { deleted: clearAllMemoryStores() };

  if (options.scope === "all" && runtime.keyPrefix === "") {
    throw new Error(
      'flushCache: refusing scope "all" with an empty keyPrefix, which would delete every key in the database',
    );
  }
  if (!(await isRedisReady(runtime))) {
    throw new Error("flushCache: Redis is unavailable, nothing was deleted");
  }

  const prefix = escapeGlob(runtime.keyPrefix);
  const pattern =
    options.scope === "all"
      ? `${prefix}*`
      : `${prefix}${escapeGlob(options.buildId ?? getBuildId())}:*`;
  const deleted = await unlinkMatching(connection.client, pattern);
  // Only once Redis is flushed: a failed flush leaves this process as consistent as Redis.
  clearAllMemoryStores();
  return { deleted };
}
