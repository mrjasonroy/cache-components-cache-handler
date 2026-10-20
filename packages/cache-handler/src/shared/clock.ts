/**
 * The handlers' clock: `performance.timeOrigin + performance.now()`, never `Date`.
 *
 * With cacheComponents, Next extends `Date` (next/dist/server/node-environment-extensions/date.js)
 * so that reading the current time during a prerender counts as IO and aborts the prerender. Next
 * calls the handlers inside the prerender's async context, so a handler reading `Date.now()`
 * aborts it: a route handler with two sequential `"use cache"` calls is then built as dynamic.
 * Next's own handlers read this clock instead, and stamp their entries' `timestamp` with it
 * (next/dist/server/lib/cache-handlers/default.js, incremental-cache/index.js), so comparing
 * against those timestamps is consistent too. It is a global in Node and in the edge runtime.
 *
 * Rounded to whole milliseconds, as `Date.now()` was: the times are stored in Redis as integers.
 */

const performanceClock = (): number => Math.round(performance.timeOrigin + performance.now());

let clock = performanceClock;

/**
 * The current time, in ms since the epoch.
 */
export function nowMs(): number {
  return clock();
}

/**
 * Read the time from `source` instead (`undefined`: the performance clock again), so that tests
 * can fake it with `vi.setSystemTime`. Test-only.
 * @internal
 */
export function setClockForTests(source: (() => number) | undefined): void {
  clock = source ?? performanceClock;
}
