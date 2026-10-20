/**
 * `withCache(nextConfig, options)`: the one public way to configure the app's whole cache.
 */

import { nodeBuiltin } from "../shared/node-require.js";

/**
 * Options of {@link withCache}. They are read when the config loads and decide which handler
 * files Next is pointed at; runtime settings come from the environment.
 */
export interface WithCacheOptions {
  /**
   * Where `"use cache"` (no suffix) stores entries: `"memory"` keeps values per instance with
   * shared tag invalidation, `"redis"` uses the same Redis handler as `"use cache: remote"`.
   * @default "memory"
   */
  useCache?: "memory" | "redis";

  /**
   * Set `cacheHandler` (pages, route handlers and cached `fetch`) and `cacheMaxMemorySize: 0`.
   * With `false`, a `cacheHandler` already in your config is kept.
   * @default true
   */
  pages?: boolean;

  /**
   * Your own handler files instead of the built-in ones. Relative paths resolve against
   * `process.cwd()`.
   */
  handlers?: { page?: string; default?: string; remote?: string };
}

/**
 * The fields `withCache` adds to the Next config.
 */
export interface WithCacheConfig {
  cacheHandler?: string;
  cacheHandlers: { default: string; remote: string };
  cacheMaxMemorySize?: number;
}

/**
 * Absolute path of a built-in entry module shipped in `dist/entries`.
 */
function entryPath(name: "page" | "remote" | "default"): string {
  // Built-ins are loaded on use: the package root re-exports this module, and a custom handler
  // file importing the root is bundled into the edge middleware (../shared/node-require.ts).
  const { fileURLToPath } = nodeBuiltin<typeof import("node:url")>("node:url");
  return fileURLToPath(new URL(`../entries/${name}.js`, import.meta.url));
}

function resolvePath(path: string): string {
  const { isAbsolute, resolve } = nodeBuiltin<typeof import("node:path")>("node:path");
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/**
 * A `next.config` exported as a function: `(phase, { defaultConfig }) => config`, sync or async.
 */
export type NextConfigFunction<T extends object> = (
  phase: string,
  context: { defaultConfig: object },
) => T | Promise<T>;

/**
 * Configure the app's cache: pages and route handlers (`cacheHandler`), `"use cache"`
 * (`cacheHandlers.default`) and `"use cache: remote"` (`cacheHandlers.remote`), with Next's
 * built-in page LRU turned off (`cacheMaxMemorySize: 0`). Set `REDIS_URL` to share them across
 * instances; without it everything stays in memory.
 *
 * Accepts a config object or a config function; a function is wrapped in an async one that
 * applies `withCache` to its result. An explicit `cacheMaxMemorySize` is kept, with a warning
 * when it is not 0 (Next's own page LRU would then serve entries other instances revalidated).
 *
 * Throws if the config already sets `cacheHandlers`, or `cacheHandler` unless `pages: false`
 * (then your own `cacheHandler` is kept as it is).
 *
 * @example
 * ```js
 * // next.config.mjs
 * import { withCache } from "@mrjasonroy/cache-components-cache-handler";
 * export default withCache({ cacheComponents: true });
 * ```
 */
export function withCache<T extends object>(
  nextConfig: NextConfigFunction<T>,
  options?: WithCacheOptions,
): (phase: string, context: { defaultConfig: object }) => Promise<T & WithCacheConfig>;
export function withCache<T extends object>(
  nextConfig: T,
  options?: WithCacheOptions,
): T & WithCacheConfig;
export function withCache<T extends object>(
  nextConfig: T | NextConfigFunction<T>,
  options: WithCacheOptions = {},
):
  | (T & WithCacheConfig)
  | ((phase: string, context: { defaultConfig: object }) => Promise<T & WithCacheConfig>) {
  if (typeof nextConfig === "function") {
    const configFunction = nextConfig as NextConfigFunction<T>;
    return async (phase, context) => applyCache(await configFunction(phase, context), options);
  }
  return applyCache(nextConfig, options);
}

function applyCache<T extends object>(
  nextConfig: T,
  options: WithCacheOptions,
): T & WithCacheConfig {
  const config = nextConfig as T & Partial<WithCacheConfig>;
  const { useCache = "memory", pages = true, handlers = {} } = options;
  // With `pages: false` the page handler is the user's own business, so their cacheHandler stays.
  if ((pages && config.cacheHandler !== undefined) || config.cacheHandlers !== undefined) {
    throw new Error(
      "withCache: the Next config already sets cacheHandler or cacheHandlers. Remove them, or pass your own files with withCache(config, { handlers: { page, default, remote } }).",
    );
  }

  const remote = handlers.remote ? resolvePath(handlers.remote) : entryPath("remote");
  const defaultHandler = handlers.default
    ? resolvePath(handlers.default)
    : useCache === "redis"
      ? remote
      : entryPath("default");

  const userMemorySize = config.cacheMaxMemorySize;
  if (pages && userMemorySize !== undefined && userMemorySize !== 0) {
    console.warn(
      `withCache: keeping cacheMaxMemorySize: ${userMemorySize}. Next's built-in page memory cache can serve pages that another instance has revalidated; withCache sets it to 0 unless you set it.`,
    );
  }

  return {
    ...nextConfig,
    ...(pages
      ? {
          cacheHandler: handlers.page ? resolvePath(handlers.page) : entryPath("page"),
          cacheMaxMemorySize: userMemorySize ?? 0,
        }
      : {}),
    cacheHandlers: { default: defaultHandler, remote },
  };
}
