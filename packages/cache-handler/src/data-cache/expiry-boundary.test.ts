import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { createRemoteCacheHandler } from "./remote.js";
import type { DataCacheEntry } from "./types.js";

describe("remote data entry render-start expiry", () => {
  beforeEach(async () => {
    await resetCacheState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetCacheState();
  });

  describe.each(["memory", "redis", "outage"] as const)("%s", (lane) => {
    // Memory and outage fallback currently serve past expire after rounding the remaining TTL up.
    const check = lane === "redis" ? test : test.fails;
    check("never serves past expire when rendering finishes between whole seconds", async () => {
      const redis = new FakeRedis();
      const handler = createRemoteCacheHandler(
        lane === "memory" ? {} : { client: asClient(redis) },
      );
      if (lane === "outage") {
        vi.spyOn(console, "error").mockImplementation(() => {});
        vi.spyOn(console, "warn").mockImplementation(() => {});
        // Establish the connection before taking it down mid-render.
        await handler.get("entry", []);
      }
      const started = Date.now();
      let finish!: (entry: DataCacheEntry) => void;
      const writing = handler.set(
        "entry",
        new Promise<DataCacheEntry>((resolve) => {
          finish = resolve;
        }),
      );
      vi.setSystemTime(started + 250);
      if (lane === "outage") redis.goDown();
      finish({
        value: new Response("rendered before expiry").body as ReadableStream<Uint8Array>,
        timestamp: started,
        tags: [],
        stale: 0,
        revalidate: 1,
        expire: 2,
      });
      await writing;

      // SWR remains allowed after revalidate, but only until the render's hard deadline.
      vi.setSystemTime(started + 1_999);
      const stale = await handler.get("entry", []);
      expect(stale?.timestamp).toBe(started);
      expect(await new Response(stale?.value).text()).toBe("rendered before expiry");

      vi.setSystemTime(started + 2_001);
      expect(await handler.get("entry", [])).toBeUndefined();
    });
  });
});
