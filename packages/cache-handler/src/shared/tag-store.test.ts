import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { asClient, resetCacheState } from "../testing/env.js";
import { FakeRedis } from "../testing/fake-redis.js";
import { getClientConnection } from "./connection.js";
import { tagIndexKey, tagsKey } from "./keys.js";
import {
  type KeyTagState,
  SYNC_PAGE_SIZE,
  SYNC_SKEW_MS,
  type TagRecord,
  TagStore,
  applyUpdate,
  decodeRecord,
  encodeRecord,
} from "./tag-store.js";

const PREFIX = "t:";

function storeOn(fake: FakeRedis): TagStore {
  return new TagStore(getClientConnection(asClient(fake)), PREFIX);
}

/**
 * Holds `fake`'s write commands (whichever of them the store uses) until `release`: a write delayed
 * in transit. `held` resolves once the first write is waiting.
 */
function holdWrites(fake: FakeRedis): { held: Promise<void>; release: () => void } {
  let release = () => {};
  let onHeld = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    onHeld = resolve;
  });
  for (const name of ["hset", "zadd", "eval", "evalsha"] as const) {
    const original = fake[name]?.bind(fake) as
      | ((...args: unknown[]) => Promise<unknown>)
      | undefined;
    if (!original) continue;
    vi.spyOn(fake, name).mockImplementation((async (...args: unknown[]) => {
      onHeld();
      await gate;
      return original(...args);
    }) as never);
  }
  return { held, release };
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
    // 16.4.2's RedisCacheHandler and createCacheHandler write `nextjs:tags:<tag>` (other types), so a
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

  test("an update of N tags is one script call and one ZADD; the tag keys never expire", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    await tags.update(["a", "b", "c"], { expire: 10 });
    // EVALSHA, NOSCRIPT on a server that has not seen the script, then EVAL.
    expect([...fake.commands].sort()).toEqual(["eval", "evalsha", "zadd"]);
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
    expect(fake.ttlOf(tagsKey(PREFIX))).toBe(-1);
    expect(fake.ttlOf(tagIndexKey(PREFIX))).toBe(-1);

    // The server has the script now: one EVALSHA.
    fake.commands.length = 0;
    await tags.update(["d"]);
    expect([...fake.commands].sort()).toEqual(["evalsha", "zadd"]);
  });

  test("requests and sync do not prune tags; only background maintenance does", async () => {
    vi.setSystemTime(Date.UTC(2040, 0, 1));
    const shared = new FakeRedis();
    const old = Date.now() - 10 * 365 * 86_400_000;
    await shared.hset(tagsKey(PREFIX), { old: `${old},${old}` });
    await shared.zadd(tagIndexKey(PREFIX), old, "old");
    const tags = storeOn(shared);
    await tags.update(["new"]);
    await tags.sync();
    vi.setSystemTime(Date.now() + 2 * 365 * 86_400_000);
    await tags.update(["newer"]);
    await tags.sync();

    expect(await shared.hmget(tagsKey(PREFIX), "old")).toEqual([`${old},${old}`]);
    expect(await shared.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf")).toContain("old");
    expect(tags.get("old")).toEqual({ stale: old, expired: old });
    expect(tags.get("new")).toBeDefined();
    for (const command of ["hdel", "zrem", "del", "unlink", "expire"]) {
      expect(shared.commands).not.toContain(command);
    }
    await tags.maintain();
    expect(await shared.hmget(tagsKey(PREFIX), "old")).toEqual([null]);
    expect(await shared.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf")).not.toContain("old");
  });

  test("identical updates in one synchronous run (Next's dispatch loop) write once", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    await Promise.all([tags.update(["a", "b"]), tags.update(["b", "a"]), tags.update(["a", "b"])]);
    expect(fake.commands.filter((c) => c === "zadd")).toHaveLength(1);
    await tags.update(["a", "b"]);
    expect(fake.commands.filter((c) => c === "zadd")).toHaveLength(2);
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

  test("sync never skips a tag when an already-read tag moves while it pages", async () => {
    const shared = new FakeRedis();
    const count = SYNC_PAGE_SIZE + 2;
    const name = (i: number) => `t${String(i).padStart(4, "0")}`;
    const fields: Record<string, string> = {};
    const scores: (string | number)[] = [];
    for (let i = 0; i < count; i++) {
      const at = Date.now() - 60_000 + i;
      fields[name(i)] = `${at},${at}`;
      scores.push(at, name(i));
    }
    await shared.hset(tagsKey(PREFIX), fields);
    await shared.zadd(tagIndexKey(PREFIX), ...scores);

    const reader = new FakeRedis(shared.items);
    const writer = storeOn(shared);
    const hmget = reader.hmget.bind(reader);
    let moved = false;
    vi.spyOn(reader, "hmget").mockImplementation(async (...args) => {
      // During the first page, another instance revalidates a tag that page already read.
      if (!moved) {
        moved = true;
        await writer.update([name(0)]);
      }
      return hmget(...args);
    });

    const b = storeOn(reader);
    await b.sync();
    vi.setSystemTime(Date.now() + SYNC_SKEW_MS + 1_000);
    await b.sync();
    for (let i = 0; i < count; i++) expect(b.get(name(i)), name(i)).toBeDefined();
  });

  test("sync reads a run of equal scores longer than a page", async () => {
    const shared = new FakeRedis();
    const at = Date.now() - 60_000;
    const fields: Record<string, string> = {};
    const scores: (string | number)[] = [];
    for (let i = 0; i < SYNC_PAGE_SIZE * 2 + 3; i++) {
      fields[`t${i}`] = `${at},`;
      scores.push(at, `t${i}`);
    }
    fields.later = `${at + 1},`;
    scores.push(at + 1, "later");
    await shared.hset(tagsKey(PREFIX), fields);
    await shared.zadd(tagIndexKey(PREFIX), ...scores);

    const b = storeOn(new FakeRedis(shared.items));
    await b.sync();
    for (const tag of Object.keys(fields)) expect(b.get(tag), tag).toBeDefined();
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

  test("a writer whose clock runs ahead does not move a reader's sync point past later updates", async () => {
    const shared = new FakeRedis();
    const reader = storeOn(new FakeRedis(shared.items));
    await reader.sync();

    // An instance 60 s ahead revalidates "ahead"; the reader syncs it.
    await shared.hset(tagsKey(PREFIX), { ahead: `${Date.now() + 60_000},` });
    await shared.zadd(tagIndexKey(PREFIX), Date.now() + 60_000, "ahead");
    vi.setSystemTime(Date.now() + 1_000);
    await reader.sync();
    expect(reader.get("ahead")).toBeDefined();

    // An instance on time revalidates "normal" after that sync.
    await storeOn(shared).update(["normal"]);
    vi.setSystemTime(Date.now() + 1_000);
    await reader.sync();
    expect(reader.get("normal")).toBeDefined();
  });

  test("an update Redis did not take is sent again with the next update", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    fake.failWith = new Error("READONLY");
    await tags.update(["a"]);
    expect(await fake.exists(tagsKey(PREFIX))).toBe(0);

    fake.failWith = undefined;
    vi.setSystemTime(Date.now() + 1_000);
    await tags.update(["b"]);
    const [a, b] = await fake.hmget(tagsKey(PREFIX), "a", "b");
    expect(a).toBe(`${Date.now()},${Date.now()}`);
    expect(b).toBe(`${Date.now()},${Date.now()}`);
    expect(await fake.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf")).toEqual(["a", "b"]);
  });

  test("updates sent together are one batch; the other send finds nothing left and sends nothing", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const zadd = vi.spyOn(fake, "zadd");
    await Promise.all([tags.update(["a"]), tags.update(["b"])]);

    expect(zadd).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect(await fake.hmget(tagsKey(PREFIX), "a", "b")).not.toContain(null);
  });

  test("a revalidation sent together with another is not done until Redis took the batch holding it", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    const { held, release } = holdWrites(fake);
    let bDone = false;
    const a = tags.update(["a"]);
    const b = tags.update(["b"]).then(() => {
      bDone = true;
    });
    await held;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bDone).toBe(false);

    release();
    await Promise.all([a, b]);
    expect(await fake.hmget(tagsKey(PREFIX), "b")).not.toEqual([null]);
  });

  test("a write Redis refused while the connection stayed up is sent again by the next sync", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    fake.failWith = new Error("OOM command not allowed when used memory > 'maxmemory'.");
    await tags.update(["a"]);
    expect(await fake.exists(tagsKey(PREFIX))).toBe(0);

    fake.failWith = undefined;
    await tags.sync();
    await vi.waitFor(async () => {
      expect(await fake.hmget(tagsKey(PREFIX), "a")).not.toEqual([null]);
    });
    expect(await fake.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf")).toEqual(["a"]);
  });

  test("every script call names exactly one key, the tags hash: it cannot be CROSSSLOT", async () => {
    const fake = new FakeRedis();
    const evalCalls = vi.spyOn(fake, "eval");
    const evalshaCalls = vi.spyOn(fake, "evalsha");
    const tags = storeOn(fake);
    await tags.update(["a", "b"]);
    await tags.update(["c"], { expire: 60 });
    fake.failWith = new Error("READONLY");
    await tags.update(["d"]);
    fake.failWith = undefined;
    vi.setSystemTime(Date.now() + 1_000);
    await tags.update(["e", "f", "g"]);

    const calls = [...evalCalls.mock.calls, ...evalshaCalls.mock.calls];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const [, numKeys, key] of calls) {
      expect(numKeys).toBe(1);
      expect(key).toBe(tagsKey(PREFIX));
    }
  });

  test("after the script cache is flushed, the write still lands and later writes use EVALSHA", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    await tags.update(["a"]);
    await fake.script("FLUSH");

    fake.commands.length = 0;
    vi.setSystemTime(Date.now() + 1_000);
    await tags.update(["a"]);
    expect([...fake.commands].sort()).toEqual(["eval", "evalsha", "zadd"]);
    expect(await fake.hmget(tagsKey(PREFIX), "a")).toEqual([`${Date.now()},${Date.now()}`]);

    fake.commands.length = 0;
    await tags.update(["b"]);
    expect([...fake.commands].sort()).toEqual(["evalsha", "zadd"]);
  });

  test("an older write that reaches Redis after a newer acknowledged one does not replace it", async () => {
    const shared = new FakeRedis();
    const slow = new FakeRedis(shared.items);
    const tagsA = storeOn(slow);
    const tagsB = storeOn(new FakeRedis(shared.items));
    const released = holdWrites(slow);

    // A revalidates at T; its write is delayed in transit.
    const t = Date.now();
    const writeA = tagsA.update(["products"]);
    await released.held;

    // An entry is cached at T+1; B revalidates at T+2 and Redis acknowledges it.
    vi.setSystemTime(t + 2);
    await tagsB.update(["products"]);

    // A's write arrives last.
    released.release();
    await writeA;

    expect(await shared.hmget(tagsKey(PREFIX), "products")).toEqual([`${t + 2},${t + 2}`]);
    expect(await shared.zrangebyscore(tagIndexKey(PREFIX), "-inf", "+inf", "WITHSCORES")).toEqual([
      "products",
      String(t + 2),
    ]);
    const reader = storeOn(new FakeRedis(shared.items));
    await reader.fetch(["products"]);
    expect(reader.check(["products"], t + 1)).toBe("expired");
  });

  test("an older revalidation with durations does not replace a newer immediate one", async () => {
    const shared = new FakeRedis();
    const t = Date.now();
    await storeOn(shared).update(["x"]);
    vi.setSystemTime(t - 5);
    await storeOn(new FakeRedis(shared.items)).update(["x"], { expire: 60 });
    expect(await shared.hmget(tagsKey(PREFIX), "x")).toEqual([`${t},${t}`]);
  });

  test("an update made during an outage reaches Redis on reconnect, newer than any before", async () => {
    const shared = new FakeRedis();
    const b = new FakeRedis(shared.items);
    const tagsB = storeOn(b);
    b.goDown();
    await tagsB.update(["x"], { expire: 60 });

    // Another instance revalidated "x" while b was cut off.
    vi.setSystemTime(Date.now() + 1_000);
    await storeOn(shared).update(["x"]);

    vi.setSystemTime(Date.now() + 1_000);
    const reconnectedAt = Date.now();
    b.comeUp();
    let record: TagRecord | undefined;
    await vi.waitFor(async () => {
      record = decodeRecord((await shared.hmget(tagsKey(PREFIX), "x"))[0]);
      expect(record?.stale).toBeGreaterThanOrEqual(reconnectedAt);
    });
    expect((record?.expired ?? 0) - (record?.stale ?? 0)).toBe(60_000);
  });

  test("isSynced: false with Redis until a sync completes, again after a reconnect or a failed sync", async () => {
    expect(new TagStore(undefined, PREFIX).isSynced()).toBe(true);

    const fake = new FakeRedis();
    const tags = storeOn(fake);
    expect(tags.isSynced()).toBe(false);
    await tags.sync();
    expect(tags.isSynced()).toBe(true);

    fake.goDown();
    fake.comeUp();
    expect(tags.isSynced()).toBe(false);
    await tags.sync(1_000);
    expect(tags.isSynced()).toBe(true);

    vi.spyOn(fake, "zrangebyscore").mockRejectedValueOnce(new Error("LOADING"));
    vi.setSystemTime(Date.now() + 1_000);
    await tags.sync(1_000);
    expect(tags.isSynced()).toBe(false);
  });

  test("a sync skipped because Redis was not ready is not counted against the interval", async () => {
    const fake = new FakeRedis();
    const tags = storeOn(fake);
    fake.status = "reconnecting";
    await tags.sync(1_000);
    fake.status = "ready";
    await tags.sync(1_000);
    expect(fake.commands).toContain("zrangebyscore");
    expect(tags.isSynced()).toBe(true);
  });

  test("a closed store sends updates to the live store of its key", async () => {
    const fake = new FakeRedis();
    const connection = getClientConnection(asClient(fake));
    const live = new TagStore(connection, PREFIX);
    const state: KeyTagState = { records: new Map(), unsent: new Map() };
    const closed = new TagStore(connection, PREFIX, {
      key: { liveStore: () => live, currentState: () => state },
    });
    closed.close();
    await closed.update(["a"]);
    expect(live.get("a")).toBeDefined();
    expect(closed.get("a")).toBeUndefined();
  });

  test("a send in flight at close that fails is queued in the key's current state", async () => {
    const fake = new FakeRedis();
    const connection = getClientConnection(asClient(fake));
    // The state the key has by the time the send fails: a newer store's, not the closed one's.
    const current: KeyTagState = { records: new Map(), unsent: new Map() };
    const tags = new TagStore(connection, PREFIX, {
      key: { liveStore: () => new TagStore(connection, PREFIX), currentState: () => current },
    });
    const { held, release } = holdWrites(fake);
    const update = tags.update(["a"]);
    await held;
    tags.close();
    fake.failWith = new Error("READONLY You can't write against a read only replica.");
    release();
    await update;
    expect(current.unsent.has("a")).toBe(true);
    expect(current.records.get("a")?.stale).toBeGreaterThan(0);
    expect(tags.hasUnsent()).toBe(false);
  });
});
