/**
 * One-time production warning that this package does not provide an ISR `cacheHandler`.
 *
 * A data cache handler cannot see the Next.js config, so it cannot tell whether the app also
 * configured a shared ISR `cacheHandler`. Instead, the first time a shared-store (Redis-family)
 * handler is created in a production process, we warn once that ISR pages, route handler
 * responses and optimized images are not covered by this package.
 */

export const ISR_WARNING_MESSAGE =
  "@mrjasonroy/cache-components-cache-handler only handles 'use cache'. If you run more than " +
  "one instance, configure a shared ISR cacheHandler too, or ISR pages and route handlers won't " +
  "be shared or revalidated across instances. Pass `suppressIsrWarning: true` to silence this.";

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
 * Emit {@link ISR_WARNING_MESSAGE} once per process, only when `NODE_ENV` is `"production"`
 * and the caller has not opted out.
 */
export function warnMissingIsrHandlerOnce(options: IsrWarningOptions = {}): void {
  if (warned || options.suppressIsrWarning || process.env.NODE_ENV !== "production") {
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
}
