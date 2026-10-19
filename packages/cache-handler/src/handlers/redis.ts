/**
 * The page handler: Next 16's singular `cacheHandler`, shared across instances through Redis.
 *
 * With Cache Components on, Next still writes every page shell (`APP_PAGE`), route handler
 * response (`APP_ROUTE`) and explicitly cached `fetch` (`FETCH`) through the singular
 * `cacheHandler`. The contract it implements is described in `./page-types.ts`.
 *
 * - Entries live under `<prefix><buildId>:page:<key>` in the binary v2 format, for
 *   `1.5 × revalidate` capped at `expire` (`expire`, or `defaultTTL`, without a revalidate period;
 *   never more than the tag TTL).
 * - Tags (the `x-next-cache-tags` header, `fetch` tags and soft tags) are checked against Redis on
 *   every `get`, in the same round trip as the entry (see {@link RedisCacheHandler.get}), so a
 *   revalidation on any instance is seen by the next read. Next reads this handler before it
 *   calls any `refreshTags`. While Redis is down, the process's tag store is used: it holds every
 *   record a `get` has read, and the `"use cache"` handlers' `refreshTags` syncs it from the tag index.
 * - A tag revalidated with `durations` (`revalidateTag(tag, "max")`) leaves the entry servable
 *   until `expire`: it is returned with a `lastModified` far enough back that Next serves it and
 *   regenerates it in the background. Without durations the entry is a miss.
 * - Entries tagged {@link MEMORY_ONLY_TAG} stay in process memory.
 * - While Redis is down, entries go to process memory for at most 60 s, never read and dropped
 *   once Redis is back. Without Redis (no URL, `next build`, `CACHE_REDIS=off`) everything is in
 *   memory.
 * - A request never fails because of the cache: an error is a miss plus a rate-limited log line.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { markPageHandlerCreated } from "../data-cache/isr-warning.js";
import { getBuildId, registerServerDistDir } from "../shared/build-id.js";
import { decodeEntry, encodeEntry } from "../shared/codec.js";
import { TAG_TTL_SECONDS, pageKey } from "../shared/keys.js";
import {
  type CacheOptions,
  type CacheRuntime,
  FALLBACK_TTL_SECONDS,
  MEMORY_ONLY_TAG,
  type RuntimeOptions,
  createDebugLog,
  getCacheRuntime,
  isRedisReady,
} from "../shared/runtime.js";
import type {
  PageCacheControl,
  PageCacheGetContext,
  PageCacheHandlerContext,
  PageCacheHandlerValue,
  PageCacheSetContext,
  PageCacheValue,
} from "./page-types.js";

/**
 * `NEXT_CACHE_TAGS_HEADER` in next/dist/lib/constants.
 */
const NEXT_CACHE_TAGS_HEADER = "x-next-cache-tags";

/**
 * Entries are kept this many times their revalidate period, capped at `expire`.
 */
export const EXPIRE_FACTOR = 1.5;

/**
 * Options of {@link RedisCacheHandler}: Next's constructor context plus the code-level options.
 */
export interface RedisCacheHandlerOptions extends PageCacheHandlerContext, CacheOptions {
  /**
   * 16.5 form of `client` / `url`: an ioredis client, a URL, or an ioredis options object.
   */
  redis?: Redis | Cluster | string | RedisOptions;

  /**
   * @deprecated Tag records now live under `<keyPrefix>tag:` and are shared by every handler;
   * this option is ignored.
   */
  tagPrefix?: string;

  /**
   * Lifetime in seconds of an entry without a revalidate period or `expire` (capped at 366 days).
   * @default 31622400 (366 days)
   */
  defaultTTL?: number;

  /**
   * The build ID that scopes entry keys.
   * @default the app's BUILD_ID, read from `serverDistDir` or the environment on first use
   */
  buildId?: string;
}

interface StoredPageEntry {
  value: PageCacheValue;
  tags: string[];
  lastModified: number;
  cacheControl?: PageCacheControl;
}

interface InMemoryPage {
  entry: StoredPageEntry;
}

function isRedisClient(value: unknown): value is Redis | Cluster {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Redis).get === "function" &&
    typeof (value as Redis).set === "function" &&
    typeof (value as Redis).on === "function"
  );
}

/**
 * Map the constructor options (16.6 and 16.5 forms) to runtime options.
 */
