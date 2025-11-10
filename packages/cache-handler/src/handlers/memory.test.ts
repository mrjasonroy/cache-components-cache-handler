import { beforeEach, describe, expect, test } from "vitest";
import type { CacheValue } from "../types.js";
import { type MemoryCacheHandler, createMemoryCacheHandler } from "./memory.js";

describe("MemoryCacheHandler", () => {
  let handler: MemoryCacheHandler;

  beforeEach(() => {
    handler = createMemoryCacheHandler();
  });

  describe("basic operations", () => {
    test("should store and retrieve values", async () => {
      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "content-type": "application/json" },
          body: '{"test": true}',
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await handler.set("test-key", value);
      const result = await handler.get("test-key");

      expect(result).toEqual(value);
    });

    test("should return null for non-existent keys", async () => {
      const result = await handler.get("non-existent");
      expect(result).toBeNull();
    });

    test("should delete entries", async () => {
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
      await handler.delete("test-key");
      const result = await handler.get("test-key");

      expect(result).toBeNull();
    });

    test("should clear all entries", async () => {
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

      await handler.set("key1", value);
      await handler.set("key2", value);
      await handler.clear();

      expect(await handler.get("key1")).toBeNull();
      expect(await handler.get("key2")).toBeNull();
      expect(handler.getStats().size).toBe(0);
    });
  });

  describe("LRU eviction", () => {
    test("should evict oldest entry when max size reached", async () => {
      const smallHandler = createMemoryCacheHandler({ maxItemsNumber: 2 });

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

      await smallHandler.set("key1", value);
      await smallHandler.set("key2", value);
      await smallHandler.set("key3", value); // Should evict key1

      expect(await smallHandler.get("key1")).toBeNull();
      expect(await smallHandler.get("key2")).not.toBeNull();
      expect(await smallHandler.get("key3")).not.toBeNull();
    });

    test("should move accessed entries to end (LRU behavior)", async () => {
      const smallHandler = createMemoryCacheHandler({ maxItemsNumber: 2 });

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

      await smallHandler.set("key1", value);
      await smallHandler.set("key2", value);

      // Access key1 to move it to the end
      await smallHandler.get("key1");

      // Add key3, should evict key2 (not key1)
      await smallHandler.set("key3", value);

      expect(await smallHandler.get("key1")).not.toBeNull();
      expect(await smallHandler.get("key2")).toBeNull();
      expect(await smallHandler.get("key3")).not.toBeNull();
    });

    test("should skip oversized entries", async () => {
      const smallHandler = createMemoryCacheHandler({ maxItemSizeBytes: 100 });

      const largeValue: CacheValue = {
        kind: "FETCH",
        data: {
          headers: {},
          body: "x".repeat(200), // Definitely over 100 bytes when serialized
          status: 200,
          url: "https://example.com",
        },
        revalidate: false,
      };

      await smallHandler.set("large-key", largeValue);
      const result = await smallHandler.get("large-key");

      expect(result).toBeNull();
      expect(smallHandler.getStats().size).toBe(0);
    });
  });

  describe("TTL and expiration", () => {
    test("should expire entries based on revalidate time", async () => {
      const value: CacheValue = {
        kind: "PAGE",
        html: "<html>test</html>",
        pageData: { test: true },
      };

      // Set with 1 second TTL
      await handler.set("test-key", value, { revalidate: 1 });

      // Should exist immediately
      expect(await handler.get("test-key")).not.toBeNull();

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be expired
      expect(await handler.get("test-key")).toBeNull();
    });

    test("should not expire entries with revalidate: false", async () => {
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

      await handler.set("test-key", value, { revalidate: false });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should still exist
      expect(await handler.get("test-key")).not.toBeNull();
    });

    test("should use defaultTTL when revalidate is undefined", async () => {
      const handlerWithTTL = createMemoryCacheHandler({ defaultTTL: 1 });

      const value: CacheValue = {
        kind: "PAGE",
        html: "<html>test</html>",
        pageData: { test: true },
      };

      await handlerWithTTL.set("test-key", value); // No context = use default TTL

      // Should exist immediately
      expect(await handlerWithTTL.get("test-key")).not.toBeNull();

      // Wait for expiration
      await new Promise((resolve) => setTimeout(resolve, 1100));

      // Should be expired
      expect(await handlerWithTTL.get("test-key")).toBeNull();
    });
  });

  describe("tag-based revalidation", () => {
    test("should revalidate entries by explicit tag", async () => {
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

      await handler.set("key1", value, { tags: ["tag1", "tag2"] });
      await handler.set("key2", value, { tags: ["tag2", "tag3"] });
      await handler.set("key3", value, { tags: ["tag3"] });

      // Revalidate tag2
      await handler.revalidateTag("tag2");

      // key1 and key2 should be deleted
      expect(await handler.get("key1")).toBeNull();
      expect(await handler.get("key2")).toBeNull();
      // key3 should still exist
      expect(await handler.get("key3")).not.toBeNull();
    });

    test("should handle implicit tags via meta parameter", async () => {
      const value: CacheValue = {
        kind: "PAGE",
        html: "<html>test</html>",
        pageData: { test: true },
      };

      await handler.set("test-key", value, {
        tags: ["explicit-tag"],
        revalidate: false,
      });

      // Entry should exist without implicit tags
      expect(await handler.get("test-key")).not.toBeNull();

      // Wait a tiny bit to ensure lastModified timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Revalidate implicit tag
      await handler.revalidateTag("_N_T_/page");

      // Entry should still exist when checked without implicit tags
      expect(await handler.get("test-key")).not.toBeNull();

      // Now check with implicit tag in meta - should be deleted
      const resultWithImplicitTag = await handler.get("test-key", {
        implicitTags: ["_N_T_/page"],
      });

      // Should be null because implicit tag was revalidated after entry was created
      expect(resultWithImplicitTag).toBeNull();
    });

    test("should track revalidation timestamps", async () => {
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

      await handler.set("test-key", value, { tags: ["test-tag"] });

      // Wait a bit
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Revalidate tag
      await handler.revalidateTag("test-tag");

      // Entry created before revalidation should be deleted
      expect(await handler.get("test-key")).toBeNull();

      // New entry with same tag should be valid
      await handler.set("test-key-2", value, { tags: ["test-tag"] });
      expect(await handler.get("test-key-2")).not.toBeNull();
    });
  });

  describe("stats", () => {
    test("should return correct stats", async () => {
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

      await handler.set("key1", value);
      await handler.set("key2", value, { tags: ["tag1"] });
      await handler.revalidateTag("tag1");

      const stats = handler.getStats();

      expect(stats.maxSize).toBe(1000); // default
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.revalidatedTags).toBeGreaterThan(0);
    });
  });

  describe("handler name", () => {
    test("should have correct name", () => {
      expect(handler.name).toBe("local-lru");
    });
  });
});
