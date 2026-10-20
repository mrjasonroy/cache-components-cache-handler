/**
 * Delete this app's cache entries.
 */

import { getBuildId } from "./build-id.js";
import { FLUSH_TAG, buildFlushTag } from "./keys.js";
import { loggerSource, writeLog } from "./logger.js";
import { clearAllMemoryStores } from "./memory-store.js";
import {
  type CacheOptions,
  type CacheRuntime,
  acquireCacheRuntime,
  isRedisReady,
} from "./runtime.js";
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
  /**
   * Set when some matching keys could not be deleted: on a Cluster, a key whose slot was
   * migrating and still failed after following the `-MOVED` / `-ASK` redirection. Run it again.
   */
  partial?: true;
  /** How many matching keys could not be deleted; set with `partial`. */
  failed?: number;
}

/**
 * Delete this app's cache entries with SCAN + UNLINK (every master of a Cluster is scanned), and
 * empty this process's memory stores. Without Redis configured it only empties the memory stores
 * and returns how many entries they held. Either way it then records the flush as a tag
 * revalidation that every prerendered page of the flushed builds carries, so their build output,
 * which is older, is not served again: every page renders afresh. A flush does not forget the
 * tag records a running process holds; they are older than the flush and change nothing. Throws, deleting nothing, if Redis is configured but
 * unavailable, or for `scope: "all"` with an empty `keyPrefix`. On a Cluster, a key caught in a slot
 * migration is retried through the Cluster client; any that still fail are reported with
 * `partial: true` and `failed`, and a warning is logged, instead of failing the whole flush.
 *
 * Put it behind your own authenticated route; the package ships no HTTP endpoint. It uses the
 * handlers' Redis connection when they have opened it, and otherwise one of its own that it closes
 * before returning, so a script or test that calls it exits on its own.
 *
 * @example
 * ```ts
 * import { flushCache } from "@mrjasonroy/cache-components-cache-handler";
 * await flushCache();                  // this build
 * await flushCache({ scope: "all" });  // everything under CACHE_KEY_PREFIX
 * ```
 */
export async function flushCache(options: FlushCacheOptions = {}): Promise<FlushCacheResult> {
  const { runtime, shared, release } = acquireCacheRuntime(options);
  try {
    return await flush(runtime, shared, options);
  } finally {
    await release();
  }
}

async function flush(
  runtime: CacheRuntime,
  shared: boolean,
  options: FlushCacheOptions,
): Promise<FlushCacheResult> {
  const connection = runtime.connection;
  const barrier =
    options.scope === "all" ? FLUSH_TAG : buildFlushTag(options.buildId ?? getBuildId());
  if (!connection) {
    const deleted = clearAllMemoryStores();
    await runtime.tags.update([barrier]);
    return { deleted };
  }

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
  const { deleted, failed } = await unlinkMatching(connection.client, pattern);
  // Only once Redis is flushed: a failed flush leaves this process as consistent as Redis.
  clearAllMemoryStores();
  // After the UNLINK, which deletes the tag records with `scope: "all"`. A write Redis does not
  // take is sent again with the next update or sync, like any revalidation; but a connection of
  // the flush's own is closed on return, so there the write must have reached Redis.
  await runtime.tags.update([barrier]);
  if (!shared && runtime.tags.hasUnsent()) {
    throw new Error(
      `flushCache: deleted ${deleted} key(s) but could not record the flush in Redis, so build output may be served again; run it again`,
    );
  }
  if (failed === 0) return { deleted };
  writeLog(
    loggerSource(options.logger),
    "warn",
    `flushCache: partial flush, ${failed} key(s) matching ${pattern} could not be deleted during a Cluster slot migration; run it again`,
    { deleted, failed },
    [
      `flushCache: partial flush, ${failed} key(s) matching ${pattern} could not be deleted during a Cluster slot migration; run it again`,
    ],
  );
  return { deleted, partial: true, failed };
}
