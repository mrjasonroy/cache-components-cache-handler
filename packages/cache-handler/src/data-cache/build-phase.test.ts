import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PHASE_PRODUCTION_BUILD } from "../shared/env.js";
import { resetCacheState } from "../testing/env.js";
import type { DataCacheEntry, DataCacheHandler } from "./types.js";

function entry(text: string): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Response(text).body as ReadableStream<Uint8Array>,
    tags: ["products"],
    stale: 300,
    timestamp: Date.now(),
    expire: 31536000,
    revalidate: 900,
  });
}

async function read(result: DataCacheEntry | undefined): Promise<string | undefined> {
  return result ? new Response(result.value).text() : undefined;
}

/**
 * The module Next loads for a `cacheHandlers` entry, evaluated fresh as in a build worker.
 */
async function loadEntry(name: "default" | "remote"): Promise<DataCacheHandler> {
  vi.resetModules();
  const module =
    name === "default"
      ? await import("../entries/default.js")
      : await import("../entries/remote.js");
  return module.default;
}

// `next build` prerenders a "use cache" route twice: the final render must find, within one
// task, what the prospective render cached. A build-phase miss makes the route dynamic.
describe.each(["default", "remote"] as const)("the %s entry during next build", (name) => {
  beforeEach(async () => {
    await resetCacheState();
    process.env.NEXT_PHASE = PHASE_PRODUCTION_BUILD;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
  });

  afterEach(resetCacheState);

  test("serves what it cached, as Next's request order runs it", async () => {
    const handler = await loadEntry(name);
    await handler.refreshTags();
    expect(await handler.get("k", [])).toBeUndefined();
    await handler.set("k", entry("at buildtime"));

    await handler.refreshTags();
    expect(await handler.getExpiration(["products"])).toBe(0);
    expect(await read(await handler.get("k", []))).toBe("at buildtime");
  });

  test("answers the final render's reads before the next task", async () => {
    const handler = await loadEntry(name);
    await handler.set("k", entry("at buildtime"));

    const reads = (async () => {
      await handler.refreshTags();
      const result = await handler.get("k", ["_N_T_/routes"]);
      await handler.getExpiration(["_N_T_/routes"]);
      return result;
    })();
    const nextTask = new Promise<"next task">((resolve) =>
      setImmediate(() => resolve("next task")),
    );
    expect(await Promise.race([reads, nextTask])).not.toBe("next task");
  });
});
