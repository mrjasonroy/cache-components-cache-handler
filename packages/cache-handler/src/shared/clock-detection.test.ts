/**
 * How the clock finds out whether reading `Date` can abort a prerender when this package cannot
 * `require` Next's work unit storage (a packaged deploy resolving `next` from elsewhere): through
 * the storage Next registers on `globalThis`, and failing that by whether `Date` is extended.
 */

// Next's server environment, as next build and next start set it up: AsyncLocalStorage on
// globalThis, then the Date extension.
import "next/dist/server/node-environment-baseline.js";
import "next/dist/server/node-environment-extensions/date.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createDynamicTrackingState } from "next/dist/server/app-render/dynamic-rendering.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("./node-require.js", async (importOriginal) => {
  const unresolvable = () => {
    throw new Error(
      "Cannot find module 'next/dist/server/app-render/work-unit-async-storage.external.js'",
    );
  };
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: unresolvable,
    loadedModule: unresolvable,
  };
});

const SKEW_MS = 5_000;

// The setup file loaded the clock with the real loader: this file's clock is a fresh copy.
let clock: typeof import("./clock.js");
const nowMs = () => clock.nowMs();

/** The key Next registers its work unit storage under on `globalThis`. */
const storageKey = Object.getOwnPropertySymbols(globalThis).find((symbol) =>
  symbol.description?.startsWith("@next/work-unit-async-storage@"),
);
const globals = globalThis as unknown as Record<symbol, unknown>;

function skewPerformanceClock(skew: number): void {
  Object.defineProperty(performance, "timeOrigin", {
    value: performance.timeOrigin + skew,
    configurable: true,
  });
}

/** Run `fn` in a prerender's async context and return whether the prerender was aborted. */
async function abortsPrerender(fn: () => unknown): Promise<boolean> {
  const controller = new AbortController();
  const prerenderStore = {
    type: "prerender",
    phase: "action",
    controller,
    renderSignal: controller.signal,
    dynamicTracking: createDynamicTrackingState(undefined),
  };
  await workAsyncStorage.run({ route: "/routes/use_cache-cached" } as never, () =>
    workUnitAsyncStorage.run(prerenderStore as never, async () => fn()),
  );
  return controller.signal.aborted;
}

describe("clock: Next's work unit storage cannot be required", () => {
  beforeAll(async () => {
    vi.resetModules();
    clock = await import("./clock.js");
  });
  afterEach(() => {
    Reflect.deleteProperty(performance, "timeOrigin");
    clock.setClockForTests(undefined);
  });
  afterAll(() => vi.resetModules());

  test("guards the setup: Next registered its storage on globalThis, and Date aborts a prerender", async () => {
    expect(storageKey).toBeDefined();
    expect(globals[storageKey as symbol]).toBe(workUnitAsyncStorage);
    expect(await abortsPrerender(() => Date.now())).toBe(true);
  });

  test("found through globalThis: no Date read in a prerender, re-anchored outside one", async () => {
    expect(await abortsPrerender(() => nowMs())).toBe(false);

    skewPerformanceClock(SKEW_MS);
    const before = Date.now();
    const now = nowMs();
    expect(now).toBeGreaterThanOrEqual(before - 1);
    expect(now).toBeLessThanOrEqual(Date.now() + 1);
  });

  test("not found at all, but Date is extended: never read, so no prerender is aborted", async () => {
    const storage = globals[storageKey as symbol];
    Reflect.deleteProperty(globalThis, storageKey as symbol);
    try {
      expect(await abortsPrerender(() => nowMs())).toBe(false);
    } finally {
      globals[storageKey as symbol] = storage;
    }
  });

  test("another Next version's storage beside the running one's: the running one decides", async () => {
    const other = Symbol.for("@next/work-unit-async-storage@0.0.0");
    globals[other] = new AsyncLocalStorage();
    try {
      expect(await abortsPrerender(() => nowMs())).toBe(false);
    } finally {
      Reflect.deleteProperty(globalThis, other);
    }
  });

  test("a later call finds the storage once Next has registered it", async () => {
    const storage = globals[storageKey as symbol];
    Reflect.deleteProperty(globalThis, storageKey as symbol);
    skewPerformanceClock(SKEW_MS);
    try {
      // Unknown, and Date extended: the offset is not measured (0: the skewed performance clock).
      expect(Math.abs(nowMs() - Date.now() - SKEW_MS)).toBeLessThanOrEqual(2);
    } finally {
      globals[storageKey as symbol] = storage;
    }
    expect(Math.abs(nowMs() - Date.now())).toBeLessThanOrEqual(2);
  });

  describe("several Next versions in one process", () => {
    const later = Symbol.for("@next/work-unit-async-storage@99.0.0");
    const laterStorage = new AsyncLocalStorage<{ type: string }>();
    afterEach(() => {
      Reflect.deleteProperty(globalThis, later);
    });

    /**
     * Run `fn` with the performance clock 5 s ahead after anchoring once, and return whether
     * `fn`'s clock reads re-anchored (read `Date`) or kept the offset measured before the skew.
     */
    function readsDate(fn: (check: () => boolean) => boolean): boolean {
      const offset = clock.fromNextClock(0);
      skewPerformanceClock(SKEW_MS);
      return fn(() => {
        // Measured against the (skewed) performance clock: reading Date here would abort.
        const kept =
          Math.abs(nowMs() - (performance.timeOrigin + performance.now()) - offset) <= 2 &&
          Math.abs(clock.fromNextClock(0) - offset) <= 2 &&
          Math.abs(clock.toNextClock(0) + offset) <= 2;
        return !kept;
      });
    }

    test("a version registered after the first lookup is still consulted", () => {
      // The first lookup finds only the running version's storage.
      expect(nowMs()).toBeGreaterThan(0);
      globals[later] = laterStorage;

      const read = readsDate((check) => laterStorage.run({ type: "prerender" }, check));
      expect(read).toBe(false);
    });

    test("a safe store in one storage does not hide an unsafe one in another", async () => {
      globals[later] = laterStorage;
      // Measure the offset outside the prerender first.
      expect(nowMs()).toBeGreaterThan(0);
      let read: boolean | undefined;
      const aborted = await abortsPrerender(() => {
        read = readsDate((check) => laterStorage.run({ type: "cache" }, check));
      });
      expect(aborted).toBe(false);
      expect(read).toBe(false);
    });

    test("an unsafe store in a later storage is not hidden by a safe one in the first", () => {
      globals[later] = laterStorage;
      const read = readsDate((check) =>
        workUnitAsyncStorage.run({ type: "cache" } as never, () =>
          laterStorage.run({ type: "prerender" }, check),
        ),
      );
      expect(read).toBe(false);
    });

    test("safe stores in every storage: re-anchored", () => {
      globals[later] = laterStorage;
      const read = readsDate((check) =>
        workUnitAsyncStorage.run({ type: "cache" } as never, () =>
          laterStorage.run({ type: "cache" }, check),
        ),
      );
      expect(read).toBe(true);
    });
  });
});
