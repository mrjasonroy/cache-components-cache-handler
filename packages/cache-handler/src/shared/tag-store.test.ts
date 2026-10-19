import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { getClientConnection } from "./connection.js";
import { TAG_TTL_SECONDS, tagIndexKey, tagsKey } from "./keys.js";
import {
  SYNC_PAGE_SIZE,
  SYNC_SKEW_MS,
  TagStore,
  applyUpdate,
  decodeRecord,
  encodeRecord,
} from "./tag-store.js";

const PREFIX = "t:";

function storeOn(fake: FakeRedis): TagStore {
  return new TagStore(getClientConnection(asClient(fake)), PREFIX);
}

describe("applyUpdate", () => {
  test("no durations: stale and expired now", () => {
    expect(applyUpdate(undefined, 1000)).toEqual({ stale: 1000, expired: 1000 });
  });

  test("durations.expire: stale now, expired after expire seconds", () => {
    expect(applyUpdate(undefined, 1000, { expire: 5 })).toEqual({ stale: 1000, expired: 6000 });
  });
});

describe("TagStore", () => {
  beforeEach(async () => {
    await resetCacheState();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await resetCacheState();
  });

  test("check: fresh, stale (stale-until-expire), expired", async () => {
    const tags = new TagStore(undefined, PREFIX);
    const created = Date.now() - 10;
    expect(tags.check(["a"], created)).toBe("fresh");

    await tags.update(["a"], { expire: 60 });
    expect(tags.check(["a"], created)).toBe("stale");
    expect(tags.check(["a"], created, Date.now() + 61_000)).toBe("expired");

    await tags.update(["b"]);
    expect(tags.check(["a", "b"], created)).toBe("expired");
    // Created after the invalidation: unaffected.
    expect(tags.check(["b"], Date.now() + 1)).toBe("fresh");
  });

  test("an immediate revalidation from a writer whose clock runs ahead is expired, not stale", () => {
    const tags = new TagStore(undefined, PREFIX);
    const created = Date.now() - 10;
    // Merged as if read from Redis: written by an instance 5 s ahead.
    (tags as unknown as { merge(tag: string, record: object): void }).merge(
      "a",
      applyUpdate(undefined, Date.now() + 5_000),
    );
    expect(tags.check(["a"], created)).toBe("expired");
    // With durations, a future `expired` is still only stale.
    (tags as unknown as { merge(tag: string, record: object): void }).merge(
      "b",
      applyUpdate(undefined, Date.now() + 5_000, { expire: 60 }),
    );
    expect(tags.check(["b"], created)).toBe("stale");
  });

  test("getExpiration is the latest stale time of the tags, from local state only", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    expect(tags.getExpiration(["a"])).toBe(0);
    await tags.update(["a"], { expire: 100 });
    const commands = fake.commands.length;
    expect(tags.getExpiration(["a", "zzz"])).toBe(Date.now());
    expect(fake.commands.length).toBe(commands);
  });

  test("tag keys never fall under the legacy `nextjs:tags:<tag>` namespace", () => {
    // 16.5's RedisCacheHandler and createCacheHandler write `nextjs:tags:<tag>` (other types), so a
    // tag named "index" must not land on the index sorted set.
    for (const key of [tagsKey("nextjs:"), tagIndexKey("nextjs:")]) {
      expect(key.startsWith("nextjs:tags:")).toBe(false);
    }
  });

  test('records encode as "<stale>,<expired>" and decode back', () => {
    expect(encodeRecord({ stale: 1, expired: 2 })).toBe("1,2");
    expect(decodeRecord("1,2")).toEqual({ stale: 1, expired: 2 });
    expect(decodeRecord("1,")).toEqual({ stale: 1 });
    expect(decodeRecord(null)).toBeUndefined();
    expect(decodeRecord("x,y")).toBeUndefined();
  });

  test("an update of N tags is one HSET and one ZADD, plus the two TTLs", async () => {
    const fake = new FakeRedis();
    await storeOn(fake).update(["a", "b", "c"], { expire: 10 });
    expect(fake.commands.filter((c) => c !== "zrangebyscore").sort()).toEqual(
      ["expire", "expire", "hset", "zadd"].sort(),
    );
    expect(await fake.hmget(tagsKey(PREFIX), "a")).toEqual([
      `${Date.now()},${Date.now() + 10_000}`,
    ]);
    expect(await fake.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf", "WITHSCORES")).toEqual([
      "a",
      String(Date.now()),
      "b",
      String(Date.now()),
      "c",
      String(Date.now()),
    ]);
    expect(fake.ttlOf(tagsKey(PREFIX))).toBe(TAG_TTL_SECONDS);
    expect(fake.ttlOf(tagIndexKey(PREFIX))).toBe(TAG_TTL_SECONDS);
  });

  test("tags not updated for the tag TTL are removed from Redis, at most hourly", async () => {
    const fake = new FakeRedis();
    const old = Date.now() - TAG_TTL_SECONDS * 1000 - 1;
    await fake.hset(tagsKey(PREFIX), { old: `${old},${old}`, kept: `${Date.now()},` });
    await fake.zadd(tagIndexKey(PREFIX), old, "old", Date.now(), "kept");
    const tags = storeOn(fake);
    await tags.update(["new"]);
    expect(await fake.hmget(tagsKey(PREFIX), "old", "kept", "new")).toEqual([
      null,
      `${Date.now()},`,
      `${Date.now()},${Date.now()}`,
    ]);
    expect(await fake.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf")).toEqual(["kept", "new"]);

    // Within the hour, no prune query.
    fake.commands.length = 0;
    await tags.update(["other"]);
    expect(fake.commands).not.toContain("zrangebyscore");
  });

  test("identical updates in one synchronous run (Next's dispatch loop) write once", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    await Promise.all([tags.update(["a", "b"]), tags.update(["b", "a"]), tags.update(["a", "b"])]);
    expect(fake.commands.filter((c) => c === "hset")).toHaveLength(1);
    await tags.update(["a", "b"]);
    expect(fake.commands.filter((c) => c === "hset")).toHaveLength(2);
  });

  test("a second identical revalidation 20 ms later still invalidates entries written between", async () => {
    const tags = new TagStore(undefined, PREFIX);
    await tags.update(["a"]);
    vi.setSystemTime(Date.now() + 10);
    const writtenBetween = Date.now();
    vi.setSystemTime(Date.now() + 10);
    await tags.update(["a"]);
    expect(tags.check(["a"], writtenBetween)).toBe("expired");
  });

  test("sync copies another instance's invalidations, incrementally", async () => {
    const shared = new FakeRedis();
    const otherInstance = new FakeRedis(shared.items);
    const a = storeOn(shared);
    const b = storeOn(otherInstance);

    await a.update(["x"]);
    await b.sync();
    expect(b.get("x")).toEqual(a.get("x"));

    vi.setSystemTime(Date.now() + SYNC_SKEW_MS + 1_000);
    await a.update(["y"]);
    await b.sync();
    expect(b.get("y")).toBeDefined();

    vi.setSystemTime(Date.now() + SYNC_SKEW_MS + 1_000);
    await a.update(["z"]);
    const hmget = vi.spyOn(otherInstance, "hmget");
    await b.sync();
    expect(b.get("z")).toBeDefined();
    // One HMGET of "y" (inside the skew window of the last sync) and "z"; not "x".
    expect(hmget).toHaveBeenCalledTimes(1);
    expect(hmget.mock.calls[0]?.slice(1).sort()).toEqual(["y", "z"]);
  });

  test("sync re-reads entries inside the clock-skew window", async () => {
    const shared = new FakeRedis();
    const a = storeOn(shared);
    const b = storeOn(new FakeRedis(shared.items));
    await a.update(["x"]);
    await b.sync();
    // A writer whose clock runs 2 s behind logs an update older than b's last sync.
    await shared.hset(tagsKey(PREFIX), { late: `${Date.now() - 2_000},` });
    await shared.zadd(tagIndexKey(PREFIX), Date.now() - 2_000, "late");
    await b.sync();
    expect(b.get("late")).toBeDefined();
  });

  test("the first sync reads the whole index in pages; later syncs read only changes", async () => {
    const shared = new FakeRedis();
    const count = SYNC_PAGE_SIZE * 2 + 5;
    const fields: Record<string, string> = {};
    const scores: (string | number)[] = [];
    for (let i = 0; i < count; i++) {
      fields[`t${i}`] = `${Date.now() - 60_000},`;
      scores.push(Date.now() - 60_000, `t${i}`);
    }
    await shared.hset(tagsKey(PREFIX), fields);
    await shared.zadd(tagIndexKey(PREFIX), ...scores);

    const reader = new FakeRedis(shared.items);
    const b = storeOn(reader);
    await b.sync();
    expect(b.get(`t${count - 1}`)).toEqual({ stale: Date.now() - 60_000 });
    expect(reader.commands.filter((c) => c === "hmget")).toHaveLength(3);

    reader.commands.length = 0;
    await b.sync();
    // Nothing changed: one empty ZRANGEBYSCORE, no HMGET.
    expect(reader.commands).toEqual(["zrangebyscore"]);
  });

  test("merge keeps a newer local record made during an outage", async () => {
    const shared = new FakeRedis();
    const b = new FakeRedis(shared.items);
    const a = storeOn(shared);
    const tagsB = storeOn(b);
    await a.update(["x"]);

    vi.setSystemTime(Date.now() + 1_000);
    b.goDown();
    await tagsB.update(["x"]);
    const local = tagsB.get("x");
    b.comeUp();
    await tagsB.sync();
    expect(tagsB.get("x")).toEqual(local);
  });

  test("during an outage update applies locally and reports it", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    fake.goDown();
    await tags.update(["a"]);
    expect(tags.check(["a"], Date.now() - 1)).toBe("expired");
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("updateTags failed"),
      expect.objectContaining({ message: expect.stringContaining("reached this process only") }),
    );
    expect(await fake.exists(tagsKey(PREFIX))).toBe(0);
  });

  test("fetch reads the named records in one batch and merges them", async () => {
    const shared = new FakeRedis();
    const a = storeOn(shared);
    const reader = new FakeRedis(shared.items);
    const b = storeOn(reader);
    await a.update(["x", "y"]);
    const trips = reader.roundTrips;
    await b.fetch(["x", "y", "x", "never"]);
    expect(reader.roundTrips - trips).toBe(1);
    expect(reader.commands.filter((c) => c === "hmget")).toHaveLength(1);
    expect(b.get("x")).toEqual(a.get("x"));
    expect(b.get("never")).toBeUndefined();
    await expect(new TagStore(undefined, PREFIX).fetch(["x"])).resolves.toBeUndefined();
  });

  test("sync honours minIntervalMs and shares a running sync", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    await Promise.all([tags.sync(1_000), tags.sync(1_000)]);
    await tags.sync(1_000);
    expect(fake.commands.filter((c) => c === "zrangebyscore")).toHaveLength(1);
    vi.setSystemTime(Date.now() + 1_000);
    await tags.sync(1_000);
    expect(fake.commands.filter((c) => c === "zrangebyscore")).toHaveLength(2);
  });
});
