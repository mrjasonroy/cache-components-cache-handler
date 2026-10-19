/**
 * Types for Next 16's singular `cacheHandler` (the incremental cache). Declared structurally so the
 * package does not need Next's internal types at build time. Verified against next@16.4.2:
 *
 * - constructor: `new CacheHandler({ dev, fs, flushToDisk, serverDistDir, revalidatedTags,
 *   maxMemoryCacheSize, _requestHeaders, fetchCacheKeyPrefix })`, once per `IncrementalCache`,
 *   which Next creates per request (next/dist/server/lib/incremental-cache/index.js,
 *   next/dist/server/base-server.js, next/dist/server/route-modules/route-module.js);
 * - `get(key, ctx)`: `ctx` is `{ kind: "APP_PAGE" | "APP_ROUTE" | "PAGES", isRoutePPREnabled,
 *   isFallback }` for responses and `{ kind: "FETCH", revalidate, fetchUrl, fetchIdx, tags,
 *   softTags }` for fetches (next/dist/server/response-cache/types.d.ts). It returns
 *   `{ value, lastModified, cacheControl? }`; a returned `cacheControl` overrides the prerender
 *   manifest, and Next marks the entry stale once `lastModified + revalidate` has passed;
 * - `set(key, data, ctx)`: `ctx` is `{ fetchCache: false, cacheControl: { revalidate, expire },
 *   isRoutePPREnabled, isFallback }` for responses, whose tags (including the implicit `_N_T_`
 *   path tags) arrive comma-joined in `data.headers["x-next-cache-tags"]`, and `{ fetchCache: true,
 *   tags, ... }` for fetches, whose revalidate period is `data.revalidate`;
 * - `revalidateTag(tags, durations?)`: `tags` is a string array (`string | string[]` in the type),
 *   `durations` is `{ expire }` (seconds) for `revalidateTag(tag, profile)` and absent for
 *   `revalidateTag(tag)`, `updateTag` and `revalidatePath` (next/dist/server/revalidation-utils.js);
 * - `resetRequestCache()`: called right after the per-request `IncrementalCache` is created.
 */

import type { CacheHandlerOptions } from "../types.js";

/**
 * An entry's lifetime, in seconds.
 */
export interface PageCacheControl {
  revalidate?: number | false;
  expire?: number;
}

/**
 * A stored value: `APP_PAGE`, `APP_ROUTE`, `PAGES`, `FETCH`, `IMAGE` or `REDIRECT`. Page values
 * hold `Buffer`s (`rscData`, route `body`) and a `Map` of `Buffer`s (`segmentData`).
 */
export interface PageCacheValue {
  kind: string;
  headers?: Record<string, string | string[] | number | undefined>;
  /** `FETCH` entries carry their revalidate period here. */
  revalidate?: number | false;
  [key: string]: unknown;
}

/**
 * What Next passes to the handler's constructor.
 */
export interface PageCacheHandlerContext extends CacheHandlerOptions {
  /** `<distDir>/server`; its parent holds `BUILD_ID`. */
  serverDistDir?: string;
  dev?: boolean;
  fetchCacheKeyPrefix?: string;
  maxMemoryCacheSize?: number;
  revalidatedTags?: string[];
}

/**
 * The context of `get`.
 */
export interface PageCacheGetContext {
  /** `FETCH` for `fetch` and `unstable_cache` reads. */
  kind?: string;
  /** Implicit (path) tags of a `fetch` read. */
  softTags?: string[];
  /** Tags of a `fetch` read. */
  tags?: string[];
  /** 16.5 / Next 14 name for the implicit tags. */
  implicitTags?: string[];
  /** Revalidate period of a `fetch` read, in seconds. */
  revalidate?: number | false;
  [key: string]: unknown;
}

/**
 * The context of `set`.
 */
export interface PageCacheSetContext {
  /** Tags of a `fetch` entry (and the 16.5 / Next 14 context). */
  tags?: string[];
  /** True for `fetch` and `unstable_cache` entries. */
  fetchCache?: boolean;
  cacheControl?: PageCacheControl;
  /** 16.5 / Next 14 revalidate period. */
  revalidate?: number | false;
  [key: string]: unknown;
}

/**
 * What `get` returns.
 */
export interface PageCacheHandlerValue {
  value: PageCacheValue;
  lastModified: number;
  cacheControl?: PageCacheControl;
}
