import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CacheValue } from "../types.js";

/**
 * In-memory fake Redis for testing the ISR RedisCacheHandler.
 * Mimics the ioredis API surface used by the handler.
 */
class FakeRedis {
  private readonly store = new Map<string, { value: string; ttl?: number }>();
  private readonly sets = new Map<string, Set<string>>();
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string): Promise<string> {
    this.store.set(key, { value });
    return "OK";
  }

  async setex(key: string, ttl: number, value: string): Promise<string> {
    this.store.set(key, { value, ttl });
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }
    return count;
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
        added++;
      }
    }
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  pipeline() {
    const ops: Array<() => Promise<unknown>> = [];
    const self = this;
    return {
      sadd(key: string, ...members: string[]) {
        ops.push(() => self.sadd(key, ...members));
        return this;
      },
      expire(key: string, seconds: number) {
        ops.push(() => self.expire(key, seconds));
        return this;
      },
      del(...keys: string[]) {
        ops.push(() => self.del(...keys));
        return this;
      },
      async exec() {
        const results = [];
        for (const op of ops) {
          results.push([null, await op()]);
        }
        return results;
      },
    };
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = [];
      this.listeners.set(event, handlers);
    }
    handlers.push(handler);
    return this;
  }

  public quitCalled = false;

  async quit(): Promise<string> {
    this.quitCalled = true;
    return "OK";
  }
}

// Mock ioredis to return our FakeRedis
let fakeRedis: FakeRedis;

vi.mock("ioredis", () => {
  function FakeRedisProxy() {
    return fakeRedis;
  }
  FakeRedisProxy.prototype = {};
  return {
    default: FakeRedisProxy,
    Redis: FakeRedisProxy,
  };
});

// Import after mocking
const { RedisCacheHandler } = await import("./redis.js");

