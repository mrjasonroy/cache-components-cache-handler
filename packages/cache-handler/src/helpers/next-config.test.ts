import { describe, expect, test } from "vitest";
import { createCacheConfig, createCacheConfigWithProfiles } from "./next-config.js";

describe("next-config helpers", () => {
  test("createCacheConfig builds configuration for single handler", () => {
    const config = createCacheConfig({
      isrHandlerPath: "/tmp/isr-handler.mjs",
      dataCacheHandlerPath: "/tmp/data-cache-handler.mjs",
    });

    expect(config).toEqual({
      cacheHandler: "/tmp/isr-handler.mjs",
      cacheHandlers: {
        default: "/tmp/data-cache-handler.mjs",
        remote: "/tmp/data-cache-handler.mjs",
      },
      cacheMaxMemorySize: 0,
    });
  });

  test("createCacheConfigWithProfiles allows custom default and remote handlers", () => {
    const config = createCacheConfigWithProfiles({
      isrHandlerPath: "/tmp/isr-handler.mjs",
      defaultDataCacheHandlerPath: "/tmp/memory-handler.mjs",
      remoteDataCacheHandlerPath: "/tmp/redis-handler.mjs",
    });

    expect(config).toEqual({
      cacheHandler: "/tmp/isr-handler.mjs",
      cacheHandlers: {
        default: "/tmp/memory-handler.mjs",
        remote: "/tmp/redis-handler.mjs",
      },
      cacheMaxMemorySize: 0,
    });
  });

  test("helpers keep default memory cache when disableDefaultMemoryCache is false", () => {
    const config = createCacheConfig({
      isrHandlerPath: "/tmp/isr.mjs",
      dataCacheHandlerPath: "/tmp/data.mjs",
      disableDefaultMemoryCache: false,
    });

    expect(config.cacheMaxMemorySize).toBeUndefined();
  });
});
