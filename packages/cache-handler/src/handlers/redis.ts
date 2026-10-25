/**
 * The page handler: Next 16's singular `cacheHandler`, shared across instances through Redis.
 *
 * With Cache Components on, Next still writes every page shell (`APP_PAGE`), route handler
 * response (`APP_ROUTE`) and explicitly cached `fetch` (`FETCH`) through the singular
 * `cacheHandler`. The contract it implements is described in `./page-types.ts`.
 *
 * - Entries live under `<prefix><buildId>:page:<key>` in the binary v2 format, for
 *   `1.5 × revalidate` capped at `expire` (`expire`, or `defaultTTL`, without a revalidate period;
 *   never more than the longest entry age, 365 days, which reads enforce too).
 * - Tags (the `x-next-cache-tags` header, `fetch` tags and soft tags) are checked against Redis on
 *   every `get`, in the same round trip as the entry (see {@link RedisCacheHandler.get}), so a
 *   revalidation on any instance is seen by the next read. Next reads this handler before it
 *   calls any `refreshTags`. While Redis is down, the process's tag store is used: it holds every
 *   record a `get` has read, and the `"use cache"` handlers' `refreshTags` syncs it from the tag index.
 * - A tag revalidated with `durations` (`revalidateTag(tag, "max")`) leaves the entry servable
 *   until `expire`: it is returned with a `lastModified` far enough back that Next serves it and
 *   regenerates it in the background. Without durations the entry is a miss.
 * - A prerendered route (`APP_PAGE`, `APP_ROUTE`, `PAGES`) missing from the cache is read from
 *   the build output on disk, which `next build` writes only there, with `lastModified` the build
 *   time and the same tag check, so a revalidation since the build always wins; so does a flush
 *   (see `../shared/flush.ts`). A time-based route's build output is served only within
 *   `1.5 × revalidate` (capped at `expire`) of the build, as a render of it would be kept. It is
 *   then written to Redis unless another instance got there first. With Redis configured this
 *   happens only while the tag records could be read from Redis. The build time is the stamp this
 *   handler writes during `next build`; without it the build output is served only when none of
 *   its tags was ever revalidated, and never for a time-based route (see `./build-info.ts`).
 * - On the edge runtime (Next bundles this handler into the middleware) every read is a miss and
 *   writes and revalidations do nothing.
 * - Entries tagged {@link MEMORY_ONLY_TAG} stay in process memory.
 * - While Redis is down, entries go to process memory for at most 60 s, never read and dropped
 *   once Redis is back. Without Redis (no URL, `next build`, `CACHE_REDIS=off`) everything is in
 *   memory.
 * - A request never fails because of the cache: an error is a miss plus a rate-limited log line.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { markPageHandlerCreated } from "../data-cache/isr-warning.js";
import { getCacheScope, registerServerDistDir } from "../shared/build-id.js";
import { nowMs, toNextClock } from "../shared/clock.js";
import { decodeStored, encodeEntry, encodeStored, storedSizes } from "../shared/codec.js";
import { isBuildPhase, isEdgeRuntime } from "../shared/env.js";
import { FLUSH_TAG, MAX_ENTRY_AGE_SECONDS, buildFlushTag, pageKey } from "../shared/keys.js";
import { stringListBytes } from "../shared/memory-store.js";
import { readWithTags } from "../shared/read-with-tags.js";
import {
  type CacheOptions,
  type CacheRuntime,
  FALLBACK_TTL_SECONDS,
  MEMORY_ONLY_TAG,
  type RuntimeOptions,
  closeCache,
  createDebugLog,
  isRedisReady,
  liveCacheRuntime,
} from "../shared/runtime.js";
import { readBuildTime, readRoutePeriods, writeBuildStamp } from "./build-info.js";
import { readBuildOutput } from "./build-output.js";
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
   * 16.4.2 form of `client` / `url`: an ioredis client, a URL, or an ioredis options object.
   */
  redis?: Redis | Cluster | string | RedisOptions;

  /**
   * @deprecated Tag records now live in the `<keyPrefix>tags` hash and are shared by every handler;
   * this option is ignored.
   */
  tagPrefix?: string;

  /**
   * Lifetime in seconds of an entry without a revalidate period or `expire` (capped at 365 days,
   * rounded up to whole seconds). A finite number greater than 0; anything else throws.
   * @default 31536000 (365 days)
   */
  defaultTTL?: number;

  /**
   * The ID that scopes entry keys. Replaces the default when set.
   * @default the app's deployment ID when one is set, else its BUILD_ID, read from
   * `serverDistDir` or the environment on first use
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

interface BuildOutputEntry {
  entry: StoredPageEntry;
  /** Seconds it may still be kept. */
  lifetime: number;
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
 * Map the constructor options (16.4.3 and 16.4.2 forms) to runtime options.
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
    connectTimeout: options.connectTimeout,
    socketTimeout: options.socketTimeout,
    maxConsecutiveTimeouts: options.maxConsecutiveTimeouts,
    debug: options.debug,
    logger: options.logger,
  };
}

