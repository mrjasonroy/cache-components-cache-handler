/**
 * `withCache(nextConfig, options)`: the one public way to configure the app's whole cache.
 */

import { processLogger, writeLog } from "../shared/logger.js";
import {
  MEMORY_OPTIONS_ENV,
  type MemoryOptions,
  validateMemoryOptions,
} from "../shared/memory-budget.js";
import { nodeBuiltin } from "../shared/node-require.js";

/**
 * Options of {@link withCache}. They are read when the config loads and decide which handler
 * files Next is pointed at; runtime settings come from the environment, except `memory`.
 */
export interface WithCacheOptions {
  /**
   * Set `cacheHandler` (pages, route handlers and cached `fetch`) and `cacheMaxMemorySize: 0`.
   * With `false`, a `cacheHandler` already in your config is kept.
   * @default true
   */
  pages?: boolean;

  /**
   * Your own handler files instead of the built-in ones. Relative paths resolve against the
   * working directory (`process.cwd()`), not against `next.config`; pass an absolute path when
   * the two can differ.
   */
  handlers?: { page?: string; default?: string; remote?: string };

  /**
   * The in-process memory budget: `heapPercent` of the V8 heap limit, or `maxMiB` (which wins).
   * Wins over `CACHE_MEMORY_HEAP_PERCENT` and `CACHE_MEMORY_MAX_MIB`. Applies where `next.config`
   * is loaded by the serving process (`next dev`, `next start`); a standalone `server.js` never
   * loads it, so set the environment variables there.
   * @default { heapPercent: 10 }
   */
  memory?: MemoryOptions;
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
 * (`cacheHandlers.default`: per-instance memory, tag invalidation shared through Redis) and
 * `"use cache: remote"` (`cacheHandlers.remote`: Redis), and `cacheMaxMemorySize: 0`.
 * `"use cache: private"` is Next's own and never reaches a handler. Set `REDIS_URL` to share
 * entries and tags across instances; without it everything stays in memory. Works with
 * `cacheComponents: true` and with Next's deprecated `experimental.useCache` alike.
 *
 * Accepts a config object or a config function; a function is wrapped in an async one that
 * applies `withCache` to its result. An explicit `cacheMaxMemorySize` is kept, with a warning
 * when it is not 0: it sizes the memory caches of Next's own file-system page cache and built-in
 * `"use cache"` handler, and with these handlers set Next uses neither, so it has no effect.
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
  checkOptionKeys(options);
  if (typeof nextConfig === "function") {
    const configFunction = nextConfig as NextConfigFunction<T>;
    return async (phase, context) => applyCache(await configFunction(phase, context), options);
  }
  return applyCache(nextConfig, options);
}

const OPTION_KEYS = new Set(["pages", "handlers", "memory"]);

/**
 * Throw on an option `withCache` does not know, so a leftover from a release candidate (or a typo)
 * is not silently ignored.
 */
function checkOptionKeys(options: WithCacheOptions): void {
  if (typeof options !== "object" || options === null) {
    throw new Error("withCache: options must be an object like { pages, handlers, memory }.");
  }
  for (const key of Object.keys(options)) {
    if (OPTION_KEYS.has(key)) continue;
    if (key === "useCache") {
      throw new Error(
        'withCache: the useCache option was removed in 16.4.3-rc.4. Plain "use cache" always stays in each instance\'s memory; write "use cache: remote" for entries that belong in Redis.',
      );
    }
    throw new Error(
      `withCache: unknown option "${key}"; the options are pages, handlers and memory.`,
    );
  }
}

function applyCache<T extends object>(
  nextConfig: T,
  options: WithCacheOptions,
): T & WithCacheConfig {
  const config = nextConfig as T & Partial<WithCacheConfig>;
  const { pages = true, handlers = {}, memory } = options;
  // With `pages: false` the page handler is the user's own business, so their cacheHandler stays.
  if ((pages && config.cacheHandler !== undefined) || config.cacheHandlers !== undefined) {
    throw new Error(
      "withCache: the Next config already sets cacheHandler or cacheHandlers. Remove them, or pass your own files with withCache(config, { handlers: { page, default, remote } }).",
    );
  }

  const remote = handlers.remote ? resolvePath(handlers.remote) : entryPath("remote");
  const defaultHandler = handlers.default ? resolvePath(handlers.default) : entryPath("default");

  handOverMemoryOptions(memory, (config as { output?: unknown }).output);

  const userMemorySize = config.cacheMaxMemorySize;
  if (pages && userMemorySize !== undefined && userMemorySize !== 0) {
    writeLog(
      processLogger,
      "warn",
      `withCache: keeping cacheMaxMemorySize: ${userMemorySize}. It has no effect with withCache's handlers: it sizes Next's own page and "use cache" memory caches, which Next does not use once cacheHandler and cacheHandlers are set. The package's own memory caps are in docs/operations.md#memory.`,
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

/**
 * Validate `memory` and hand it to the handlers through {@link MEMORY_OPTIONS_ENV}. Next cannot
 * pass objects from `next.config` to handler files, and its runtime config keeps only the fields
 * Next knows, so the option travels in this process's environment: `next dev`, `next build` (and
 * its workers) and `next start` load `next.config` in the process that serves. Without `memory`
 * the variable is removed, so a reloaded config that drops the option drops it here too.
 */
function handOverMemoryOptions(memory: MemoryOptions | undefined, output: unknown): void {
  if (memory === undefined) {
    Reflect.deleteProperty(process.env, MEMORY_OPTIONS_ENV);
    return;
  }
  const valid = validateMemoryOptions(memory, "withCache");
  process.env[MEMORY_OPTIONS_ENV] = JSON.stringify(valid);
  if (output === "standalone") {
    writeLog(
      processLogger,
      "warn",
      "withCache: memory applies under next dev and next start. A standalone server.js does not load next.config, so set CACHE_MEMORY_HEAP_PERCENT or CACHE_MEMORY_MAX_MIB in its environment.",
    );
  }
}
