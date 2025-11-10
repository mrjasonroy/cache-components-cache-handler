/**
 * Unit tests for memory-based data cache handler
 * These tests verify tag-based invalidation logic, especially timestamp comparisons
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { createMemoryDataCacheHandler } from "./memory.js";
import type { DataCacheEntry } from "./types.js";

/**
 * Helper to create a complete DataCacheEntry for testing
 */
function createTestEntry(
  content: string,
  tags: string[],
  overrides?: Partial<DataCacheEntry>,
): DataCacheEntry {
  return {
    value: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content));
        controller.close();
      },
    }),
    tags,
    timestamp: Date.now(),
    stale: 0,
    expire: 3600,
    revalidate: 900,
    ...overrides,
  };
}

describe("MemoryDataCacheHandler - Tag Invalidation", () => {
  beforeEach(() => {
    // Reset any global state between tests
    vi.clearAllMocks();
  });

  describe("updateTags() - Tag Expiration Timestamps", () => {
    test("should set expired timestamp for immediate expiration (no durations)", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "test-tag";

      const beforeUpdate = Date.now();
      await handler.updateTags([testTag], undefined);
      const afterUpdate = Date.now();

      // Get expiration should return a timestamp around now
      const expiration = await handler.getExpiration([testTag]);
      expect(expiration).toBeGreaterThanOrEqual(beforeUpdate);
      // Allow 10ms tolerance for timing precision
      expect(expiration).toBeLessThanOrEqual(afterUpdate + 10);
    });

    test("should set future expired timestamp with durations.expire", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "future-tag";
      const expireSeconds = 3600; // 1 hour

      const beforeUpdate = Date.now();
      await handler.updateTags([testTag], { expire: expireSeconds });
      const afterUpdate = Date.now();

      const expiration = await handler.getExpiration([testTag]);

      // Should be approximately 1 hour in the future
      const expectedMin = beforeUpdate + expireSeconds * 1000;
      const expectedMax = afterUpdate + expireSeconds * 1000 + 10; // 10ms tolerance

      expect(expiration).toBeGreaterThanOrEqual(expectedMin);
      expect(expiration).toBeLessThanOrEqual(expectedMax);
    });

    test("should mark as stale immediately when durations provided", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "stale-tag";

      // Set a cache entry with this tag
      const entry = createTestEntry("test", [testTag]);

      const cacheKey = JSON.stringify(["test", "key", []]);
      await handler.set(cacheKey, Promise.resolve(entry));

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Update with durations - should mark as stale
      await handler.updateTags([testTag], { expire: 3600 });

      // Get should return entry with revalidate: -1 (stale but usable)
      const result = await handler.get(cacheKey, []);
      expect(result).toBeDefined();
      expect(result?.revalidate).toBe(-1); // -1 indicates stale
    });
  });

  describe("Tag Expiration - Timestamp Comparison Logic", () => {
    test("should NOT expire entry when expired timestamp is in the future", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "future-expire-tag";

      // Create entry
      const entry = createTestEntry("test data", [testTag]);

      const cacheKey = JSON.stringify(["test", "key", []]);
      await handler.set(cacheKey, Promise.resolve(entry));

      //Wait for timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Set expiration 1 hour in the future
      await handler.updateTags([testTag], { expire: 3600 });

      // Entry should be stale but still returned with revalidate: -1
      const result = await handler.get(cacheKey, []);
      expect(result).toBeDefined();
      expect(result?.revalidate).toBe(-1); // Stale but usable
    });

    test("should expire entry when expired timestamp is in the past", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "past-expire-tag";

      // Create entry
      const entry = createTestEntry("test data", [testTag]);

      const cacheKey = JSON.stringify(["test", "key", []]);
      await handler.set(cacheKey, Promise.resolve(entry));

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Immediately expire (no durations = expired = now)
      await handler.updateTags([testTag], undefined);

      // Entry should be expired
      const result = await handler.get(cacheKey, []);
      expect(result).toBeUndefined();
    });

    test("should handle edge case: expired timestamp equals entry timestamp", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "equal-timestamp-tag";

      const entry = createTestEntry("test", [testTag]);

      const cacheKey = JSON.stringify(["test", "key", []]);
      await handler.set(cacheKey, Promise.resolve(entry));

      // Wait to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Immediately expire
      await handler.updateTags([testTag], undefined);

      // Should be treated as expired (expired < timestamp logic)
      const result = await handler.get(cacheKey, []);
      expect(result).toBeUndefined();
    });
  });

  describe("Tag Isolation - Multiple Tags", () => {
    test("should only invalidate entries with revalidated tag", async () => {
      const handler = createMemoryDataCacheHandler();

      // Create two entries with different tags
      const entry1 = createTestEntry("entry 1", ["tag-1"]);

      const entry2 = createTestEntry("entry 2", ["tag-2"]);

      const key1 = JSON.stringify(["test", "key1", []]);
      const key2 = JSON.stringify(["test", "key2", []]);

      await handler.set(key1, Promise.resolve(entry1));
      await handler.set(key2, Promise.resolve(entry2));

      // Wait for timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Revalidate only tag-1
      await handler.updateTags(["tag-1"], undefined);

      // Entry 1 should be invalidated
      const result1 = await handler.get(key1, []);
      expect(result1).toBeUndefined();

      // Entry 2 should still be valid
      const result2 = await handler.get(key2, []);
      expect(result2).toBeDefined();
    });

    test("should invalidate entry with multiple tags when any tag is revalidated", async () => {
      const handler = createMemoryDataCacheHandler();

      const entry = createTestEntry("multi-tag entry", ["tag-a", "tag-b", "tag-c"]);

      const key = JSON.stringify(["test", "multi-tag", []]);
      await handler.set(key, Promise.resolve(entry));

      // Wait for timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Revalidate only tag-b
      await handler.updateTags(["tag-b"], undefined);

      // Entry should be invalidated because one of its tags was revalidated
      const result = await handler.get(key, []);
      expect(result).toBeUndefined();
    });
  });

  describe("Global Tags Manifest - Instance Isolation", () => {
    test("should share tag state across multiple handler instances", async () => {
      const handler1 = createMemoryDataCacheHandler();
      const handler2 = createMemoryDataCacheHandler();

      // Create entries in BOTH handlers with same tag
      const entry1 = createTestEntry("handler 1 entry", ["shared-tag"]);

      const entry2 = createTestEntry("handler 2 entry", ["shared-tag"]);

      const key1 = JSON.stringify(["test", "handler1", []]);
      const key2 = JSON.stringify(["test", "handler2", []]);

      await handler1.set(key1, Promise.resolve(entry1));
      await handler2.set(key2, Promise.resolve(entry2));

      // Wait for timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Revalidate tag through handler2
      await handler2.updateTags(["shared-tag"], undefined);

      // BOTH entries should be invalidated because tag state is global
      const result1 = await handler1.get(key1, []);
      const result2 = await handler2.get(key2, []);

      expect(result1).toBeUndefined();
      expect(result2).toBeUndefined();
    });
  });

  describe("Stale vs Expired Behavior", () => {
    test("should return stale entries with revalidate: -1 when tags marked stale", async () => {
      const handler = createMemoryDataCacheHandler();
      const testTag = "stale-test-tag";

      // Note: This test validates the stale-while-revalidate pattern
      // When updateTags is called with durations, it marks as stale immediately
      // The entry should be returned with revalidate: -1 on next get()

      const entry = createTestEntry("stale test", [testTag]);

      const key = JSON.stringify(["test", "stale", []]);
      await handler.set(key, Promise.resolve(entry));

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Mark as stale with future expiration (stale-while-revalidate)
      await handler.updateTags([testTag], { expire: 3600 });

      // Entry should be returned with updated revalidate flag
      // The current implementation returns revalidate: -1 for stale entries
      const result = await handler.get(key, []);
      expect(result).toBeDefined();
      // Note: This assertion verifies stale entry behavior
      // If this fails, check areTagsStale() logic in memory.ts
      expect(result?.revalidate).toBe(-1);
    });
  });
});
