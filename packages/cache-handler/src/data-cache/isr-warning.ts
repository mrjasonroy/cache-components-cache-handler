/**
 * One-time production warning that `createCacheHandler` does not cover pages.
 *
 * A data cache handler cannot see the Next.js config, so it cannot tell whether the app also
 * configured a shared page `cacheHandler`. Instead, the first time a shared-store (Redis-family)
 * handler made by `createCacheHandler` is used in a production process, we warn once, unless the
 * package's page handler ({@link markPageHandlerCreated}) has been created in this process.
 *
 * The check runs at first use, not at creation: Next loads `cacheHandlers` modules when the
 * server starts, but constructs the singular `cacheHandler` per request, before rendering
 * (next/dist/server/base-server.js). By the first `"use cache"` call of a request, the page handler
 * of that request exists.
 */

const PAGE_HANDLER_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/page-handler");

export const ISR_WARNING_MESSAGE =
  "@mrjasonroy/cache-components-cache-handler: createCacheHandler only covers 'use cache'. If you " +
  "run more than one instance, use withCache(nextConfig) so pages and route handlers are shared " +
  "and revalidated across instances too, or configure your own shared cacheHandler. Pass " +
  "`suppressIsrWarning: true` to silence this.";

export interface IsrWarningOptions {
  /**
   * Silence the one-time production warning that ISR pages, route handler responses and
   * optimized images are not cached by this package. Set this once you have configured your own
   * shared ISR `cacheHandler`, or if you run a single instance.
   * @default false
   */
  suppressIsrWarning?: boolean;
}

let warned = false;

/**
 * Record that this package's page handler exists in this process. Called by its constructor.
 */
export function markPageHandlerCreated(): void {
  (globalThis as unknown as Record<symbol, boolean>)[PAGE_HANDLER_KEY] = true;
}

function isPageHandlerCreated(): boolean {
  return (globalThis as unknown as Record<symbol, boolean | undefined>)[PAGE_HANDLER_KEY] === true;
}

/**
 * Emit {@link ISR_WARNING_MESSAGE} once per process, only when `NODE_ENV` is `"production"`,
 * outside `next build`, the caller has not opted out, and the package's page handler has not been
 * created in this process.
 */
export function warnMissingIsrHandlerOnce(options: IsrWarningOptions = {}): void {
  if (
    warned ||
    options.suppressIsrWarning ||
    isPageHandlerCreated() ||
    process.env.NODE_ENV !== "production" ||
    // `next build` runs every static-generation worker with NODE_ENV=production; warn at runtime only.
    process.env.NEXT_PHASE === "phase-production-build"
  ) {
    return;
  }
  warned = true;
  console.warn(ISR_WARNING_MESSAGE);
}

/**
 * Reset the once-per-process guard. Test-only.
 * @internal
 */
export function resetIsrWarningForTests(): void {
  warned = false;
  Reflect.deleteProperty(globalThis, PAGE_HANDLER_KEY);
}
