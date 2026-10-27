/**
 * Once-per-process warnings for the 16.4.2 APIs deprecated in 16.4.3 and removed in 16.5.
 *
 * The package entry (`index.ts`) exports wrapped versions of the deprecated functions, so only an
 * application's own calls warn; the package's internal uses of the same code never do.
 */

import { processLogger, writeLog } from "./logger.js";

/** Version in which the deprecated 16.4.2 APIs are removed. */
export const REMOVED_IN = "16.5";

export const MIGRATION_GUIDE =
  "https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md";

const WARNED_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/deprecations");

/** Shared by every copy of the module Next loads in this process. */
function warned(): Set<string> {
  const store = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  let set = store[WARNED_KEY];
  if (!set) {
    set = new Set();
    store[WARNED_KEY] = set;
  }
  return set;
}

/**
 * The warning logged for `api`, naming its replacement.
 */
export function deprecationMessage(api: string, replacement: string): string {
  return (
    `@mrjasonroy/cache-components-cache-handler: ${api} is deprecated and will be removed in ` +
    `${REMOVED_IN}. ${replacement} See ${MIGRATION_GUIDE}`
  );
}

/**
 * Log the deprecation of `api` once per process (through `setCacheLogger`'s logger, else
 * `console.warn`).
 */
export function warnDeprecated(api: string, replacement: string): void {
  warnOnce(api, deprecationMessage(api, replacement));
}

/**
 * Log `message` once per process under `key`. Silent while a deprecated function the application
 * called is running (see {@link deprecatedFunction}), so one call logs one line.
 */
export function warnOnce(key: string, message: string): void {
  if (suppressDepth > 0) return;
  const seen = warned();
  if (seen.has(key)) return;
  seen.add(key);
  writeLog(processLogger, "warn", message, undefined);
}

/**
 * Depth of deprecated-function calls in progress. The constructors and factories they call
 * (`createMemoryCacheHandler` constructs a `MemoryCacheHandler`) must not add their own lines.
 */
let suppressDepth = 0;

/**
 * `fn`, warning once per process on its first call. Deprecation warnings from inside the call are
 * suppressed: the application called one deprecated API, so it gets one line.
 */
export function deprecatedFunction<F extends (...args: never[]) => unknown>(
  fn: F,
  api: string,
  replacement: string,
): F {
  const wrapped = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
    warnDeprecated(api, replacement);
    suppressDepth++;
    try {
      return fn.apply(this, args) as ReturnType<F>;
    } finally {
      suppressDepth--;
    }
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped as unknown as F;
}

/** Test-only: forget which deprecations have been logged. */
export function resetDeprecationsForTests(): void {
  warned().clear();
}
