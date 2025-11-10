/**
 * Helper functions for configuring Next.js cache handlers
 */

export interface CacheHandlerConfig {
  /**
   * Path to ISR cache handler (for cacheHandler in next.config)
   */
  cacheHandler: string;

  /**
   * Paths to data cache handlers (for cacheHandlers in next.config)
   */
  cacheHandlers: {
    default: string;
    remote: string;
  };

  /**
   * Disable Next.js default in-memory cache for "use cache"
   * Set to 0 to use your own handlers exclusively
   */
  cacheMaxMemorySize?: number;
}

/**
 * Create Next.js cache handler configuration for both ISR and Data Cache
 *
 * This generates the config needed for both:
 * - `cacheHandler`: ISR cache (Incremental Static Regeneration)
 * - `cacheHandlers`: Data cache ("use cache" and "use cache: remote")
 *
 * @param options - Configuration options
 * @param options.isrHandlerPath - Path to ISR cache handler file (for cacheHandler)
 * @param options.dataCacheHandlerPath - Path to data cache handler file (for cacheHandlers.default and cacheHandlers.remote)
 * @param options.disableDefaultMemoryCache - Set to true to disable Next.js default in-memory cache (default: true)
 *
 * @returns Configuration object to spread into next.config
 *
 * @example
 * ```ts
 * // next.config.mjs
 * import { createCacheConfig } from "@mrjasonroy/better-nextjs-cache-handler";
 * import { resolve } from "path";
 *
 * const cacheConfig = createCacheConfig({
 *   isrHandlerPath: resolve(process.cwd(), "./cache-handler.mjs"),
 *   dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
 * });
 *
 * export default {
 *   ...cacheConfig,
 *   // other Next.js config
 * };
 * ```
 */
export function createCacheConfig(options: {
  isrHandlerPath: string;
  dataCacheHandlerPath: string;
  disableDefaultMemoryCache?: boolean;
}): CacheHandlerConfig {
  const { isrHandlerPath, dataCacheHandlerPath, disableDefaultMemoryCache = true } = options;

  return {
    cacheHandler: isrHandlerPath,
    cacheHandlers: {
      // "use cache" uses this (default cache profile)
      default: dataCacheHandlerPath,
      // "use cache: remote" uses this (for DB queries, API calls)
      remote: dataCacheHandlerPath,
    },
    // Disable Next.js default in-memory cache to use our handlers exclusively
    cacheMaxMemorySize: disableDefaultMemoryCache ? 0 : undefined,
  };
}

/**
 * Create Next.js cache handler configuration with separate handlers for default and remote
 *
 * This allows you to use different cache handlers for:
 * - `default`: Used by "use cache" (typically faster, in-memory or local)
 * - `remote`: Used by "use cache: remote" (typically slower, database or API results)
 *
 * @param options - Configuration options
 * @param options.isrHandlerPath - Path to ISR cache handler file (for cacheHandler)
 * @param options.defaultDataCacheHandlerPath - Path to data cache handler for "use cache"
 * @param options.remoteDataCacheHandlerPath - Path to data cache handler for "use cache: remote"
 * @param options.disableDefaultMemoryCache - Set to true to disable Next.js default in-memory cache (default: true)
 *
 * @returns Configuration object to spread into next.config
 *
 * @example
 * ```ts
 * // next.config.mjs
 * import { createCacheConfigWithProfiles } from "@mrjasonroy/better-nextjs-cache-handler";
 * import { resolve } from "path";
 *
 * const cacheConfig = createCacheConfigWithProfiles({
 *   isrHandlerPath: resolve(process.cwd(), "./cache-handler.mjs"),
 *   defaultDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-memory.mjs"),
 *   remoteDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-redis.mjs"),
 * });
 *
 * export default {
 *   ...cacheConfig,
 *   // other Next.js config
 * };
 * ```
 */
export function createCacheConfigWithProfiles(options: {
  isrHandlerPath: string;
  defaultDataCacheHandlerPath: string;
  remoteDataCacheHandlerPath: string;
  disableDefaultMemoryCache?: boolean;
}): CacheHandlerConfig {
  const {
    isrHandlerPath,
    defaultDataCacheHandlerPath,
    remoteDataCacheHandlerPath,
    disableDefaultMemoryCache = true,
  } = options;

  return {
    cacheHandler: isrHandlerPath,
    cacheHandlers: {
      // "use cache" uses this (default cache profile)
      default: defaultDataCacheHandlerPath,
      // "use cache: remote" uses this (for DB queries, API calls)
      remote: remoteDataCacheHandlerPath,
    },
    // Disable Next.js default in-memory cache to use our handlers exclusively
    cacheMaxMemorySize: disableDefaultMemoryCache ? 0 : undefined,
  };
}
