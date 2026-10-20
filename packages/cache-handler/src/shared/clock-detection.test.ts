/**
 * How the clock finds out whether reading `Date` can abort a prerender when this package cannot
 * `require` Next's work unit storage (a packaged deploy resolving `next` from elsewhere): through
 * the storage Next registers on `globalThis`, and failing that by whether `Date` is extended.
 */

// Next's server environment, as next build and next start set it up: AsyncLocalStorage on
// globalThis, then the Date extension.
import "next/dist/server/node-environment-baseline.js";
import "next/dist/server/node-environment-extensions/date.js";
import { createDynamicTrackingState } from "next/dist/server/app-render/dynamic-rendering.js";
import { workAsyncStorage } from "next/dist/server/app-render/work-async-storage.external.js";
import { workUnitAsyncStorage } from "next/dist/server/app-render/work-unit-async-storage.external.js";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

vi.mock("./node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-require.js")>()),
  requireModule: () => {
    throw new Error(
      "Cannot find module 'next/dist/server/app-render/work-unit-async-storage.external.js'",
    );
  },
}));

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
});
