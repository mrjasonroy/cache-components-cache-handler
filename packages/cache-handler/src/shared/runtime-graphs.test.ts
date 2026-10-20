/**
 * Next can load the package into more than one module graph in a process. The runtime registry
 * is on `globalThis`, so every graph must name a connection the same way: a graph must never get
 * the runtime of another connection.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FakeRedis } from "../testing/fake-redis.js";

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
    return function Redis() {
      return new FakeRedis();
    };
  },
}));

import { resetCacheState } from "../testing/env.js";

describe("runtimes across module graphs", () => {
  beforeEach(resetCacheState);
  afterEach(resetCacheState);

  test("two graphs, two connections: each connection gets its own runtime in both", async () => {
    vi.resetModules();
    const graphA = await import("./runtime.js");
    const a1 = graphA.getCacheRuntime({ url: "redis://one:6379", keyPrefix: "app:" });
    const a2 = graphA.getCacheRuntime({ url: "redis://two:6379", keyPrefix: "app:" });
    expect(a1.connection).not.toBe(a2.connection);

    vi.resetModules();
    const graphB = await import("./runtime.js");
    expect(graphB).not.toBe(graphA);
    // Graph B sees the second connection first.
    const b2 = graphB.getCacheRuntime({ url: "redis://two:6379", keyPrefix: "app:" });
    const b1 = graphB.getCacheRuntime({ url: "redis://one:6379", keyPrefix: "app:" });
    expect(b2.connection).toBe(a2.connection);
    expect(b2).toBe(a2);
    expect(b1.connection).toBe(a1.connection);
    expect(b1).toBe(a1);
  });
});