function toRuntimeOptions(options: RedisCacheHandlerOptions): RuntimeOptions {
  const { redis } = options;
  return {
    url: options.url ?? (typeof redis === "string" ? redis : undefined),
    client: options.client ?? (isRedisClient(redis) ? redis : undefined),
    redisOptions: redis && typeof redis === "object" && !isRedisClient(redis) ? redis : undefined,
    keyPrefix: options.keyPrefix,
    memoryFallback: options.memoryFallback,
    commandTimeout: options.commandTimeout,
    debug: options.debug,
  };
}

/**
 * Tags of an entry: `ctx.tags` for `fetch` entries (and 16.5 callers), the `x-next-cache-tags`
 * header for pages and route handlers.
 */
export function getEntryTags(data: PageCacheValue, ctx?: PageCacheSetContext): string[] {
  if (ctx?.tags) return ctx.tags;
  if (data.kind !== "APP_PAGE" && data.kind !== "APP_ROUTE") return [];
  const header = data.headers?.[NEXT_CACHE_TAGS_HEADER];
  const value = Array.isArray(header) ? header.join(",") : header;
  return value ? String(value).split(",").filter(Boolean) : [];
}

/**
 * The entry's revalidate period: `data.revalidate` for `fetch` entries, else
 * `ctx.cacheControl.revalidate` (or the 16.5 `ctx.revalidate`).
 */
function getRevalidate(
  data: PageCacheValue,
  ctx?: PageCacheSetContext,
): number | false | undefined {
  if (data.kind === "FETCH") return data.revalidate;
  return ctx?.cacheControl?.revalidate ?? ctx?.revalidate;
}

/**
 * Seconds the stored entry is kept: `1.5 × revalidate` capped at `expire`; `expire` without a
 * revalidate period; `fallback` with neither. Never more than the tag TTL.
 */
export function getEntryLifetime(
  data: PageCacheValue,
  ctx: PageCacheSetContext | undefined,
  fallback: number = TAG_TTL_SECONDS,
): number {
  const expire = ctx?.cacheControl?.expire;
  const revalidate = getRevalidate(data, ctx);
  let lifetime: number;
  if (typeof revalidate === "number") {
    lifetime = Math.ceil(revalidate * EXPIRE_FACTOR);
    if (typeof expire === "number") lifetime = Math.min(lifetime, Math.ceil(expire));
  } else if (typeof expire === "number") {
    lifetime = Math.ceil(expire);
  } else {
    lifetime = fallback;
  }
  return Math.min(lifetime, TAG_TTL_SECONDS);
}

/**
 * How far past the revalidate period a stale entry's `lastModified` is moved, in ms, so Next sees
 * it as stale despite clock rounding.
 */
const STALE_MARGIN_MS = 1000;

/**
 * Next's clock for entry ages (next/dist/server/lib/incremental-cache/index.js):
 * `performance.timeOrigin + performance.now()`, which can drift from `Date.now()`.
 */
