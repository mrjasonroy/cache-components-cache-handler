import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { flushCache } from "./flush.js";
import { FLUSH_TAG, buildFlushTag, tagIndexKey, tagsKey } from "./keys.js";
import { getCacheRuntime } from "./runtime.js";
import { escapeGlob } from "./scan.js";

/**
 * A Cluster stand-in: `nodes("master")` and a per-node pipeline. Keys in `migrating` answer the
 * node pipeline with `-MOVED`, as during a slot migration; the cluster's own `unlink` follows the
 * redirection unless the key is also in `stuck`.
 */
class FakeCluster {
  readonly migrating = new Set<string>();
  readonly stuck = new Set<string>();
  constructor(readonly masters: FakeRedis[]) {}
  async unlink(key: string): Promise<number> {
    if (this.stuck.has(key)) throw new Error("Too many Cluster redirections. Last error: MOVED");
    let count = 0;
    for (const node of this.masters) count += await node.unlink(key);
    return count;
  }
  nodes(_role: "master") {
    return this.masters.map((node) =>
      Object.assign(node, {
        pipeline: () => {
          const ops: Promise<[Error | null, number]>[] = [];
          const pipeline = {
            unlink: (key: string) => {
              ops.push(
                this.migrating.has(key)
                  ? Promise.resolve([new Error("MOVED 3999 127.0.0.1:7001"), 0])
                  : node.unlink(key).then((count) => [null, count]),
              );
              return pipeline;
            },
            exec: async () => Promise.all(ops),
          };
          return pipeline;
        },
      }),
    );
  }
  status = "ready";
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  removeListener() {
    return this;
  }
  // The tag keys' slot is on the first master.
  evalsha(...args: Parameters<FakeRedis["evalsha"]>) {
    return this.masters[0].evalsha(...args);
  }
  eval(...args: Parameters<FakeRedis["eval"]>) {
    return this.masters[0].eval(...args);
  }
  zadd(...args: Parameters<FakeRedis["zadd"]>) {
    return this.masters[0].zadd(...args);
  }
}

/** Keys other than the tag records the flush writes afterwards. */
function entryKeys(fake: FakeRedis, prefix = "app:"): string[] {
  return [...fake.items.keys()]
    .filter((key) => key !== tagsKey(prefix) && key !== tagIndexKey(prefix))
    .sort();
}

async function seed(fake: FakeRedis) {
  await fake.set("app:b1:page:/a", "x");
  await fake.set("app:b1:data:k", "x");
  await fake.set("app:b2:page:/a", "x");
  await fake.hset("app:tags", { products: "1,1" });
  await fake.set("other:b1:page:/a", "x");
}

