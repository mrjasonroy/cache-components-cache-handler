import { describe, expect, test } from "vitest";
import { createCacheConfig, createCacheConfigWithProfiles } from "./next-config.js";

describe("next-config helpers", () => {
  test("createCacheConfig points default and remote at the same handler", () => {
    const config = createCacheConfig({
      dataCacheHandlerPath: "/tmp/data-cache-handler.mjs",
    });

    expect(config).toEqual({
      cacheHandlers: {
        default: "/tmp/data-cache-handler.mjs",
        remote: "/tmp/data-cache-handler.mjs",
      },
      cacheMaxMemorySize: 0,
    });
  });

  test("createCacheConfig does not emit the legacy ISR cacheHandler key", () => {
    const config = createCacheConfig({ dataCacheHandlerPath: "/tmp/data.mjs" });

    expect(config).not.toHaveProperty("cacheHandler");
  });

  test("createCacheConfigWithProfiles allows custom default and remote handlers", () => {
    const config = createCacheConfigWithProfiles({
      defaultDataCacheHandlerPath: "/tmp/memory-handler.mjs",
      remoteDataCacheHandlerPath: "/tmp/redis-handler.mjs",
    });

    expect(config).toEqual({
      cacheHandlers: {
        default: "/tmp/memory-handler.mjs",
        remote: "/tmp/redis-handler.mjs",
      },
      cacheMaxMemorySize: 0,
    });
  });

  test("helpers keep default memory cache when disableDefaultMemoryCache is false", () => {
    const config = createCacheConfig({
      dataCacheHandlerPath: "/tmp/data.mjs",
      disableDefaultMemoryCache: false,
    });

    expect(config.cacheMaxMemorySize).toBeUndefined();
  });
});
