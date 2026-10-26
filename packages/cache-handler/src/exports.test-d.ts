/**
 * The root exports that 16.4.2 users and custom handler files depend on: removing one fails here.
 */

import { describe, expectTypeOf, test } from "vitest";
import type * as Root from "./index.js";
import type { PageCacheHandlerOptions, RedisCacheHandlerOptions } from "./index.js";

describe("root exports", () => {
  test("RedisCacheHandlerOptions (16.4.2) is still exported, as PageCacheHandlerOptions", () => {
    expectTypeOf<RedisCacheHandlerOptions>().toEqualTypeOf<PageCacheHandlerOptions>();
    expectTypeOf<ConstructorParameters<typeof Root.RedisCacheHandler>[0]>().toEqualTypeOf<
      PageCacheHandlerOptions | undefined
    >();
  });

  test("createPageCacheHandler builds a RedisCacheHandler class", () => {
    expectTypeOf<ReturnType<typeof Root.createPageCacheHandler>>().toEqualTypeOf<
      typeof Root.RedisCacheHandler
    >();
  });

  test("the RC-only names are gone", () => {
    expectTypeOf<typeof Root>().not.toHaveProperty("createRedisCacheHandler");
    expectTypeOf<typeof Root>().not.toHaveProperty("MEMORY_ONLY_TAG");
    expectTypeOf<Root.WithCacheOptions>().not.toHaveProperty("useCache");
  });
});
