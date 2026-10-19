/**
 * Helper functions for configuring Next.js "use cache" handlers
 */

export interface CacheHandlerConfig {
  /**
   * Paths to data cache handlers (for `cacheHandlers` in next.config)
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
 * Create Next.js `cacheHandlers` configuration for "use cache" and "use cache: remote"
 *
 * Both `default` ("use cache") and `remote` ("use cache: remote") point at the same handler file.
 *
 * @param options - Configuration options
 * @param options.dataCacheHandlerPath - Path to data cache handler file (for cacheHandlers.default and cacheHandlers.remote)
 * @param options.disableDefaultMemoryCache - Set to true to disable Next.js default in-memory cache (default: true)
 *
 * @returns Configuration object to spread into next.config
 *
 * @example
 * ```ts
 * // next.config.mjs
 * import { createCacheConfig } from "@mrjasonroy/cache-components-cache-handler";
 * import { resolve } from "node:path";
 *
 * const cacheConfig = createCacheConfig({
 *   dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
 * });
 *
 * export default {
 *   cacheComponents: true,
 *   ...cacheConfig,
 * };
 * ```
 */
export function createCacheConfig(options: {
  dataCacheHandlerPath: string;
  disableDefaultMemoryCache?: boolean;
}): CacheHandlerConfig {
  const { dataCacheHandlerPath, disableDefaultMemoryCache = true } = options;

  return createCacheConfigWithProfiles({
    defaultDataCacheHandlerPath: dataCacheHandlerPath,
    remoteDataCacheHandlerPath: dataCacheHandlerPath,
    disableDefaultMemoryCache,
  });
}

/**
 * Create Next.js `cacheHandlers` configuration with separate handlers for default and remote
 *
 * This allows you to use different cache handlers for:
 * - `default`: Used by "use cache" (typically faster, in-memory or local)
 * - `remote`: Used by "use cache: remote" (typically shared, e.g. Redis)
 *
 * @param options - Configuration options
 * @param options.defaultDataCacheHandlerPath - Path to data cache handler for "use cache"
 * @param options.remoteDataCacheHandlerPath - Path to data cache handler for "use cache: remote"
 * @param options.disableDefaultMemoryCache - Set to true to disable Next.js default in-memory cache (default: true)
 *
 * @returns Configuration object to spread into next.config
 *
 * @example
 * ```ts
 * // next.config.mjs
 * import { createCacheConfigWithProfiles } from "@mrjasonroy/cache-components-cache-handler";
 * import { resolve } from "node:path";
 *
 * const cacheConfig = createCacheConfigWithProfiles({
 *   defaultDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-memory.mjs"),
 *   remoteDataCacheHandlerPath: resolve(process.cwd(), "./data-cache-redis.mjs"),
 * });
 *
 * export default {
 *   cacheComponents: true,
 *   ...cacheConfig,
 * };
 * ```
 */
export function createCacheConfigWithProfiles(options: {
  defaultDataCacheHandlerPath: string;
  remoteDataCacheHandlerPath: string;
  disableDefaultMemoryCache?: boolean;
}): CacheHandlerConfig {
  const {
    defaultDataCacheHandlerPath,
    remoteDataCacheHandlerPath,
    disableDefaultMemoryCache = true,
  } = options;

  return {
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