function nextClock(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * The period after which Next treats this entry as stale, or `undefined` if it has none. For a
 * `fetch`, Next uses `ctx.revalidate || value.revalidate`; the larger of the two covers both.
 */
function staleAfterSeconds(
  entry: StoredPageEntry,
  ctx: PageCacheGetContext | undefined,
): number | undefined {
  const periods =
    entry.value.kind === "FETCH"
      ? [ctx?.revalidate, entry.value.revalidate]
      : [entry.cacheControl?.revalidate];
  const valid = periods.filter(
    (period): period is number => typeof period === "number" && period > 0,
  );
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

/**
 * Redis-backed page handler for Next 16's singular `cacheHandler`. `withCache` points
 * `cacheHandler` at a module whose default export is this class.
 *
 * The constructor keeps its 16.5 shape, so existing subclasses work:
 * `new RedisCacheHandler({ ...ctx, redis, keyPrefix, tagPrefix, defaultTTL, debug })`.
 * Without options it reads the environment (`REDIS_URL`, `CACHE_KEY_PREFIX`, ...).
 *
 * @example
 * ```js
 * // cache/page.mjs — a custom handler file for withCache({ handlers: { page } })
 * import { createRedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
 * import { client } from "./redis.mjs";
 * export default createRedisCacheHandler({ client });
 * ```
 */
export class RedisCacheHandler {
  public readonly name = "redis";

  protected readonly runtime: CacheRuntime;
  private readonly options: RedisCacheHandlerOptions;
  private readonly memoryFallback: boolean;
  private readonly log: ((...args: unknown[]) => void) | undefined;

  constructor(options: RedisCacheHandlerOptions = {}) {
    registerServerDistDir(options.serverDistDir);
    markPageHandlerCreated();
    this.options = options;
    this.runtime = getCacheRuntime(toRuntimeOptions(options));
    this.memoryFallback = options.memoryFallback ?? true;
    this.log = createDebugLog("[PageCache]:", options.debug);
  }

  private redisKey(cacheKey: string): string {
    return pageKey(this.runtime.keyPrefix, this.options.buildId ?? getBuildId(), cacheKey);
  }

  /**
   * Read an entry. While Redis is ready, the records of every tag that applies are read from Redis
   * with the entry, so a revalidation on any instance is seen by the very next `get`:
   *
   * 1. The entry and the records of the soft tags (the implicit `_N_T_` path tags), the fetch
   *    tags and the entry's tags as last seen by this process, all sent at once (one round trip).
   * 2. Only on a hit whose tags were not all read: the remaining tag records (a second round
   *    trip, the first time a process reads that entry).
   *
   * Without Redis, or while it is down, tags are checked against local state only.
   */
  async get(cacheKey: string, ctx?: PageCacheGetContext): Promise<PageCacheHandlerValue | null> {
    const { connection, stores } = this.runtime;
    const softTags = ctx?.softTags ?? ctx?.implicitTags ?? [];
    const fetchTags = ctx?.kind === "FETCH" ? (ctx.tags ?? []) : [];

    let entry = (stores.page.get(cacheKey) as InMemoryPage | undefined)?.entry;
    if (connection) {
      if (await isRedisReady(this.runtime)) {
        try {
          entry = await this.readWithTags(cacheKey, entry, [...softTags, ...fetchTags]);
        } catch (error) {
          this.runtime.reportError("get", error);
          return null;
        }
      } else if (!entry && this.memoryFallback) {
        entry = (stores.pageFallback.get(cacheKey) as InMemoryPage | undefined)?.entry;
      }
    }
    if (!entry?.value) {
      this.log?.("get", cacheKey, "miss");
      return null;
    }

    const result = this.toResult(entry, [...entry.tags, ...softTags, ...fetchTags], ctx);
    this.log?.("get", cacheKey, result ? "hit" : "invalidated");
    return result;
  }

  /**
   * Read the entry from Redis (unless it is held in memory) together with the tag records that
   * apply to it, merging them into the tag store.
   */
  private async readWithTags(
    cacheKey: string,
    inMemory: StoredPageEntry | undefined,
    requestTags: string[],
  ): Promise<StoredPageEntry | undefined> {
    const { connection, stores, tags } = this.runtime;
    if (!connection) return inMemory;
    const key = this.redisKey(cacheKey);
    const known = inMemory?.tags ?? stores.pageTags.get(key) ?? [];
    const fetched = new Set([...requestTags, ...known]);

    let entry = inMemory;
    if (inMemory) {
      await tags.fetch(fetched);
    } else {
      const [raw] = await Promise.all([connection.client.getBuffer(key), tags.fetch(fetched)]);
      entry = decodeEntry<StoredPageEntry>(raw);
    }
    if (!entry?.value) return undefined;

    const missing = entry.tags.filter((tag) => !fetched.has(tag));
    if (missing.length > 0) await tags.fetch(missing);
    if (!inMemory) stores.pageTags.set(key, entry.tags, entry.tags.length, null);
    return entry;
  }

  private toResult(
    entry: StoredPageEntry,
    allTags: string[],
    ctx: PageCacheGetContext | undefined,
  ): PageCacheHandlerValue | null {
    const state = this.runtime.tags.check(allTags, entry.lastModified, Date.now());
    if (state === "expired") return null;

    let lastModified = entry.lastModified;
    if (state === "stale") {
      // Served once more and regenerated in the background: Next treats an entry as stale once
      // `lastModified + revalidate` has passed on its own clock. Without a revalidate period it
      // cannot be marked stale, so it is a miss.
      const revalidate = staleAfterSeconds(entry, ctx);
      if (revalidate === undefined) return null;
      lastModified = Math.min(
        lastModified,
        Math.floor(nextClock() - revalidate * 1000 - STALE_MARGIN_MS),
      );
    }

    return entry.cacheControl
      ? { value: entry.value, lastModified, cacheControl: entry.cacheControl }
      : { value: entry.value, lastModified };
  }

  /**
   * Store an entry. `null` data is ignored.
   */
  async set(
    cacheKey: string,
    data: PageCacheValue | null,
    ctx?: PageCacheSetContext,
  ): Promise<void> {
    if (!data) return;
    const { connection, stores } = this.runtime;
    const tags = getEntryTags(data, ctx);
    const lifetime = getEntryLifetime(data, ctx, this.options.defaultTTL);
    // Already expired; Redis rejects `EX 0`.
    if (lifetime <= 0) return;

    const entry: StoredPageEntry = { value: data, tags, lastModified: Date.now() };
    // Next reads a page's periods back from `get`, so an instance that did not render the page
    // revalidates it on the page's own schedule.
    if (!ctx?.fetchCache && ctx?.cacheControl) entry.cacheControl = ctx.cacheControl;

    if (!connection || tags.includes(MEMORY_ONLY_TAG)) {
      stores.page.set(
        cacheKey,
        { entry },
        encodeEntry(entry).byteLength,
        entry.lastModified + lifetime * 1000,
      );
      this.log?.("set", cacheKey, "memory", { lifetime });
      return;
    }

    let encoded: Buffer | undefined;
    if (await isRedisReady(this.runtime)) {
      try {
        encoded = encodeEntry(entry);
        const key = this.redisKey(cacheKey);
        await connection.client.set(key, encoded, "EX", lifetime);
        stores.pageTags.set(key, tags, tags.length, null);
        this.log?.("set", cacheKey, "redis", { tags, lifetime });
        return;
      } catch (error) {
        this.runtime.reportError("set", error);
      }
    }

    if (!this.memoryFallback) return;
    const size = (encoded ?? encodeEntry(entry)).byteLength;
    const until = entry.lastModified + Math.min(lifetime, FALLBACK_TTL_SECONDS) * 1000;
    stores.pageFallback.set(cacheKey, { entry }, size, until);
    this.log?.("set", cacheKey, "fallback memory");
  }

  /**
   * Invalidate `tags` in every handler of this process and, through Redis, every instance.
   * `durations` (`{ expire }`) keeps entries servable, stale, until `expire` seconds have passed.
   */
  async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number } | string,
  ): Promise<void> {
    const list = Array.isArray(tags) ? tags : [tags];
    // A profile name (16.5 callers) cannot be resolved here; treat it as an immediate expiry.
    const resolved = typeof durations === "object" ? durations : undefined;
    this.log?.("revalidateTag", list, resolved);
    await this.runtime.tags.update(list, resolved);
  }

  /**
   * Called by Next at the start of each request. Nothing is cached per request.
   */
  resetRequestCache(): void {}

  /**
   * Delete one entry.
   */
  async delete(cacheKey: string): Promise<void> {
    const { connection, stores } = this.runtime;
    stores.page.delete(cacheKey);
    stores.pageFallback.delete(cacheKey);
    if (!connection || !connection.isReady()) return;
    try {
      await connection.client.del(this.redisKey(cacheKey));
    } catch (error) {
      this.runtime.reportError("delete", error);
    }
  }

  /**
   * Close the connection if this package opened it. The connection is shared by every handler in
   * the process; call this only at shutdown. A client you passed in is never closed.
   */
  async close(): Promise<void> {
    await this.runtime.connection?.close();
  }
}

/**
 * Create a page handler class with code-level options, for a custom `cacheHandler` file.
 *
 * @example
 * ```js
 * // cache/page.mjs
 * import { createRedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
 * import { client } from "./redis.mjs";
 * export default createRedisCacheHandler({ client });
 * ```
 */
export function createRedisCacheHandler(
  options: RedisCacheHandlerOptions = {},
): typeof RedisCacheHandler {
  return class ConfiguredRedisCacheHandler extends RedisCacheHandler {
    constructor(ctx: RedisCacheHandlerOptions = {}) {
      super({ ...ctx, ...options });
    }
  };
}
