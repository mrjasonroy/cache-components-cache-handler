/**
 * Type test, checked by vitest's typecheck (`*.test-d.ts`): the page handler context, declared on
 * its own since 16.6, still takes everything the Next 14 `CacheHandlerOptions` did.
 */

import { describe, expectTypeOf, test } from "vitest";
import type { CacheHandlerOptions } from "../types.js";
import type { PageCacheHandlerContext } from "./page-types.js";

describe("PageCacheHandlerContext", () => {
  test("still takes every field of the Next 14 options, with the same types", () => {
    expectTypeOf<CacheHandlerOptions>().toMatchTypeOf<PageCacheHandlerContext>();
    expectTypeOf<PageCacheHandlerContext["_requestHeaders"]>().toEqualTypeOf<
      CacheHandlerOptions["_requestHeaders"]
    >();
    expectTypeOf<PageCacheHandlerContext["flushToDisk"]>().toEqualTypeOf<
      CacheHandlerOptions["flushToDisk"]
    >();
    expectTypeOf<PageCacheHandlerContext["_appDir"]>().toEqualTypeOf<
      CacheHandlerOptions["_appDir"]
    >();
    expectTypeOf<PageCacheHandlerContext["_pagesDir"]>().toEqualTypeOf<
      CacheHandlerOptions["_pagesDir"]
    >();
    expectTypeOf<PageCacheHandlerContext["experimental"]>().toEqualTypeOf<
      CacheHandlerOptions["experimental"]
    >();
  });
});
