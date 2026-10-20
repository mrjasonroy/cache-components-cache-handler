/**
 * The clock used before Next's server environment is set up (a custom server calling
 * `flushCache()` before `app.prepare()`) must not load Next's work unit storage: Next would create
 * it without AsyncLocalStorage, as a stand-in whose `run` throws, and keep it for the process.
 */
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";
import { nowMs, setClockForTests } from "./clock.js";

const STORAGE_MODULE = "next/dist/server/app-render/work-unit-async-storage.external.js";
const require = createRequire(import.meta.url);

function storageSymbols(): symbol[] {
  return Object.getOwnPropertySymbols(globalThis).filter((symbol) =>
    symbol.description?.startsWith("@next/work-unit-async-storage@"),
  );
}

describe("clock: before Next's server environment", () => {
  test("does not load Next's storage, so a later render still runs", async () => {
    // Guards the setup: nothing of Next's server environment is loaded yet.
    expect((globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage).toBeUndefined();
    expect(storageSymbols()).toEqual([]);

    setClockForTests(undefined);
    try {
      nowMs();
      expect(storageSymbols()).toEqual([]);
      expect(require.cache[require.resolve(STORAGE_MODULE)]).toBeUndefined();

      // Next's server environment, then a prerender.
      require("next/dist/server/node-environment-baseline.js");
      require("next/dist/server/node-environment-extensions/date.js");
      const { workUnitAsyncStorage } = require(STORAGE_MODULE);
      const {
        workAsyncStorage,
      } = require("next/dist/server/app-render/work-async-storage.external.js");
      const {
        createDynamicTrackingState,
      } = require("next/dist/server/app-render/dynamic-rendering.js");
      const controller = new AbortController();
      const prerenderStore = {
        type: "prerender",
        phase: "action",
        controller,
        renderSignal: controller.signal,
        dynamicTracking: createDynamicTrackingState(undefined),
      };
      let inside: number | undefined;
      workAsyncStorage.run({ route: "/routes/use_cache-cached" }, () =>
        workUnitAsyncStorage.run(prerenderStore, () => {
          inside = nowMs();
        }),
      );
      expect(inside).toEqual(expect.any(Number));
      expect(controller.signal.aborted).toBe(false);
    } finally {
      setClockForTests(() => Date.now());
    }
  });
});
