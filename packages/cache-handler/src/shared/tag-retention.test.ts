import { describe, expect, test, vi } from "vitest";
import { asClient } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { getClientConnection } from "./connection.js";
import {
  TAG_MAINTENANCE_INTERVAL_MS,
  probeTagFieldExpiry,
  supportsTagFieldExpiry,
} from "./tag-retention.js";
import { TagStore } from "./tag-store.js";

describe("tag field expiry capability", () => {
  test.each([
    { reply: [["hpexpireat"]], supported: true },
    { reply: [null], supported: false },
    { reply: undefined, supported: false },
  ])("detects support once: $supported", async ({ reply, supported }) => {
    const call = vi.fn().mockResolvedValue(reply);
    const client = Object.assign(new FakeRedis(), { call });
    const connection = getClientConnection(asClient(client));
    expect(supportsTagFieldExpiry(connection)).toBe(false);
    await Promise.all([probeTagFieldExpiry(connection), probeTagFieldExpiry(connection)]);
    expect(supportsTagFieldExpiry(connection)).toBe(supported);
    expect(call).toHaveBeenCalledTimes(1);
    await probeTagFieldExpiry(connection);
    expect(call).toHaveBeenCalledTimes(1);
  });

  test("a field-expiry rejection after detection switches later writes to fallback", async () => {
    const client = Object.assign(new FakeRedis(), {
      call: vi.fn().mockResolvedValue([["hpexpireat"]]),
    });
    const connection = getClientConnection(asClient(client));
    await probeTagFieldExpiry(connection);
    const evaluate = vi.spyOn(client, "eval").mockResolvedValueOnce(-1);
    const tags = new TagStore(connection, "failover:");
    try {
      await tags.update(["a"]);
      expect(evaluate).toHaveBeenCalled();
      expect(supportsTagFieldExpiry(connection)).toBe(false);
      await tags.update(["b"]);
      expect(await client.hmget("failover:tags", "b")).not.toEqual([null]);
    } finally {
      tags.dispose();
    }
  });

  test("an ACL error or unknown command chooses fallback without throwing", async () => {
    const call = vi.fn().mockRejectedValue(new Error("unknown command"));
    const connection = getClientConnection(asClient(Object.assign(new FakeRedis(), { call })));
    await probeTagFieldExpiry(connection);
    expect(supportsTagFieldExpiry(connection)).toBe(false);
  });
});

describe("background maintenance", () => {
  test("Cluster without field TTLs skips pruning and rate limits its warning", async () => {
    const client = Object.assign(new FakeRedis(), {
      nodes: () => [],
      call: vi.fn().mockResolvedValue([null]),
    });
    const logger = { error: vi.fn(), warn: vi.fn() };
    const tags = new TagStore(getClientConnection(asClient(client)), "cluster:", {
      logger: () => logger,
    });
    try {
      await tags.maintain();
      await tags.maintain();
      expect(client.commands).not.toContain("eval");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(logger.warn.mock.calls)).toContain("grow until a flush");
    } finally {
      tags.dispose();
    }
  });

  test("CROSSSLOT disables later prune attempts without affecting tag updates", async () => {
    const client = new FakeRedis();
    const evaluate = vi
      .spyOn(client, "eval")
      .mockRejectedValueOnce(new Error("CROSSSLOT Keys in request don't hash to the same slot"));
    const logger = { error: vi.fn(), warn: vi.fn() };
    const tags = new TagStore(getClientConnection(asClient(client)), "cross:", {
      logger: () => logger,
    });
    try {
      await tags.maintain();
      await tags.maintain();
      expect(evaluate).toHaveBeenCalledTimes(1);
      await tags.update(["still-works"]);
      expect(tags.get("still-works")).toBeDefined();
    } finally {
      tags.dispose();
    }
  });

  test("the timer is off the request path, unreferenced, and stopped on dispose", async () => {
    vi.useFakeTimers();
    const tags = new TagStore(getClientConnection(asClient(new FakeRedis())), "timer:");
    const maintain = vi.spyOn(tags, "maintain").mockResolvedValue();
    try {
      await tags.update(["tag"]);
      await tags.sync();
      expect(maintain).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(TAG_MAINTENANCE_INTERVAL_MS);
      expect(maintain).toHaveBeenCalledTimes(1);
      tags.dispose();
      await vi.advanceTimersByTimeAsync(TAG_MAINTENANCE_INTERVAL_MS);
      expect(maintain).toHaveBeenCalledTimes(1);
    } finally {
      tags.dispose();
      vi.useRealTimers();
    }
  });
});
