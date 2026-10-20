import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLocalCacheHandler } from "../data-cache/local.js";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import type { DataCacheEntry } from "../data-cache/types.js";
import { RedisCacheHandler } from "../handlers/redis.js";
import { BLOG, OTHER, appPageCtx, writeBuildOutput } from "../testing/build-output.js";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";

const VALUE = "x".repeat(1_000);

function entry(): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(VALUE).body as ReadableStream<Uint8Array>,
    tags: ["products"],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

/** The size fields logged for each `get` and `set` call. */
function loggedSizes(debug: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return debug.mock.calls
    .filter((call) => call[1] === "get" || call[1] === "set")
    .map((call) => {
      const sizes = call.find(
        (arg): arg is Record<string, unknown> =>
          typeof arg === "object" && arg !== null && "bytes" in arg,
      );
      return { op: call[1], ...(sizes ?? {}) };
    });
}

describe("CACHE_DEBUG logs each value's size", () => {
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await resetCacheState();
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("page handler: the encoded size on set and get", async () => {
    const handler = new RedisCacheHandler({ client: asClient(new FakeRedis()), debug: true });
    const page = { kind: "APP_PAGE", html: VALUE, headers: {}, status: 200 };
    await handler.set("/blog", page, { cacheControl: { revalidate: 60 } });
    await handler.get("/blog", { kind: "APP_PAGE" });

    const sizes = loggedSizes(debug);
    expect(sizes).toEqual([
      expect.objectContaining({ op: "set", bytes: expect.any(Number) }),
      expect.objectContaining({ op: "get", bytes: expect.any(Number) }),
    ]);
    expect(sizes[0].bytes).toBeGreaterThan(VALUE.length);
    expect(sizes[1].bytes).toBe(sizes[0].bytes);
  });

  test("page handler: the encoded size when build output is written through, to Redis or memory", async () => {
    const build = writeBuildOutput();
    for (const client of [asClient(new FakeRedis()), undefined]) {
      await resetCacheState();
      debug.mockClear();
      const handler = new RedisCacheHandler({
        client,
        fs: build.fs,
        serverDistDir: build.serverDistDir,
        debug: true,
      });
      await handler.get(BLOG, appPageCtx);

      const sizes = loggedSizes(debug);
      expect(sizes).toEqual([
        expect.objectContaining({ op: "get", bytes: expect.any(Number) }),
        expect.objectContaining({ op: "set", bytes: expect.any(Number) }),
      ]);
      expect(sizes[1].bytes).toBe(sizes[0].bytes);
    }
    rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
  });

  test("page handler: why a route is not served from its build output", async () => {
    const build = writeBuildOutput({ stamp: false, routes: { "/blog": { revalidate: 60 } } });
    const handler = new RedisCacheHandler({
      client: asClient(new FakeRedis()),
      fs: build.fs,
      serverDistDir: build.serverDistDir,
      debug: true,
    });
    await handler.get(BLOG, appPageCtx);
    await handler.get(OTHER, appPageCtx);

    const reasons = debug.mock.calls.map((call) => call.slice(1, 4).join(" "));
    expect(reasons).toContain(`get ${BLOG} no build output (time-based route, no build stamp)`);
    expect(reasons).toContain(`get ${OTHER} no build output (route not in the prerender manifest)`);
    rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
  });

  test("remote handler: the value's bytes and its encoded size in Redis, on set and get", async () => {
    const handler = createRemoteCacheHandler({ client: asClient(new FakeRedis()), debug: true });
    await handler.set("k", entry());
    await handler.get("k", []);

    const sizes = loggedSizes(debug);
    expect(sizes).toEqual([
      expect.objectContaining({ op: "set", bytes: VALUE.length }),
      expect.objectContaining({ op: "get", bytes: VALUE.length }),
    ]);
    expect(sizes[0].encodedBytes).toBeGreaterThan(VALUE.length);
    expect(sizes[1].encodedBytes).toBe(sizes[0].encodedBytes);
  });

  test("local handler: the value's bytes on set and get", async () => {
    const handler = createLocalCacheHandler({ debug: true });
    await handler.set("k", entry());
    await handler.get("k", []);

    expect(loggedSizes(debug)).toEqual([
      expect.objectContaining({ op: "set", bytes: VALUE.length }),
      expect.objectContaining({ op: "get", bytes: VALUE.length }),
    ]);
  });
});