describe("RedisCacheHandler", () => {
  beforeEach(() => {
    fakeRedis = new FakeRedis();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("APP_PAGE serialization (fixes #15)", () => {
    test("should round-trip APP_PAGE with segmentData Map and rscData Buffer", async () => {
      const handler = new RedisCacheHandler();

      const segmentData = new Map<string, Buffer>([
        ["/layout", Buffer.from("layout-rsc-payload")],
        ["/page", Buffer.from("page-rsc-payload")],
      ]);

      const value: CacheValue = {
        kind: "APP_PAGE",
        html: "<html><body>Hello</body></html>",
        rscData: Buffer.from("full-rsc-data"),
        headers: { "content-type": "text/html" },
        postponed: undefined,
        status: 200,
        segmentData,
      };

      await handler.set("app-page-key", value, { revalidate: false });
      const result = await handler.get("app-page-key");

      expect(result).not.toBeNull();
      expect(result?.value).not.toBeNull();

      const retrieved = result?.value as CacheValue & { kind: "APP_PAGE" };
      expect(retrieved.kind).toBe("APP_PAGE");
      expect(retrieved.html).toBe("<html><body>Hello</body></html>");

      // segmentData should be restored as a Map
      expect(retrieved.segmentData).toBeInstanceOf(Map);
      expect(retrieved.segmentData?.size).toBe(2);
      expect(retrieved.segmentData?.get("/layout")).toBeInstanceOf(Buffer);
      expect(retrieved.segmentData?.get("/layout")?.toString()).toBe("layout-rsc-payload");
      expect(retrieved.segmentData?.get("/page")?.toString()).toBe("page-rsc-payload");

      // rscData should be restored as a Buffer
      expect(Buffer.isBuffer(retrieved.rscData)).toBe(true);
      expect(retrieved.rscData?.toString()).toBe("full-rsc-data");
    });

    test("should handle APP_PAGE with undefined segmentData", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "APP_PAGE",
        html: "<html>No segments</html>",
        rscData: undefined,
        headers: undefined,
        postponed: undefined,
        status: 200,
        segmentData: undefined,
      };

      await handler.set("no-segments", value, { revalidate: false });
      const result = await handler.get("no-segments");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "APP_PAGE" };
      expect(retrieved.kind).toBe("APP_PAGE");
      // undefined becomes null through JSON round-trip, both are falsy
      expect(retrieved.segmentData).toBeFalsy();
      expect(retrieved.rscData).toBeFalsy();
    });

    test("should handle APP_PAGE with empty segmentData Map", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "APP_PAGE",
        html: "<html>Empty segments</html>",
        rscData: Buffer.from(""),
        headers: undefined,
        postponed: undefined,
        status: 200,
        segmentData: new Map(),
      };

      await handler.set("empty-segments", value, { revalidate: false });
      const result = await handler.get("empty-segments");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "APP_PAGE" };
      expect(retrieved.segmentData).toBeInstanceOf(Map);
      expect(retrieved.segmentData?.size).toBe(0);
    });

    test("should handle backward-compat with Node Buffer JSON format", async () => {
      const handler = new RedisCacheHandler();

      // Simulate an entry stored with plain JSON.stringify (before the fix)
      // Buffer.toJSON() produces { type: "Buffer", data: [bytes...] }
      const oldEntry = {
        lastModified: Date.now(),
        lifespan: null,
        tags: [],
        value: {
          kind: "IMAGE",
          etag: "abc",
          upstreamEtag: "upstream-abc",
          buffer: { type: "Buffer", data: [104, 101, 108, 108, 111] },
          extension: "png",
        },
      };

      // Manually store the old-format entry
      await fakeRedis.set("nextjs:cache:old-buffer", JSON.stringify(oldEntry));

      const result = await handler.get("old-buffer");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "IMAGE" };
      expect(retrieved.kind).toBe("IMAGE");
      expect(Buffer.isBuffer(retrieved.buffer)).toBe(true);
      expect(retrieved.buffer.toString()).toBe("hello");
    });
  });

  describe("APP_ROUTE serialization", () => {
    test("should round-trip APP_ROUTE with Buffer body", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "APP_ROUTE",
        body: Buffer.from('{"message":"ok"}'),
        status: 200,
        headers: { "content-type": "application/json" },
      };

      await handler.set("api-route", value, { revalidate: false });
      const result = await handler.get("api-route");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "APP_ROUTE" };
      expect(retrieved.kind).toBe("APP_ROUTE");
      expect(Buffer.isBuffer(retrieved.body)).toBe(true);
      expect(retrieved.body.toString()).toBe('{"message":"ok"}');
    });
  });

  describe("existing value types still work", () => {
    test("should round-trip FETCH values", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "content-type": "application/json" },
          body: '{"test": true}',
          status: 200,
          url: "https://example.com",
        },
        revalidate: 60,
      };

      await handler.set("fetch-key", value, { revalidate: false });
      const result = await handler.get("fetch-key");

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(value);
    });

    test("should round-trip PAGES values", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "PAGES",
        html: "<html>test</html>",
        pageData: { props: { test: true } },
        status: 200,
      };

      await handler.set("page-key", value, { revalidate: false });
      const result = await handler.get("page-key");

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(value);
    });

    test("should round-trip IMAGE values with Buffer", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "IMAGE",
        etag: "abc123",
        upstreamEtag: "upstream-abc123",
        buffer: Buffer.from("fake-image-data"),
        extension: "png",
      };

      await handler.set("image-key", value, { revalidate: false });
      const result = await handler.get("image-key");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "IMAGE" };
      expect(retrieved.kind).toBe("IMAGE");
      expect(retrieved.etag).toBe("abc123");
      expect(retrieved.upstreamEtag).toBe("upstream-abc123");
      expect(Buffer.isBuffer(retrieved.buffer)).toBe(true);
      expect(retrieved.buffer.toString()).toBe("fake-image-data");
    });

    test("should round-trip REDIRECT values", async () => {
      const handler = new RedisCacheHandler();

      const value: CacheValue = {
        kind: "REDIRECT",
        props: { destination: "/new-page", permanent: true },
      };

      await handler.set("redirect-key", value, { revalidate: false });
      const result = await handler.get("redirect-key");

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(value);
    });
  });

  describe("binary data round-trip", () => {
    test("should preserve non-UTF8 binary data in Buffers", async () => {
      const handler = new RedisCacheHandler();
      const binaryData = Buffer.from([0x00, 0xff, 0x80, 0xde, 0xad, 0xbe, 0xef, 0x01]);

      const value: CacheValue = {
        kind: "APP_PAGE",
        html: "<html>binary test</html>",
        rscData: binaryData,
        headers: undefined,
        postponed: undefined,
        status: 200,
        segmentData: new Map<string, Buffer>([
          ["/binary-segment", Buffer.from([0x00, 0x01, 0xfe, 0xff])],
        ]),
      };

      await handler.set("binary-key", value, { revalidate: false });
      const result = await handler.get("binary-key");

      expect(result).not.toBeNull();
      const retrieved = result?.value as CacheValue & { kind: "APP_PAGE" };

      // rscData should be byte-for-byte identical
      expect(Buffer.isBuffer(retrieved.rscData)).toBe(true);
      expect(retrieved.rscData).toEqual(binaryData);

      // segmentData buffer should be byte-for-byte identical
      const segBuf = retrieved.segmentData?.get("/binary-segment");
      expect(Buffer.isBuffer(segBuf)).toBe(true);
      expect(segBuf).toEqual(Buffer.from([0x00, 0x01, 0xfe, 0xff]));
    });
  });

  describe("backward compatibility", () => {
    test("should force cache miss for old APP_PAGE entries with plain object segmentData", async () => {
      const handler = new RedisCacheHandler();

      // Simulate an old entry stored before the Map serialization fix.
      // JSON.stringify(new Map([...])) produces "{}", so segmentData is
      // a plain empty object after deserialization.
      const oldEntry = {
        lastModified: Date.now(),
        lifespan: null,
        tags: [],
        value: {
          kind: "APP_PAGE",
          html: "<html>old format</html>",
          rscData: null,
          headers: null,
          postponed: null,
          status: 200,
          segmentData: {},
        },
      };

      await fakeRedis.set("nextjs:cache:old-app-page", JSON.stringify(oldEntry));
      const result = await handler.get("old-app-page");

      // Should return null (cache miss) instead of corrupt data
      expect(result).toBeNull();

      // The old entry should have been deleted from Redis
      const rawData = await fakeRedis.get("nextjs:cache:old-app-page");
      expect(rawData).toBeNull();
    });
  });

  describe("existing Redis client support", () => {
    test("should accept an existing Redis client instance", async () => {
      const handler = new RedisCacheHandler({
        redis: fakeRedis as unknown as import("ioredis").default,
      });

      const value: CacheValue = {
        kind: "FETCH",
        data: {
          headers: { "content-type": "application/json" },
          body: '{"shared": true}',
          status: 200,
          url: "https://example.com",
        },
        revalidate: 60,
      };

      await handler.set("shared-key", value, { revalidate: false });
      const result = await handler.get("shared-key");

      expect(result).not.toBeNull();
      expect(result?.value).toEqual(value);
    });

    test("should not add error listener for existing client", async () => {
      const listenersBefore = fakeRedis.listeners.get("error")?.length ?? 0;

      new RedisCacheHandler({
        redis: fakeRedis as unknown as import("ioredis").default,
      });

      const listenersAfter = fakeRedis.listeners.get("error")?.length ?? 0;
      expect(listenersAfter).toBe(listenersBefore);
    });

    test("should add error listener for internally created client", async () => {
      new RedisCacheHandler();

      const errorListeners = fakeRedis.listeners.get("error")?.length ?? 0;
      expect(errorListeners).toBeGreaterThan(0);
    });

    test("should not close shared client on close()", async () => {
      const handler = new RedisCacheHandler({
        redis: fakeRedis as unknown as import("ioredis").default,
      });

      await handler.close();
      expect(fakeRedis.quitCalled).toBe(false);
    });

    test("should close internally created client on close()", async () => {
      const handler = new RedisCacheHandler();

      await handler.close();
      expect(fakeRedis.quitCalled).toBe(true);
    });
  });
});
