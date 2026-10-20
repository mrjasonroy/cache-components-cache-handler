/**
 * The handlers' clocks. Wall time, read without ever touching `Date` inside a prerender.
 *
 * **Why not `Date`.** With cacheComponents, Next extends `Date`
 * (next/dist/server/node-environment-extensions/date.js) so that `Date.now()`, `new Date()` and
 * `Date()` count as IO when the current work unit is a prerender (`io-utils.js`: store types
 * `prerender`, `prerender-runtime`, `prerender-client`, and a `request` with staged rendering),
 * and abort it. Next calls the handlers inside the prerender's async context, so a handler reading
 * `Date.now()` there aborts it: a route handler with two sequential `"use cache"` calls is then
 * built as dynamic.
 *
 * **Why not only the performance clock.** Next's own handlers read
 * `performance.timeOrigin + performance.now()`, but they compare times within one process. Ours
 * are compared across instances through Redis (tag records, flush barriers, stored entries), and
 * the performance clock is monotonic: it drifts from wall time (NTP slewing, a suspended VM, days
 * of uptime), so two instances could disagree by seconds about whether a revalidation came after
 * an entry.
 *
 * **So:** {@link nowMs} is the performance clock plus `offset = Date.now() − performance clock`,
 * re-measured on every call where reading `Date` is safe (no prerender work unit, see
 * {@link isDateSafe}), and reused where it is not. An instance that never gets a safe call keeps
 * the offset it last measured (0 before any: the performance clock, as Next's handlers).
 *
 * **Next's own timestamps** (`"use cache"` `entry.timestamp`, and the `lastModified` Next ages
 * page entries by) are on Next's performance clock: convert them with {@link fromNextClock} when
 * they come in and {@link toNextClock} when they go back, so stored times are wall times
 * everywhere and Next still reads its own clock.
 *
 * All values are whole milliseconds: they are stored in Redis as integers.
 */

import { isEdgeRuntime } from "./env.js";
import { requireModule } from "./node-require.js";

interface WorkUnitStore {
  type?: string;
  stagedRendering?: unknown;
}

interface WorkUnitStorage {
  getStore(): WorkUnitStore | undefined;
}

/** Work unit types for which Next's `io()` does nothing (next/dist/server/node-environment-extensions/io-utils.js). */
const DATE_SAFE_WORK_UNITS = new Set([
  "validation-client",
  "prerender-legacy",
  "cache",
  "private-cache",
  "unstable-cache",
  "build-time-generator",
]);

/** The key prefix Next registers its work unit storage under on `globalThis` (16.4+). */
const GLOBAL_STORAGE_PREFIX = "@next/work-unit-async-storage@";

/** How long a failed `require` of the storage is not retried, in ms. */
const REQUIRE_RETRY_MS = 1_000;

/** Next's work unit storages found so far; only a find is kept. */
let workUnitStorages: WorkUnitStorage[] = [];
let requireFailedAt: number | undefined;

/** Wall time minus the performance clock, in ms, as last measured. */
let offset = 0;

let testClock: (() => number) | undefined;

function performanceClock(): number {
  return performance.timeOrigin + performance.now();
}

function isStorage(value: unknown): value is WorkUnitStorage {
  return typeof (value as WorkUnitStorage | undefined)?.getStore === "function";
}

/**
 * Next's work unit storages: the ones it registers on `globalThis` (next@16.4.2
 * `getOrCreateGlobalAsyncLocalStorage`, keyed by Next's version), or else the `.external` module
 * `require`d from this package (Next before 16.4). Looked up again until one is found, so a call
 * before Next has loaded does not decide for good; a failed `require` is retried after
 * {@link REQUIRE_RETRY_MS}.
 */
function findWorkUnitStorages(): WorkUnitStorage[] {
  if (workUnitStorages.length > 0) return workUnitStorages;
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const found = Object.getOwnPropertySymbols(globalThis)
    .filter((symbol) => symbol.description?.startsWith(GLOBAL_STORAGE_PREFIX))
    .map((symbol) => globals[symbol])
    .filter(isStorage);
  if (found.length === 0) {
    const now = performanceClock();
    if (requireFailedAt === undefined || now - requireFailedAt >= REQUIRE_RETRY_MS) {
      try {
        // The `.external` module is the instance Next's server shares across its bundles.
        const loaded = requireModule<{ workUnitAsyncStorage?: unknown }>(
          "next/dist/server/app-render/work-unit-async-storage.external.js",
        );
        if (isStorage(loaded.workUnitAsyncStorage)) found.push(loaded.workUnitAsyncStorage);
        else requireFailedAt = now;
      } catch {
        // Not resolvable from this package, or Next's server environment (AsyncLocalStorage on
        // globalThis) is not set up yet.
        requireFailedAt = now;
      }
    }
  }
  workUnitStorages = found;
  return found;
}

/**
 * Whether `Date` is still the built-in one: Next's extension (date.js) replaces the constructor
 * with a plain function and `Date.now` with a bound one, named "bound now" (a bound function's
 * source also reads `[native code]`, so its name is checked).
 */
function isDateNative(): boolean {
  return (
    Function.prototype.toString.call(Date).includes("[native code]") && Date.now.name === "now"
  );
}

/**
 * Whether reading `Date` now cannot abort a prerender: the current work unit is none, or one for
 * which Next's `io()` does nothing. Without Next's work unit storage, only if `Date` is not
 * extended. Never on the edge runtime (no `require`; the edge entries do not use the clock).
 */
export function isDateSafe(): boolean {
  if (isEdgeRuntime()) return false;
  const storages = findWorkUnitStorages();
  if (storages.length === 0) return isDateNative();
  for (const storage of storages) {
    const store = storage.getStore();
    if (store === undefined) continue;
    if (store.type === "request") return !store.stagedRendering;
    return store.type !== undefined && DATE_SAFE_WORK_UNITS.has(store.type);
  }
  return true;
}

/**
 * Re-measure the offset if reading `Date` is safe, and return the performance clock it was
 * measured against.
 */
function anchor(): number {
  const performanceNow = performanceClock();
  if (isDateSafe()) offset = Date.now() - performanceNow;
  return performanceNow;
}

/**
 * The current wall time, in ms since the epoch: the performance clock re-anchored to `Date`.
 */
export function nowMs(): number {
  if (testClock) return testClock();
  return Math.round(anchor() + offset);
}

/**
 * The current time on Next's clock (`performance.timeOrigin + performance.now()`), for comparing
 * with a timestamp Next stamped and that never leaves this process.
 */
export function nextClockMs(): number {
  if (testClock) return testClock();
  return Math.round(performanceClock());
}

/**
 * A time Next stamped on its clock, as wall time.
 */
export function fromNextClock(time: number): number {
  if (testClock) return time;
  anchor();
  return Math.round(time + offset);
}

/**
 * A wall time, on Next's clock, for a time Next reads (an entry's `timestamp`, `lastModified`).
 */
export function toNextClock(time: number): number {
  if (testClock) return time;
  anchor();
  return Math.round(time - offset);
}

/**
 * Read every clock from `source` instead, with no conversion between them (`undefined`: the real
 * clocks again, with the offset and the work unit storages forgotten), so that tests can fake the
 * time with `vi.setSystemTime`. Test-only.
 * @internal
 */
export function setClockForTests(source: (() => number) | undefined): void {
  testClock = source;
  if (source === undefined) {
    offset = 0;
    workUnitStorages = [];
    requireFailedAt = undefined;
  }
}