/**
 * Tags of an entry: `ctx.tags` for `fetch` entries (and 16.4.2 callers), the `x-next-cache-tags`
 * header for App Router pages, route handlers and Pages Router pages (the kinds Next's own
 * `FileSystemCache` checks header tags for).
 */
export function getEntryTags(data: PageCacheValue, ctx?: PageCacheSetContext): string[] {
  if (ctx?.tags) return ctx.tags;
  if (data.kind !== "APP_PAGE" && data.kind !== "APP_ROUTE" && data.kind !== "PAGES") return [];
  const header = data.headers?.[NEXT_CACHE_TAGS_HEADER];
  const value = Array.isArray(header) ? header.join(",") : header;
  return value ? String(value).split(",").filter(Boolean) : [];
}

/**
 * The entry's revalidate period: `data.revalidate` for `fetch` entries, else
 * `ctx.cacheControl.revalidate` (or the 16.4.2 `ctx.revalidate`).
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
 * revalidate period; `fallback` with neither. Never more than the longest entry age.
 */
export function getEntryLifetime(
  data: PageCacheValue,
  ctx: PageCacheSetContext | undefined,
  fallback: number = MAX_ENTRY_AGE_SECONDS,
): number {
  return lifetimeOf(getRevalidate(data, ctx), ctx?.cacheControl?.expire, fallback);
}

function lifetimeOf(
  revalidate: number | false | undefined,
  expire: number | undefined,
  fallback: number,
): number {
  let lifetime: number;
  if (typeof revalidate === "number") {
    lifetime = Math.ceil(revalidate * EXPIRE_FACTOR);
    if (typeof expire === "number") lifetime = Math.min(lifetime, Math.ceil(expire));
  } else if (typeof expire === "number") {
    lifetime = Math.ceil(expire);
  } else {
    // Whole seconds: Redis takes no other `EX`.
    lifetime = Math.ceil(fallback);
  }
  return Math.min(lifetime, MAX_ENTRY_AGE_SECONDS);
}

/**
 * How far past the revalidate period a stale entry's `lastModified` is moved, in ms, so Next sees
 * it as stale despite clock rounding.
 */
