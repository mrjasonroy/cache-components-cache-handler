import { basename } from "node:path";
import { afterEach, expect, test } from "vitest";
import { resetCacheState } from "../testing/env.js";
import { withCache } from "./with-cache.js";

afterEach(resetCacheState);

test("omitted and explicit memory keep the default routing identical", () => {
  expect(withCache({}, { useCache: "memory" })).toEqual(withCache({}));
  expect(basename(withCache({}).cacheHandlers.default)).toBe("default.js");
});

test("Redis routing survives a function config and standalone serialization", async () => {
  const config = await withCache(async () => ({ output: "standalone" }), { useCache: "redis" })(
    "phase-production-server",
    { defaultConfig: {} },
  );
  expect(JSON.parse(JSON.stringify(config)).cacheHandlers.default).toBe(
    config.cacheHandlers.remote,
  );
  expect(basename(config.cacheHandlers.default)).toBe("remote.js");
});

test("custom default wins and custom remote does not change plain use cache", () => {
  const config = withCache({}, { useCache: "redis", handlers: { remote: "/custom/remote.mjs" } });
  expect(basename(config.cacheHandlers.default)).toBe("remote.js");
  expect(config.cacheHandlers.remote).toBe("/custom/remote.mjs");
  expect(
    withCache({}, { useCache: "redis", handlers: { default: "/custom/default.mjs" } }).cacheHandlers
      .default,
  ).toBe("/custom/default.mjs");
});

test.each(["Redis", "", false, null, 1])(
  "rejects invalid storage %s before loading config",
  (useCache) => {
    expect(() => withCache(() => ({}), { useCache } as never)).toThrow(/useCache must be/);
  },
);
