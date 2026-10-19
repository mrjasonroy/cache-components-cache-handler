import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import type { CacheHandlerGetResult, CacheValue } from "../types.js";
import { type MemoryCacheHandler, createMemoryCacheHandler } from "./memory.js";
import { RedisCacheHandler } from "./redis.js";

/**
 * Tests for Issue #12: Wrong return value and type for cache handler
 * https://github.com/mrjasonroy/cache-components-cache-handler/issues/12
 *
 * Next.js expects cache handlers to return an object with { value, lastModified, age }
 * instead of just the value directly.
 */

describe("CacheHandler return type (Issue #12)", () => {
  describe("MemoryCacheHandler", () => {
    let handler: MemoryCacheHandler;

    beforeEach(() => {
      handler = createMemoryCacheHandler();
    });

    test("should return object with value, lastModified, and age properties", async () => {
      const cacheValue: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "content-type": "application/json" },
          body: '{"test": true}',
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("test-key", cacheValue);
      const result = await handler.get("test-key");

      // Should return an object, not null
      expect(result).not.toBeNull();

      // Should have the correct structure
      expect(result).toHaveProperty("value");
      expect(result).toHaveProperty("lastModified");
      expect(result).toHaveProperty("age");

      // Value should match what was stored
      expect(result?.value).toEqual(cacheValue);

      // lastModified should be a number (timestamp)
      expect(typeof result?.lastModified).toBe("number");
      expect(result?.lastModified).toBeGreaterThan(0);

      // age should be a number (milliseconds since lastModified)
      expect(typeof result?.age).toBe("number");
      expect(result?.age).toBeGreaterThanOrEqual(0);
    });

    test("should return null for cache miss (not an object with null value)", async () => {
      const result = await handler.get("non-existent");

      // Should return null, not { value: null }
      expect(result).toBeNull();
    });

    test("should return correct structure for FETCH kind", async () => {
      const fetchValue: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "x-custom": "header" },
          body: "response body",
          status: 200,
          url: "https://api.example.com/data",
        },
        revalidate: 3600,
      };

      await handler.set("fetch-key", fetchValue);
      const result = await handler.get("fetch-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("FETCH");
      if (result?.value?.kind === "FETCH") {
        expect(result.value.data.body).toBe("response body");
        expect(result.value.revalidate).toBe(3600);
      }
    });

    test("should return correct structure for PAGES kind", async () => {
      const pageValue: CacheValue = {
        kind: "PAGES",
        html: "<html><body>Test Page</body></html>",
        pageData: { title: "Test" },
      };

      await handler.set("page-key", pageValue);
      const result = await handler.get("page-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("PAGES");
      if (result?.value?.kind === "PAGES") {
        expect(result.value.html).toContain("Test Page");
        expect(result.value.pageData).toEqual({ title: "Test" });
      }
    });

    test("should return correct structure for APP_ROUTE kind", async () => {
      const routeValue: CacheValue = {
        kind: "APP_ROUTE",
        body: Buffer.from("Route content"),
        status: 200,
        headers: { "content-type": "text/html" },
      };

      await handler.set("route-key", routeValue);
      const result = await handler.get("route-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("APP_ROUTE");
    });

    test("should return correct structure for IMAGE kind", async () => {
      const imageValue: CacheValue = {
        kind: "IMAGE",
        etag: "abc123",
        upstreamEtag: "upstream-abc123",
        buffer: Buffer.from("image data"),
        extension: "png",
      };

      await handler.set("image-key", imageValue);
      const result = await handler.get("image-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("IMAGE");
    });

    test("age should increase over time", async () => {
      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: {},
          body: "test",
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("test-key", value);

      // Get immediately
      const result1 = await handler.get("test-key");
      const age1 = result1?.age ?? 0;

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Get again
      const result2 = await handler.get("test-key");
      const age2 = result2?.age ?? 0;

      // Age should have increased
      expect(age2).toBeGreaterThan(age1);
    });

    test("lastModified should remain constant across multiple gets", async () => {
      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: {},
          body: "test",
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("test-key", value);

      const result1 = await handler.get("test-key");
      const lastModified1 = result1?.lastModified;

      await new Promise((resolve) => setTimeout(resolve, 50));

      const result2 = await handler.get("test-key");
      const lastModified2 = result2?.lastModified;

      // lastModified should be the same (entry wasn't modified)
      expect(lastModified1).toBe(lastModified2);
    });
  });

  describe("RedisCacheHandler", () => {
    // Next 16 computes staleness from `lastModified` and the cache control; it no longer reads
    // `age`, so the page handler returns `{ value, lastModified, cacheControl? }`.
    let handler: RedisCacheHandler;

    beforeEach(async () => {
      await resetCacheState();
      handler = new RedisCacheHandler({ client: asClient(new FakeRedis()) });
    });

    afterEach(async () => {
      await resetCacheState();
    });

    test("should return object with value and lastModified", async () => {
      const cacheValue: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "content-type": "application/json" },
          body: '{"redis": true}',
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("redis-test-key", cacheValue, { fetchCache: true, tags: [] });
      const result = await handler.get("redis-test-key", { kind: "FETCH" });

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(cacheValue);
      expect(typeof result?.lastModified).toBe("number");

      await handler.delete("redis-test-key");
    });

    test("should return null for cache miss", async () => {
      expect(await handler.get("non-existent-redis-key", { kind: "FETCH" })).toBeNull();
    });
  });

  describe("TypeScript type checking", () => {
    test("return type should be assignable to CacheHandlerGetResult", async () => {
      const handler = createMemoryCacheHandler();

      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: {},
          body: "test",
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("test-key", value);

      // This should type-check correctly
      const result: CacheHandlerGetResult | null = await handler.get("test-key");

      expect(result).not.toBeNull();

      if (result) {
        // TypeScript should know these properties exist
        const v: CacheValue | null = result.value;
        const lm: number | undefined = result.lastModified;
        const age: number | undefined = result.age;

        expect(v).toBeDefined();
        expect(lm).toBeDefined();
        expect(age).toBeDefined();
      }
    });
  });
});
