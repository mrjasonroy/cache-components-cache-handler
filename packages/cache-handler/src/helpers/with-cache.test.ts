import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { MEMORY_OPTIONS_ENV } from "../shared/memory-budget.js";
import { getCacheRuntime } from "../shared/runtime.js";
import { resetCacheState } from "../testing/env.js";
import { withCache } from "./with-cache.js";

/** Built entries are `dist/entries/*.js`; in source they are the `.ts` files beside them. */
function sourceOf(path: string): string {
  return join(dirname(path), basename(path).replace(/\.js$/, ".ts"));
}

describe("withCache", () => {
  test("sets cacheHandler, both cacheHandlers and turns off the built-in page LRU", () => {
    const config = withCache({ cacheComponents: true, reactStrictMode: true });
    expect(config.cacheComponents).toBe(true);
    expect(config.reactStrictMode).toBe(true);
    expect(config.cacheMaxMemorySize).toBe(0);
    expect(basename(config.cacheHandler ?? "")).toBe("page.js");
    expect(basename(config.cacheHandlers.default)).toBe("default.js");
    expect(basename(config.cacheHandlers.remote)).toBe("remote.js");
    for (const path of [
      config.cacheHandler ?? "",
      config.cacheHandlers.default,
      config.cacheHandlers.remote,
    ]) {
      expect(path).toMatch(/[\\/]entries[\\/]/);
      expect(existsSync(sourceOf(path))).toBe(true);
    }
  });

  test('"use cache" always gets the local handler, "use cache: remote" the Redis one', () => {
    const config = withCache({ cacheComponents: true });
    expect(config.cacheHandlers.default).not.toBe(config.cacheHandlers.remote);
    expect(basename(config.cacheHandlers.default)).toBe("default.js");
  });

  test("works with Next's deprecated experimental.useCache flag too", () => {
    // withCache never checks which flag turned "use cache" on.
    const config = withCache({ experimental: { useCache: true } });
    expect(config.experimental).toEqual({ useCache: true });
    expect(basename(config.cacheHandler ?? "")).toBe("page.js");
    expect(basename(config.cacheHandlers.default)).toBe("default.js");
    expect(basename(config.cacheHandlers.remote)).toBe("remote.js");
    expect(config.cacheMaxMemorySize).toBe(0);
  });

  test("accepts Redis for plain use cache and rejects unknown options", () => {
    const config = withCache({}, { useCache: "redis" });
    expect(basename(config.cacheHandlers.default)).toBe("remote.js");
    const typo = { page: false } as unknown as Parameters<typeof withCache>[1];
    expect(() => withCache({}, typo)).toThrow(/unknown option "page"/);
    expect(() => withCache({}, { pages: true, handlers: {}, memory: { maxMiB: 8 } })).not.toThrow();
  });

  test("pages: false leaves cacheHandler and cacheMaxMemorySize alone", () => {
    const config = withCache({}, { pages: false });
    expect(config.cacheHandler).toBeUndefined();
    expect(config.cacheMaxMemorySize).toBeUndefined();
  });

  test("pages: false keeps the user's own cacheHandler", () => {
    const config = withCache({ cacheHandler: "/abs/my-handler.mjs" }, { pages: false });
    expect(config.cacheHandler).toBe("/abs/my-handler.mjs");
    expect(basename(config.cacheHandlers.remote)).toBe("remote.js");
    expect(() => withCache({ cacheHandlers: { default: "./x.mjs" } }, { pages: false })).toThrow(
      /already sets/,
    );
  });

  test("custom handler files; relative paths resolve against cwd", () => {
    const config = withCache(
      {},
      {
        handlers: {
          page: "./cache/page.mjs",
          default: "/abs/default.mjs",
          remote: "cache/remote.mjs",
        },
      },
    );
    expect(config.cacheHandler).toBe(resolve(process.cwd(), "cache/page.mjs"));
    expect(config.cacheHandlers.default).toBe("/abs/default.mjs");
    expect(config.cacheHandlers.remote).toBe(resolve(process.cwd(), "cache/remote.mjs"));
  });

  test("throws if the config already sets a cache handler", () => {
    expect(() => withCache({ cacheHandler: "./x.mjs" })).toThrow(/already sets/);
    expect(() => withCache({ cacheHandlers: { default: "./x.mjs" } })).toThrow(/already sets/);
  });

  test("a function-form config is wrapped: the user's config is kept, sync or async", async () => {
    const sync = withCache((phase: string) => ({ cacheComponents: true, env: { phase } }));
    const fromSync = await sync("phase-production-server", { defaultConfig: {} });
    expect(fromSync.env).toEqual({ phase: "phase-production-server" });
    expect(fromSync.cacheComponents).toBe(true);
    expect(basename(fromSync.cacheHandlers.remote)).toBe("remote.js");

    const asyncConfig = withCache(async () => ({ basePath: "/docs" }));
    const fromAsync = await asyncConfig("phase-development-server", { defaultConfig: {} });
    expect(fromAsync.basePath).toBe("/docs");
    expect(fromAsync.cacheMaxMemorySize).toBe(0);
  });

  test("keeps an explicit cacheMaxMemorySize, warning when it is not 0", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(withCache({ cacheMaxMemorySize: 0 }).cacheMaxMemorySize).toBe(0);
    expect(warn).not.toHaveBeenCalled();
    expect(withCache({ cacheMaxMemorySize: 1024 }).cacheMaxMemorySize).toBe(1024);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cacheMaxMemorySize"));
    warn.mockRestore();
  });
});

describe("withCache memory", () => {
  afterEach(resetCacheState);

  test("hands memory to the runtime in this process, over the environment", () => {
    process.env.CACHE_MEMORY_MAX_MIB = "980";
    withCache({}, { memory: { maxMiB: 49 } });
    expect(getCacheRuntime().stores.local.maxBytes).toBe(16 * 1024 * 1024);
  });

  test("without memory, the environment decides again", () => {
    withCache({}, { memory: { maxMiB: 49 } });
    withCache({});
    expect(process.env[MEMORY_OPTIONS_ENV]).toBeUndefined();
    process.env.CACHE_MEMORY_MAX_MIB = "98";
    expect(getCacheRuntime().stores.local.maxBytes).toBe(32 * 1024 * 1024);
  });

  test.each([{ heapPercent: 0 }, { heapPercent: 100 }, { maxMiB: -1 }, { maxMiB: Number.NaN }])(
    "rejects memory %o when the config loads",
    (memory) => {
      expect(() => withCache({}, { memory })).toThrow(/withCache memory\.(heapPercent|maxMiB)/);
    },
  );

  test("rejects an unknown memory key", () => {
    expect(() => withCache({}, { memory: { maxMib: 64 } as never })).toThrow(
      'unknown memory option "maxMib"',
    );
  });

  test("warns that a standalone server.js does not see it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    withCache({ output: "standalone" }, { memory: { heapPercent: 20 } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CACHE_MEMORY_HEAP_PERCENT"));
    warn.mockClear();
    withCache({ output: "standalone" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