const STALE_MARGIN_MS = 1000;

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
 * The constructor keeps its 16.4.2 shape, so existing subclasses work:
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

  private readonly currentRuntime: () => CacheRuntime;
  private readonly options: RedisCacheHandlerOptions;
  private readonly memoryFallback: boolean;
  private readonly log: ((...args: unknown[]) => void) | undefined;
  private readonly edge = isEdgeRuntime();

  constructor(options: RedisCacheHandlerOptions = {}) {
    const { defaultTTL } = options;
    if (
      defaultTTL !== undefined &&
      (typeof defaultTTL !== "number" || !Number.isFinite(defaultTTL) || defaultTTL <= 0)
    ) {
      throw new Error(
        `RedisCacheHandler: defaultTTL must be a finite number of seconds greater than 0, got ${String(defaultTTL)}`,
      );
    }
    registerServerDistDir(options.serverDistDir);
    if (options.serverDistDir && isBuildPhase()) writeBuildStamp(options.serverDistDir);
    markPageHandlerCreated();
    this.options = options;
    this.currentRuntime = liveCacheRuntime(toRuntimeOptions(options));
    this.memoryFallback = options.memoryFallback ?? true;
    this.log = createDebugLog("[PageCache]:", options.debug, options.logger);
  }

  /** The shared runtime; a new one, on a new connection, after `closeCache()`. */
  protected get runtime(): CacheRuntime {
    return this.currentRuntime();
  }

  private redisKey(cacheKey: string): string {
    return pageKey(this.runtime.keyPrefix, this.options.buildId ?? getCacheScope(), cacheKey);
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
    if (this.edge) return null;
    const { connection, stores } = this.runtime;
    const softTags = ctx?.softTags ?? ctx?.implicitTags ?? [];
    const fetchTags = ctx?.kind === "FETCH" ? (ctx.tags ?? []) : [];

    let entry = (stores.page.get(cacheKey) as InMemoryPage | undefined)?.entry;
    // Whether the tag records that apply are current: always without Redis, and with Redis only
    // once they have been read from it.
    let tagsCurrent = !connection;
    if (connection) {
      if (await isRedisReady(this.runtime)) {
        try {
          entry = await this.readWithTags(cacheKey, entry, [...softTags, ...fetchTags]);
          tagsCurrent = true;
        } catch (error) {
          this.runtime.reportError("get", error);
          return null;
        }
      } else if (!entry && this.memoryFallback) {
        entry = (stores.pageFallback.get(cacheKey) as InMemoryPage | undefined)?.entry;
      }
    }
    let built: BuildOutputEntry | undefined;
    if (!entry?.value && tagsCurrent) {
      built = await this.readBuildOutput(cacheKey, ctx, softTags);
      entry = built?.entry;
    }
    if (!entry?.value) {
      this.log?.("get", cacheKey, "miss");
      return null;
    }

    const result = this.toResult(entry, [...entry.tags, ...softTags, ...fetchTags], ctx);
    // Arguments of an optional call are only evaluated with debug logging on.
    this.log?.("get", cacheKey, result ? (built ? "build output" : "hit") : "invalidated", {
      bytes: encodeEntry(entry).byteLength,
    });
    if (result && built) await this.keepBuildOutput(cacheKey, built);
    return result;
  }

  /**
   * Read the entry from Redis (unless it is held in memory) together with the tag records that
   * apply to it, merging them into the tag store.
   */
  private readWithTags(
    cacheKey: string,
    inMemory: StoredPageEntry | undefined,
    requestTags: string[],
  ): Promise<StoredPageEntry | undefined> {
    const { connection } = this.runtime;
    if (!connection) return Promise.resolve(inMemory);
    const key = this.redisKey(cacheKey);
    return readWithTags(this.runtime, key, inMemory, requestTags, async () => {
      const entry = await decodeStored<StoredPageEntry>(await connection.client.getBuffer(key));
      return entry?.value ? entry : undefined;
    });
  }

  /**
   * The prerendered build output of `cacheKey`, if it has one and its route's window is open, with
   * the records of its tags and of the flush barriers read from Redis (one HMGET). `lastModified`
   * is the build time, so the tag check that follows rejects it once any of its tags was
   * revalidated, or the cache flushed, after the build. The barriers are kept in the entry's tags,
   * so a copy written to Redis carries them too.
   *
   * Without a build stamp the age of the output is unknown: it is a miss if any of its tags or
   * barriers has a record at all, or if its route is time-based; otherwise its `lastModified` is
   * now.
   */
  private async readBuildOutput(
    cacheKey: string,
    ctx: PageCacheGetContext | undefined,
    softTags: string[],
  ): Promise<BuildOutputEntry | undefined> {
    const { serverDistDir } = this.options;
    if (!serverDistDir) return undefined;
    const periods = readRoutePeriods(serverDistDir, cacheKey);
    if (!periods) {
      this.log?.("get", cacheKey, "no build output (route not in the prerender manifest)");
      return undefined;
    }
    const buildTime = readBuildTime(serverDistDir);
    let until: number | undefined;
    if (periods.revalidate !== false) {
      if (buildTime === undefined) {
        this.log?.("get", cacheKey, "no build output (time-based route, no build stamp)");
        return undefined;
      }
      until = buildTime + lifetimeOf(periods.revalidate, periods.expire, 0) * 1000;
      if (nowMs() >= until) {
        this.log?.("get", cacheKey, "no build output (past its window)", { buildTime, until });
        return undefined;
      }
    }

    const found = await readBuildOutput(this.options, cacheKey, ctx, (error) =>
      this.runtime.reportError("build output", error),
    );
    if (!found) return undefined;
    const tags = [
      ...getEntryTags(found.value),
      FLUSH_TAG,
      buildFlushTag(this.options.buildId ?? getCacheScope()),
    ];
    try {
      await this.runtime.tags.fetch(tags);
    } catch (error) {
      this.runtime.reportError("get", error);
      return undefined;
    }
    const now = nowMs();
    if (
      buildTime === undefined &&
      this.runtime.tags.check([...tags, ...softTags], 0, now) !== "fresh"
    ) {
      return undefined;
    }
    const entry: StoredPageEntry = { value: found.value, tags, lastModified: buildTime ?? now };
    if (found.cacheControl) entry.cacheControl = found.cacheControl;
    const lifetime =
      until === undefined
        ? getEntryLifetime(
            entry.value,
            { cacheControl: entry.cacheControl },
            this.options.defaultTTL,
          )
        : Math.ceil((until - now) / 1000);
    return { entry, lifetime };
  }

  /**
   * Keep a build-output entry that passed the tag check, for what is left of its lifetime: in
   * Redis (`NX`, so an entry another instance or a render wrote first wins), or in process memory
   * without Redis. A failed write only costs the next read another trip to the disk.
   */
  private async keepBuildOutput(cacheKey: string, built: BuildOutputEntry): Promise<void> {
    const { connection, stores } = this.runtime;
    const { entry, lifetime } = built;
    if (lifetime <= 0) return;
    if (!connection) {
      const bytes = encodeEntry(entry).byteLength;
      stores.page.set(cacheKey, { entry }, bytes, nowMs() + lifetime * 1000);
      this.log?.("set", cacheKey, "build output, memory", { lifetime, bytes });
      return;
    }
    try {
      const encoded = await encodeStored(entry);
      const key = this.redisKey(cacheKey);
      const written = await connection.client.set(key, encoded, "EX", lifetime, "NX");
      stores.entryTags.set(key, entry.tags, stringListBytes(entry.tags), null);
      this.log?.(
        "set",
        cacheKey,
        written ? "build output, redis" : "build output, already in redis",
        { lifetime, ...storedSizes(encoded) },
      );
    } catch (error) {
      this.runtime.reportError("set", error);
    }
  }

  private toResult(
    entry: StoredPageEntry,
    allTags: string[],
    ctx: PageCacheGetContext | undefined,
  ): PageCacheHandlerValue | null {
    const now = nowMs();
    // No entry is served past the longest entry age, whatever TTL it was written with.
    if (now - entry.lastModified >= MAX_ENTRY_AGE_SECONDS * 1000) return null;
    const state = this.runtime.tags.check(allTags, entry.lastModified, now);
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
        Math.floor(nowMs() - revalidate * 1000 - STALE_MARGIN_MS),
      );
    }

    // Stored as wall time (Redis is shared); Next ages it on its own clock.
    lastModified = toNextClock(lastModified);
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
    if (!data || this.edge) return;
    const { connection, stores } = this.runtime;
    const tags = getEntryTags(data, ctx);
    const lifetime = getEntryLifetime(data, ctx, this.options.defaultTTL);
    // Already expired; Redis rejects `EX 0`.
    if (lifetime <= 0) return;

    const entry: StoredPageEntry = { value: data, tags, lastModified: nowMs() };
    // Next reads a page's periods back from `get`, so an instance that did not render the page
    // revalidates it on the page's own schedule.
    if (!ctx?.fetchCache && ctx?.cacheControl) entry.cacheControl = ctx.cacheControl;

    if (!connection || tags.includes(MEMORY_ONLY_TAG)) {
      const bytes = encodeEntry(entry).byteLength;
      stores.page.set(cacheKey, { entry }, bytes, entry.lastModified + lifetime * 1000);
      this.log?.("set", cacheKey, "memory", { lifetime, bytes });
      return;
    }

    let encoded: Buffer | undefined;
    if (await isRedisReady(this.runtime)) {
      try {
        encoded = await encodeStored(entry);
        const key = this.redisKey(cacheKey);
        await connection.client.set(key, encoded, "EX", lifetime);
        stores.entryTags.set(key, tags, stringListBytes(tags), null);
        this.log?.("set", cacheKey, "redis", { tags, lifetime, ...storedSizes(encoded) });
        return;
      } catch (error) {
        this.runtime.reportError("set", error);
      }
    }

    if (!this.memoryFallback) return;
    const size = encoded ? storedSizes(encoded).bytes : encodeEntry(entry).byteLength;
    const until = entry.lastModified + Math.min(lifetime, FALLBACK_TTL_SECONDS) * 1000;
    stores.pageFallback.set(cacheKey, { entry }, size, until);
    this.log?.("set", cacheKey, "fallback memory", { bytes: size });
  }

  /**
   * Invalidate `tags` in every handler of this process and, through Redis, every instance.
   * `durations` (`{ expire }`) keeps entries servable, stale, until `expire` seconds have passed.
   */
  async revalidateTag(
    tags: string | string[],
    durations?: { expire?: number } | string,
  ): Promise<void> {
    if (this.edge) return;
    const list = Array.isArray(tags) ? tags : [tags];
    // A profile name (16.4.2 callers) cannot be resolved here; treat it as an immediate expiry.
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
    if (this.edge) return;
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
   * Close the cache: the same as {@link closeCache}, which closes every connection the package
   * opened in this process (they are shared by every handler), empties its memory stores and
   * drops its tag state. A client you passed in is never closed. Handlers reconnect on next use.
   * @deprecated Call `closeCache()`; it is the same and does not need a handler.
   */
  async close(): Promise<void> {
    await closeCache();
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
