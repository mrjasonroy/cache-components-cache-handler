/**
 * The tag store's Redis commands against a real Redis: the sync's score-cursor paging (exclusive
 * `(` bounds, ties across pages), and the monotonic record script and `ZADD GT`.
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis (see outage.redis.test.ts).
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { getClientConnection } from "../shared/connection.js";
import { tagIndexKey, tagsKey } from "../shared/keys.js";
import {
  SYNC_PAGE_SIZE,
  SYNC_SKEW_MS,
  type TagRecord,
  TagStore,
  decodeRecord,
  encodeRecord,
} from "../shared/tag-store.js";
import {
  type TagUpdate,
  UPDATE_TAGS_SCRIPT,
  mergeUpdate,
  updateArgs,
} from "../shared/tag-update.js";
import { resetCacheState } from "../testing/env.js";

const url = process.env.CACHE_TEST_REDIS_URL;

describe.runIf(Boolean(url))("TagStore (real Redis)", () => {
  let prefix = "";
  let raw: Redis;

  function storeOn(client: Redis): TagStore {
    return new TagStore(getClientConnection(client), prefix);
  }

  beforeAll(() => {
    raw = new Redis(url as string);
  });

  beforeEach(() => {
    prefix = `cch-tags-test:${randomUUID()}:`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await raw.del(tagsKey(prefix), tagIndexKey(prefix));
    await resetCacheState();
  });

  afterAll(async () => {
    await raw.quit();
  });

  test("sync never skips a tag when an already-read tag moves, and reads ties whole", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const name = (i: number) => `t${String(i).padStart(4, "0")}`;
    const base = Date.now() - 60_000;
    const fields: Record<string, string> = {};
    const scores: (string | number)[] = [];
    // Distinct scores for a page and a half, then a tie longer than a page.
    for (let i = 0; i < SYNC_PAGE_SIZE + 500; i++) {
      fields[name(i)] = `${base + i},`;
      scores.push(base + i, name(i));
    }
    for (let i = 0; i < SYNC_PAGE_SIZE + 10; i++) {
      fields[`tie${i}`] = `${base + 10_000},`;
      scores.push(base + 10_000, `tie${i}`);
    }
    await raw.hset(tagsKey(prefix), fields);
    await raw.zadd(tagIndexKey(prefix), ...scores);

    const reader = new Redis(url as string);
    const writer = new Redis(url as string);
    try {
      const writerStore = storeOn(writer);
      const hmget = reader.hmget.bind(reader) as (...args: unknown[]) => Promise<string[]>;
      let moved = false;
      vi.spyOn(reader, "hmget").mockImplementation((async (...args: unknown[]) => {
        if (!moved) {
          moved = true;
          await writerStore.update([name(0)]);
        }
        return hmget(...args);
      }) as Redis["hmget"]);

      const b = storeOn(reader);
      await b.sync();
      vi.setSystemTime(Date.now() + SYNC_SKEW_MS + 1_000);
      await b.sync();
      for (const tag of Object.keys(fields)) expect(b.get(tag), tag).toBeDefined();
    } finally {
      reader.disconnect();
      writer.disconnect();
    }
  });

  test("an older write that reaches Redis after a newer acknowledged one does not replace it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // A server without the script cached: the first write falls back from EVALSHA to EVAL.
    await raw.script("FLUSH");
    const slow = new Redis(url as string);
    const fast = new Redis(url as string);
    const fresh = new Redis(url as string);
    try {
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let onHeld = () => {};
      const held = new Promise<void>((resolve) => {
        onHeld = resolve;
      });
      for (const name of ["hset", "zadd", "eval", "evalsha"] as const) {
        const original = slow[name].bind(slow) as (...args: unknown[]) => Promise<unknown>;
        vi.spyOn(slow, name).mockImplementation((async (...args: unknown[]) => {
          onHeld();
          await gate;
          return original(...args);
        }) as never);
      }

      const t = Date.now();
      const writeA = storeOn(slow).update(["products"]);
      await held;
      vi.setSystemTime(t + 2);
      await storeOn(fast).update(["products"]);
      release();
      await writeA;

      expect(await raw.hget(tagsKey(prefix), "products")).toBe(`${t + 2},${t + 2}`);
      expect(await raw.zscore(tagIndexKey(prefix), "products")).toBe(String(t + 2));
      const reader = storeOn(fresh);
      await reader.fetch(["products"]);
      expect(reader.check(["products"], t + 1)).toBe("expired");
    } finally {
      slow.disconnect();
      fast.disconnect();
      fresh.disconnect();
    }
  });

  test("after SCRIPT FLUSH the write still lands, and later writes use EVALSHA alone", async () => {
    const client = new Redis(url as string);
    try {
      const tags = storeOn(client);
      await tags.update(["a"]);
      await raw.script("FLUSH");
      const evalCalls = vi.spyOn(client, "eval");
      const evalshaCalls = vi.spyOn(client, "evalsha");

      await tags.update(["b"]);
      expect(evalshaCalls).toHaveBeenCalledTimes(1);
      expect(evalCalls).toHaveBeenCalledTimes(1);
      expect(decodeRecord(await raw.hget(tagsKey(prefix), "b"))?.stale).toBeDefined();

      await tags.update(["c"]);
      expect(evalshaCalls).toHaveBeenCalledTimes(2);
      expect(evalCalls).toHaveBeenCalledTimes(1);
      expect(decodeRecord(await raw.hget(tagsKey(prefix), "c"))?.stale).toBeDefined();
      for (const [, numKeys] of [...evalCalls.mock.calls, ...evalshaCalls.mock.calls]) {
        expect(numKeys).toBe(1);
      }
    } finally {
      client.disconnect();
    }
  });

  test("a malformed stored record is merged as the decoder reads it, never failing the batch", async () => {
    const t = 1_700_000_000_000;
    const corrupt = ["x,y", "x", `${t}`, `${t},x`, `x,${t}`, ",", `,${t}`, ""];
    const key = tagsKey(prefix);
    const fields: Record<string, string> = {};
    const batch = new Map<string, TagUpdate>();
    corrupt.forEach((value, i) => {
      fields[`c${i}`] = value;
      batch.set(`c${i}`, { stale: t - 1, expired: t - 1 });
    });
    // A healthy tag in the same batch.
    batch.set("ok", { stale: t, expired: t });
    await raw.hset(key, fields);
    expect(await raw.eval(UPDATE_TAGS_SCRIPT, 1, key, ...updateArgs(batch))).toBe(batch.size);

    const raws = await raw.hmget(key, ...batch.keys());
    [...batch.entries()].forEach(([tag, update], i) => {
      const current = decodeRecord(fields[tag]);
      expect(decodeRecord(raws[i]), JSON.stringify({ stored: fields[tag], update })).toEqual(
        mergeUpdate(current, update),
      );
    });
  });

  test("the script merges exactly as mergeUpdate", async () => {
    const t = 1_700_000_000_000;
    const stored: (TagRecord | undefined)[] = [
      undefined,
      { stale: t },
      { stale: t, expired: t },
      { stale: t, expired: t + 60_000 },
    ];
    const updates: TagUpdate[] = [];
    for (const stale of [t - 1, t, t + 1]) {
      updates.push({ stale }, { stale, expired: stale }, { stale, expired: stale + 30_000 });
    }
    const cases = stored.flatMap((current) => updates.map((update) => ({ current, update })));
    const key = tagsKey(prefix);
    const fields: Record<string, string> = {};
    const batch = new Map<string, TagUpdate>();
    cases.forEach(({ current, update }, i) => {
      if (current) fields[`c${i}`] = encodeRecord(current);
      batch.set(`c${i}`, update);
    });
    await raw.hset(key, fields);
    expect(await raw.eval(UPDATE_TAGS_SCRIPT, 1, key, ...updateArgs(batch))).toBe(cases.length);

    const raws = await raw.hmget(key, ...batch.keys());
    cases.forEach(({ current, update }, i) => {
      expect(decodeRecord(raws[i]), JSON.stringify({ current, update })).toEqual(
        mergeUpdate(current, update),
      );
    });
  });
});
