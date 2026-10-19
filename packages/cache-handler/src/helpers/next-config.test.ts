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

  test("createCacheConfig omits cacheHandler when no isrHandlerPath is given", () => {
    const config = createCacheConfig({ dataCacheHandlerPath: "/tmp/data.mjs" });

    expect(config).not.toHaveProperty("cacheHandler");
  });

  test("isrHandlerPath is passed through as cacheHandler", () => {
    const config = createCacheConfig({
      isrHandlerPath: "/tmp/isr.mjs",
      dataCacheHandlerPath: "/tmp/data.mjs",
    });
    const withProfiles = createCacheConfigWithProfiles({
      isrHandlerPath: "/tmp/isr.mjs",
      defaultDataCacheHandlerPath: "/tmp/memory.mjs",
      remoteDataCacheHandlerPath: "/tmp/redis.mjs",
    });

    expect(config.cacheHandler).toBe("/tmp/isr.mjs");
    expect(withProfiles.cacheHandler).toBe("/tmp/isr.mjs");
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
