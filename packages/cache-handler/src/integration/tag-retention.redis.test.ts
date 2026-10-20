/** Field TTLs on Redis 7.4+, atomic fallback on Valkey 8; executed only in CI. */
import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createLocalCacheHandler } from "../data-cache/local.js";
import { createRemoteCacheHandler } from "../data-cache/remote.js";
import { createRedisCacheHandler } from "../handlers/redis.js";
import { getClientConnection } from "../shared/connection.js";
import {
  FLUSH_TAG,
  MAX_ENTRY_AGE_SECONDS,
  buildFlushTag,
  tagIndexKey,
  tagsKey,
} from "../shared/keys.js";
import {
  PRUNE_TAGS_SCRIPT,
  PRUNE_TAGS_SHA,
  TAG_PRUNE_BATCH_SIZE,
  TAG_RETENTION_MS,
  probeTagFieldExpiry,
  supportsTagFieldExpiry,
} from "../shared/tag-retention.js";
import { TagStore } from "../shared/tag-store.js";
import { UPDATE_EXPIRING_TAGS_SCRIPT, updateArgs } from "../shared/tag-update.js";
import { resetCacheState } from "../testing/env.js";

const url = process.env.CACHE_TEST_REDIS_URL;
describe.runIf(Boolean(url))("tag retention (real Redis)", () => {
  let raw: Redis;
  let prefix: string;
  let stores: TagStore[];
  beforeAll(() => {
    raw = new Redis(url as string);
  });
  beforeEach(() => {
    prefix = `retention:${randomUUID()}:`;
    stores = [];
  });
  afterEach(async () => {
    for (const store of stores) store.dispose();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of await raw.keys(`${prefix}*`)) await raw.del(key);
    await resetCacheState();
  });
  afterAll(async () => {
    await raw.quit();
  });

  function store(client = raw): TagStore {
    const result = new TagStore(getClientConnection(client), prefix);
    stores.push(result);
    return result;
  }
  async function seed(fields: Record<string, string>, score: number): Promise<void> {
    await raw.hset(tagsKey(prefix), fields);
    await raw.zadd(tagIndexKey(prefix), ...Object.keys(fields).flatMap((tag) => [score, tag]));
  }

  test("CI exercises the required server capability, and writes a merged field deadline", async () => {
    const connection = getClientConnection(raw);
    await probeTagFieldExpiry(connection);
    const supported = supportsTagFieldExpiry(connection);
    if (process.env.CACHE_TEST_FIELD_TTLS !== undefined) {
      expect(supported).toBe(process.env.CACHE_TEST_FIELD_TTLS === "1");
    }
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const tags = store();
    await tags.update(["delayed"], { expire: MAX_ENTRY_AGE_SECONDS * 2 });
    if (supported) {
      expect(await raw.call("HPEXPIRETIME", tagsKey(prefix), "FIELDS", 1, "delayed")).toEqual([
        now + MAX_ENTRY_AGE_SECONDS * 2000 + TAG_RETENTION_MS,
      ]);
      // An older write that arrives later must reinstate the merged deadline after HSET.
      await raw.eval(
        UPDATE_EXPIRING_TAGS_SCRIPT,
        1,
        tagsKey(prefix),
        ...updateArgs(new Map([["delayed", { stale: now - 1, expired: now - 1 }]])),
      );
      expect(await raw.call("HPEXPIRETIME", tagsKey(prefix), "FIELDS", 1, "delayed")).toEqual([
        now + MAX_ENTRY_AGE_SECONDS * 2000 + TAG_RETENTION_MS,
      ]);
      await tags.update([FLUSH_TAG, buildFlushTag("old")]);
      expect(
        await raw.call(
          "HPEXPIRETIME",
          tagsKey(prefix),
          "FIELDS",
          2,
          FLUSH_TAG,
          buildFlushTag("old"),
        ),
      ).toEqual([-1, -1]);
      // Redis itself removes an eligible field; the harmless index member is cleaned later.
      const old = now - TAG_RETENTION_MS - 1000;
      await raw.eval(
        UPDATE_EXPIRING_TAGS_SCRIPT,
        1,
        tagsKey(prefix),
        ...updateArgs(new Map([["expired-field", { stale: old, expired: old }]])),
      );
      await raw.zadd(tagIndexKey(prefix), old, "expired-field");
      expect(await raw.hget(tagsKey(prefix), "expired-field")).toBeNull();
      const oldDeadline = now - TAG_RETENTION_MS - 1000;
      const delayedStale = oldDeadline - MAX_ENTRY_AGE_SECONDS * 1000;
      await raw.eval(
        UPDATE_EXPIRING_TAGS_SCRIPT,
        1,
        tagsKey(prefix),
        ...updateArgs(
          new Map([["expired-delayed", { stale: delayedStale, expired: oldDeadline }]]),
        ),
      );
      await raw.zadd(tagIndexKey(prefix), delayedStale, "expired-delayed");
      expect(await raw.hget(tagsKey(prefix), "expired-delayed")).toBeNull();
      await tags.maintain();
      expect(await raw.zscore(tagIndexKey(prefix), "expired-field")).toBeNull();
      expect(await raw.zscore(tagIndexKey(prefix), "expired-delayed")).toBeNull();
    } else {
      expect(await raw.hget(tagsKey(prefix), "delayed")).toBe(
        `${now},${now + MAX_ENTRY_AGE_SECONDS * 2000}`,
      );
      const old = now - TAG_RETENTION_MS - 1;
      await seed({ old: `${old},${old}` }, old);
      await tags.maintain();
      expect(await raw.hget(tagsKey(prefix), "old")).toBeNull();
    }
  });

  test("a fresh process writes a native TTL before its background probe, and HSET reinstates it", async () => {
    const client = new Redis(url as string);
    try {
      const tags = store(client);
      await tags.update(["startup"]);
      if (process.env.CACHE_TEST_FIELD_TTLS === "1") {
        const expiry = (await raw.call(
          "HPEXPIRETIME",
          tagsKey(prefix),
          "FIELDS",
          1,
          "startup",
        )) as number[];
        expect(expiry[0]).toBeGreaterThan(Date.now());
        await tags.update(["startup"]);
        const rewritten = (await raw.call(
          "HPEXPIRETIME",
          tagsKey(prefix),
          "FIELDS",
          1,
          "startup",
        )) as number[];
        expect(rewritten[0]).toBeGreaterThanOrEqual(expiry[0]);
      }
    } finally {
      client.disconnect();
    }
  });

  test("prunes old records and orphans; retains young, boundary, delayed, corrupt and flush records", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const cutoff = Date.now() - TAG_RETENTION_MS;
    const old = cutoff - 1;
    await seed(
      {
        old: `${old},${old}`,
        delayed: `${old},${Date.now() + MAX_ENTRY_AGE_SECONDS * 1000}`,
        [FLUSH_TAG]: `${old},${old}`,
        [buildFlushTag("old")]: `${old},${old}`,
        corrupt: "bad,record",
      },
      old,
    );
    await seed({ boundary: `${cutoff},${cutoff}` }, cutoff);
    await seed({ young: `${cutoff + 1},${cutoff + 1}` }, cutoff + 1);
    await raw.zadd(tagIndexKey(prefix), old, "orphan");
    await store().maintain();
    expect(await raw.hmget(tagsKey(prefix), "old", "orphan")).toEqual([null, null]);
    for (const tag of [
      "delayed",
      "young",
      "boundary",
      "corrupt",
      FLUSH_TAG,
      buildFlushTag("old"),
    ]) {
      expect(await raw.hget(tagsKey(prefix), tag), tag).not.toBeNull();
      expect(await raw.zscore(tagIndexKey(prefix), tag), tag).not.toBeNull();
    }
  });

  test("protected records cannot starve later candidates in a bounded pass", async () => {
    const old = Date.now() - TAG_RETENTION_MS - 1000;
    const barriers = Object.fromEntries(
      Array.from({ length: TAG_PRUNE_BATCH_SIZE }, (_, i) => [
        buildFlushTag(String(i)),
        `${old},${old}`,
      ]),
    );
    await seed(barriers, old);
    await seed({ later: `${old + 1},${old + 1}` }, old + 1);
    const tags = store();
    await tags.maintain();
    expect(await raw.hget(tagsKey(prefix), "later")).not.toBeNull();
    await tags.maintain();
    expect(await raw.hget(tagsKey(prefix), "later")).toBeNull();
    expect(await raw.hlen(tagsKey(prefix))).toBe(TAG_PRUNE_BATCH_SIZE);
  });

  test("concurrent updates survive either ordering and a hash write whose ZADD is in flight", async () => {
    const old = Date.now() - TAG_RETENTION_MS - 1000;
    const writer = new Redis(url as string);
    const pruner = new Redis(url as string);
    try {
      await Promise.all([writer.ping(), pruner.ping()]);
      await seed({ racing: `${old},${old}` }, old);
      let release = () => {};
      let held = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        held = resolve;
      });
      for (const name of ["eval", "evalsha"] as const) {
        const original = pruner[name].bind(pruner) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(pruner, name).mockImplementation((async (...args: unknown[]) => {
          if (args[0] === PRUNE_TAGS_SCRIPT || args[0] === PRUNE_TAGS_SHA) {
            held();
            await gate;
          }
          return original(...args);
        }) as never);
      }
      const maintenance = store(pruner).maintain();
      await started;
      await store(writer).update(["racing"]);
      release();
      await maintenance;
      expect(await raw.hget(tagsKey(prefix), "racing")).not.toBeNull();
      expect(Number(await raw.zscore(tagIndexKey(prefix), "racing"))).toBeGreaterThan(old);
      // Simulate the interval between the writer's HSET and ZADD.
      await seed({ partial: `${Date.now()},${Date.now()}` }, old);
      await store().maintain();
      expect(await raw.hget(tagsKey(prefix), "partial")).not.toBeNull();
      await seed({ after: `${old},${old}` }, old);
      await store().maintain();
      await store(writer).update(["after"]);
      expect(await raw.hget(tagsKey(prefix), "after")).not.toBeNull();
      expect(await raw.zscore(tagIndexKey(prefix), "after")).not.toBeNull();
    } finally {
      writer.disconnect();
      pruner.disconnect();
    }
  });

  test("an entry older than a pruned invalidation cannot be served by any handler", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const created = now - TAG_RETENTION_MS - 2000;
    vi.setSystemTime(created);
    const options = { client: raw, keyPrefix: prefix, buildId: "test" };
    const remote = createRemoteCacheHandler(options);
    const local = createLocalCacheHandler(options);
    const Page = createRedisCacheHandler(options);
    const page = new Page({});
    for (const handler of [remote, local]) {
      await handler.set(
        "old",
        Promise.resolve({
          value: new Response("old").body as ReadableStream<Uint8Array>,
          tags: ["old"],
          timestamp: created,
          stale: 0,
          revalidate: Number.POSITIVE_INFINITY,
          expire: Number.POSITIVE_INFINITY,
        }),
      );
    }
    await page.set(
      "old",
      {
        kind: "APP_ROUTE",
        body: Buffer.from("old"),
        status: 200,
        headers: { "x-next-cache-tags": "old" },
      },
      { cacheControl: { revalidate: false } },
    );
    vi.setSystemTime(created + 1);
    await store().update(["old"]);
    vi.setSystemTime(now);
    await store().maintain();
    expect(await raw.hget(tagsKey(prefix), "old")).toBeNull();
    expect(await remote.get("old", [])).toBeUndefined();
    expect(await local.get("old", [])).toBeUndefined();
    expect(await page.get("old", {})).toBeNull();
  });
});
