import { beforeEach, describe, expect, test } from "vitest";
import type { CacheHandlerGetResult, CacheValue } from "../types.js";
import { type MemoryCacheHandler, createMemoryCacheHandler } from "./memory.js";
import { type RedisCacheHandler, RedisCacheHandler as RedisCacheHandlerClass } from "./redis.js";

/**
 * Fake Redis implementation for testing
 * Implements the subset of ioredis methods used by RedisCacheHandler
 */
class FakeRedis {
  private readonly store = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, value);
    return "OK";
  }

  async setex(key: string, _ttl: number, value: string): Promise<string> {
    this.store.set(key, value);
    // Note: TTL is ignored in this simple mock
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.store.delete(key) || this.sets.delete(key)) {
        deleted += 1;
      }
    }
    return deleted;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    let set = this.sets.get(key);
    if (!set) {
      set = new Set();
      this.sets.set(key, set);
    }
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) {
        set.add(member);
        added += 1;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    const set = this.sets.get(key);
    return set ? Array.from(set) : [];
  }

  async expire(key: string, _seconds: number): Promise<number> {
    // Note: TTL is ignored in this simple mock
    return this.store.has(key) || this.sets.has(key) ? 1 : 0;
  }

  pipeline() {
    const operations: Array<() => Promise<unknown>> = [];

    return {
      sadd: (key: string, member: string) => {
        operations.push(async () => {
          let set = this.sets.get(key);
          if (!set) {
            set = new Set();
            this.sets.set(key, set);
          }
          const added = !set.has(member);
          set.add(member);
          return added ? 1 : 0;
        });
        return this;
      },
      expire: (key: string, _seconds: number) => {
        operations.push(async () => {
          return this.store.has(key) || this.sets.has(key) ? 1 : 0;
        });
        return this;
      },
      del: (...keys: string[]) => {
        operations.push(async () => {
          let deleted = 0;
          for (const key of keys) {
            if (this.store.delete(key) || this.sets.delete(key)) {
              deleted += 1;
            }
          }
          return deleted;
        });
        return this;
      },
      exec: async () => {
        const results = await Promise.all(operations.map((op) => op()));
        return results.map((result) => [null, result]);
      },
    };
  }

  on(_event: string, _handler: (...args: unknown[]) => void) {
    // Mock event listener
    return this;
  }

  async quit(): Promise<string> {
    this.store.clear();
    this.sets.clear();
    return "OK";
  }
}

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

    test("should return correct structure for PAGE kind", async () => {
      const pageValue: CacheValue = {
        kind: "PAGE",
        html: "<html><body>Test Page</body></html>",
        pageData: { title: "Test" },
      };

      await handler.set("page-key", pageValue);
      const result = await handler.get("page-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("PAGE");
      if (result?.value?.kind === "PAGE") {
        expect(result.value.html).toContain("Test Page");
        expect(result.value.pageData).toEqual({ title: "Test" });
      }
    });

    test("should return correct structure for ROUTE kind", async () => {
      const routeValue: CacheValue = {
        kind: "ROUTE",
        html: "<div>Route content</div>",
        pageData: { route: "/test" },
        status: 200,
      };

      await handler.set("route-key", routeValue);
      const result = await handler.get("route-key");

      expect(result).not.toBeNull();
      expect(result?.value?.kind).toBe("ROUTE");
    });

    test("should return correct structure for IMAGE kind", async () => {
      const imageValue: CacheValue = {
        kind: "IMAGE",
        etag: "abc123",
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
    let handler: RedisCacheHandler;
    let redis: FakeRedis;

    beforeEach(() => {
      // Create FakeRedis mock and inject it into handler
      redis = new FakeRedis();
      handler = new RedisCacheHandlerClass({});
      // Directly replace the redis instance with our mock
      // biome-ignore lint/suspicious/noExplicitAny: Test mock requires access to private property
      (handler as any).redis = redis;
    });

    test("should return object with value, lastModified, and age properties", async () => {
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

      await handler.set("redis-test-key", cacheValue);
      const result = await handler.get("redis-test-key");

      // Should return an object, not null
      expect(result).not.toBeNull();

      // Should have the correct structure
      expect(result).toHaveProperty("value");
      expect(result).toHaveProperty("lastModified");
      expect(result).toHaveProperty("age");

      // Value should match what was stored
      expect(result?.value).toEqual(cacheValue);

      // lastModified should be a number
      expect(typeof result?.lastModified).toBe("number");

      // age should be a number
      expect(typeof result?.age).toBe("number");
      expect(result?.age).toBeGreaterThanOrEqual(0);

      // Cleanup
      await handler.delete("redis-test-key");
    });

    test("should return null for cache miss", async () => {
      const result = await handler.get("non-existent-redis-key");

      // Should return null, not { value: null }
      expect(result).toBeNull();
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
