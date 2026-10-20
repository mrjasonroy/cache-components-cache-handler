/**
 * Redis outage behaviour for the "use cache" handlers.
 *
 * While the connection is not ready, reads and writes go to a separate process-memory handler,
 * so a render never waits on or fails because of the shared cache. That memory:
 * - holds an entry at most `fallbackTTL` seconds, so it cannot outlast an outage by much or
 *   miss many revalidations made in Redis meanwhile;
 * - is never read once Redis is ready again, and is replaced by an empty one on every
 *   reconnect, so an entry written during the outage cannot shadow Redis.
 *
 * The first calls in a process wait, briefly, for the first connection (see
 * `RedisConnection.waitForInitialConnection`), so a new process uses Redis from its first
 * request instead of starting from memory.
 *
 * A tag revalidation made while Redis is down reaches memory only and logs a warning: entries in
 * Redis it should have invalidated stay until their TTL or the next revalidation of that tag.
 */

import { nowMs } from "../shared/clock.js";
import type { RedisConnection } from "../shared/connection.js";
import { createErrorReporter } from "./error-reporter.js";
import { createMemoryDataCacheHandler } from "./memory.js";
import type { DataCacheHandler } from "./types.js";

/**
 * Default lifetime of an entry written while Redis is down, in seconds.
 */
export const DEFAULT_FALLBACK_TTL = 60;

export interface FallbackDataCacheHandlerOptions {
  /**
   * The Redis-backed handler used while the connection is ready.
   */
  redis: DataCacheHandler;

  /**
   * The connection `redis` runs on.
   */
  connection: Pick<RedisConnection, "isReady" | "waitForInitialConnection" | "onReady">;

  /**
   * Serve and store entries in process memory while Redis is down. With `false`, every call made
   * during an outage is a miss and writes are dropped.
   * @default true
   */
  memoryFallback?: boolean;

  /**
   * Longest time an entry written during an outage is served, in seconds.
   * @default 60
   */
  fallbackTTL?: number;

  /**
   * Size limit of the outage memory, in bytes.
   * @default 50MB
   */
  fallbackMaxSize?: number;

  /**
   * Minimum time in ms between two warnings about tag updates that reached memory only.
   * @default 60000
   */
  errorLogIntervalMs?: number;
}

/**
 * A handler that stores nothing: every read is a miss. Also what the data handlers are on the edge
 * runtime.
 */
export const missHandler: DataCacheHandler = {
  async get() {
    return undefined;
  },
  async set(_cacheKey, pendingEntry) {
    // Nothing is stored; release the entry's stream instead of leaving it unread.
    const entry = await pendingEntry.catch(() => undefined);
    await entry?.value.cancel().catch(() => undefined);
  },
  async refreshTags() {},
  async getExpiration() {
    return 0;
  },
  async updateTags() {},
};

interface OutageMemory {
  handler: DataCacheHandler;
  /** Write time per key, oldest first (a rewrite moves the key to the end). */
  writtenAt: Map<string, number>;
}

/**
 * Most keys tracked during one outage; the oldest go first beyond it.
 */
const MAX_OUTAGE_KEYS = 100_000;

const OUTAGE_MEMORY = new WeakMap<DataCacheHandler, () => OutageMemory>();

/**
 * Keys tracked by a fallback handler's current outage memory. Test-only.
 * @internal
 */
export function outageKeyCountForTests(handler: DataCacheHandler): number {
  return OUTAGE_MEMORY.get(handler)?.().writtenAt.size ?? 0;
}

/**
 * Record a write and forget keys whose entries can no longer be served, oldest first.
 */
function recordWrite(writtenAt: Map<string, number>, cacheKey: string, now: number, ttlMs: number) {
  writtenAt.delete(cacheKey);
  writtenAt.set(cacheKey, now);
  for (const [key, at] of writtenAt) {
    if (now - at < ttlMs && writtenAt.size <= MAX_OUTAGE_KEYS) break;
    writtenAt.delete(key);
  }
}

/**
 * Wrap a Redis data cache handler so it falls back to bounded process memory while Redis is down.
 */
export function createFallbackDataCacheHandler(
  options: FallbackDataCacheHandlerOptions,
): DataCacheHandler {
  const {
    redis,
    connection,
    memoryFallback = true,
    fallbackTTL = DEFAULT_FALLBACK_TTL,
    fallbackMaxSize,
  } = options;
  const warn = createErrorReporter("[RedisDataCache]:", options.errorLogIntervalMs);

  const newMemory = (): OutageMemory => ({
    handler: memoryFallback
      ? createMemoryDataCacheHandler(
          fallbackMaxSize === undefined ? {} : { maxSize: fallbackMaxSize },
        )
      : missHandler,
    writtenAt: new Map(),
  });

  let memory = newMemory();
  // Entries written during the outage are never read again; drop them to free the memory.
  connection.onReady(() => {
    memory = newMemory();
  });

  /**
   * Redis when the connection is ready, else `undefined`.
   */
  async function current(): Promise<DataCacheHandler | undefined> {
    await connection.waitForInitialConnection();
    return connection.isReady() ? redis : undefined;
  }

  const fallback: DataCacheHandler = {
    async get(cacheKey, softTags) {
      const handler = await current();
      if (handler) return handler.get(cacheKey, softTags);

      const outage = memory;
      const writtenAt = outage.writtenAt.get(cacheKey);
      if (writtenAt === undefined || nowMs() - writtenAt >= fallbackTTL * 1000) {
        outage.writtenAt.delete(cacheKey);
        return undefined;
      }
      return outage.handler.get(cacheKey, softTags);
    },

    async set(cacheKey, pendingEntry) {
      const handler = await current();
      if (handler) return handler.set(cacheKey, pendingEntry);

      const outage = memory;
      recordWrite(outage.writtenAt, cacheKey, nowMs(), fallbackTTL * 1000);
      return outage.handler.set(cacheKey, pendingEntry);
    },

    async refreshTags() {
      const handler = await current();
      await (handler ?? memory.handler).refreshTags();
    },

    async getExpiration(tags) {
      const handler = await current();
      return (handler ?? memory.handler).getExpiration(tags);
    },

    async updateTags(tags, durations) {
      await memory.handler.updateTags(tags, durations);
      const handler = await current();
      if (handler) {
        await handler.updateTags(tags, durations);
        return;
      }
      warn(
        "updateTags",
        new Error(
          `Redis unavailable, revalidation of [${tags.join(", ")}] reached this process's memory only`,
        ),
      );
    },
  };
  OUTAGE_MEMORY.set(fallback, () => memory);
  return fallback;
}