describe("flushCache", () => {
  beforeEach(async () => {
    await resetCacheState();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("scope build deletes the build's entries only", async () => {
    const fake = new FakeRedis();
    await seed(fake);
    const result = await flushCache({ client: asClient(fake), keyPrefix: "app:", buildId: "b1" });
    expect(result.deleted).toBe(2);
    expect(entryKeys(fake)).toEqual(["app:b2:page:/a", "other:b1:page:/a"]);
    expect(await fake.hmget("app:tags", "products")).toEqual(["1,1"]);
  });

  test("scope all deletes everything under the prefix, tag records included", async () => {
    const fake = new FakeRedis();
    await seed(fake);
    const result = await flushCache({ client: asClient(fake), keyPrefix: "app:", scope: "all" });
    expect(result.deleted).toBe(4);
    expect(entryKeys(fake)).toEqual(["other:b1:page:/a"]);
    expect(await fake.hmget("app:tags", "products")).toEqual([null]);
  });

  test("a flush is recorded afterwards as a tag revalidation: a barrier for the build output", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const fake = new FakeRedis();
    await seed(fake);
    await flushCache({ client: asClient(fake), keyPrefix: "app:", scope: "all" });
    await flushCache({ client: asClient(fake), keyPrefix: "app:", buildId: "b1" });
    vi.useRealTimers();

    expect(await fake.hmget("app:tags", FLUSH_TAG, buildFlushTag("b1"))).toEqual([
      "1000000,1000000",
      "1000000,1000000",
    ]);
    expect(await fake.zrangebyscore("app:tag-index", "-inf", "+inf")).toEqual([
      FLUSH_TAG,
      buildFlushTag("b1"),
    ]);
  });

  test("glob characters in the prefix match literally", async () => {
    const fake = new FakeRedis();
    await fake.set("a*:b1:page:/x", "x");
    await fake.set("ab:b1:page:/x", "x");
    expect(escapeGlob("a*[?]\\")).toBe("a\\*\\[\\?\\]\\\\");
    await flushCache({ client: asClient(fake), keyPrefix: "a*:", scope: "all" });
    expect(entryKeys(fake, "a*:")).toEqual(["ab:b1:page:/x"]);
  });

  test("a Cluster: every master is scanned and keys are unlinked one per command", async () => {
    const one = new FakeRedis();
    const two = new FakeRedis();
    await seed(one);
    await one.set("app:b1:page:/b", "x");
    await two.set("app:b1:page:/c", "x");
    const cluster = new FakeCluster([one, two]);
    const result = await flushCache({
      client: cluster as unknown as import("ioredis").Cluster,
      keyPrefix: "app:",
      buildId: "b1",
    });
    expect(result.deleted).toBe(4);
    expect(one.commands.filter((c) => c === "unlink")).toHaveLength(3);
  });

  test("a Cluster: a key answered with -MOVED mid-flush is unlinked through the cluster", async () => {
    const one = new FakeRedis();
    await one.set("app:b1:page:/a", "x");
    await one.set("app:b1:page:/b", "x");
    const cluster = new FakeCluster([one]);
    cluster.migrating.add("app:b1:page:/b");
    const result = await flushCache({
      client: cluster as unknown as import("ioredis").Cluster,
      keyPrefix: "app:",
      buildId: "b1",
    });
    expect(result).toEqual({ deleted: 2 });
    expect(entryKeys(one)).toEqual([]);
  });

  test("a Cluster: a key that still fails after redirection makes the result partial", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const one = new FakeRedis();
    await one.set("app:b1:page:/a", "x");
    await one.set("app:b1:page:/b", "x");
    const cluster = new FakeCluster([one]);
    cluster.migrating.add("app:b1:page:/b");
    cluster.stuck.add("app:b1:page:/b");
    const result = await flushCache({
      client: cluster as unknown as import("ioredis").Cluster,
      keyPrefix: "app:",
      buildId: "b1",
    });
    expect(result).toEqual({ deleted: 1, partial: true, failed: 1 });
    expect(entryKeys(one)).toEqual(["app:b1:page:/b"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("partial"));
  });

  test("without Redis it empties process memory and counts those entries", async () => {
    const runtime = getCacheRuntime({});
    runtime.stores.local.set("a", 1, 1, null);
    runtime.stores.page.set("b", 1, 1, null);
    expect(await flushCache()).toEqual({ deleted: 2 });
    expect(runtime.stores.local.size).toBe(0);
    expect(runtime.tags.get(buildFlushTag("development"))).toBeDefined();
  });

  test("throws when Redis is configured but down, and keeps process memory", async () => {
    const fake = new FakeRedis();
    const runtime = getCacheRuntime({ client: asClient(fake) });
    runtime.stores.local.set("a", 1, 1, null);
    fake.goDown();
    await expect(flushCache({ client: asClient(fake) })).rejects.toThrow(/unavailable/);
    expect(runtime.stores.local.size).toBe(1);
  });

  test('refuses scope "all" with an empty prefix: it would delete the whole database', async () => {
    const fake = new FakeRedis();
    await fake.set("someone-else", "x");
    await expect(
      flushCache({ client: asClient(fake), keyPrefix: "", scope: "all" }),
    ).rejects.toThrow(/empty keyPrefix/);
    expect(await fake.exists("someone-else")).toBe(1);
  });
});
