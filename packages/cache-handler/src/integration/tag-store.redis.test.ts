/**
 * The tag store's Redis commands against a real Redis: the sync's score-cursor paging (exclusive
 * `(` bounds, ties across pages).
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis (see outage.redis.test.ts).
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { getClientConnection } from "../shared/connection.js";
import { tagIndexKey, tagsKey } from "../shared/keys.js";
import { SYNC_PAGE_SIZE, SYNC_SKEW_MS, TagStore } from "../shared/tag-store.js";
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
});
