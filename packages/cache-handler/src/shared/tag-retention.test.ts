import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { asClient } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { getClientConnection } from "./connection.js";
import {
  PRUNE_TAGS_SCRIPT,
  PRUNE_TAGS_SHA,
  TAG_MAINTENANCE_INTERVAL_MS,
  probeTagFieldExpiry,
  retryTagFieldProbeOnReady,
  supportsTagFieldExpiry,
} from "./tag-retention.js";
import { TagStore } from "./tag-store.js";
import { UPDATE_EXPIRING_TAGS_SHA } from "./tag-update.js";

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

  test("only a connection-ready event permits a bounded retry after a transient probe failure", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("Command timed out"))
      .mockResolvedValue([["hpexpireat"]]);
    const connection = getClientConnection(asClient(Object.assign(new FakeRedis(), { call })));
    await probeTagFieldExpiry(connection);
    await probeTagFieldExpiry(connection);
    expect(call).toHaveBeenCalledTimes(1);
    expect(supportsTagFieldExpiry(connection)).toBe(false);
    retryTagFieldProbeOnReady(connection);
    await probeTagFieldExpiry(connection);
    expect(call).toHaveBeenCalledTimes(2);
    expect(supportsTagFieldExpiry(connection)).toBe(true);
  });

  test("an ACL error or unknown command chooses fallback without throwing", async () => {
    const call = vi.fn().mockRejectedValue(new Error("unknown command"));
    const connection = getClientConnection(asClient(Object.assign(new FakeRedis(), { call })));
    await probeTagFieldExpiry(connection);
    expect(supportsTagFieldExpiry(connection)).toBe(false);
  });
});

describe("background maintenance", () => {
  test("maintenance script SHA1 matches", () => {
    expect(createHash("sha1").update(PRUNE_TAGS_SCRIPT).digest("hex")).toBe(PRUNE_TAGS_SHA);
  });

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

  test("startup writes use guarded expiry and the prompt probe runs without waiting a minute", async () => {
    vi.useFakeTimers();
    const call = vi.fn().mockResolvedValue([["hpexpireat"]]);
    const client = Object.assign(new FakeRedis(), { call });
    const evaluate = vi.spyOn(client, "evalsha");
    const tags = new TagStore(getClientConnection(asClient(client)), "startup:");
    try {
      await tags.update(["before-probe"]);
      expect(evaluate.mock.calls[0][0]).toBe(UPDATE_EXPIRING_TAGS_SHA);
      expect(call).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      tags.dispose();
      vi.useRealTimers();
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
