import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  INSTANCE_B,
  REDIS_CONTAINER,
  buildKeyPattern,
  docker,
  isRedisLane,
  readStamp,
  revalidate,
  uniqueId,
  waitForStable,
  withRedis,
} from "./helpers/cache";

// Stops the Redis container under two running instances. Runs alone (E2E_OUTAGE=1, see
// playwright.config.ts) because every other spec would fail while Redis is down.
test.describe("Redis outage @outage", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!isRedisLane, "needs the Redis container");

  let redisStopped = false;

  test.afterAll(() => {
    if (redisStopped) {
      docker("start", REDIS_CONTAINER);
    }
  });

  test("pages and data keep serving while Redis is down, and caching resumes", async () => {
    test.setTimeout(180_000);

    await waitForStable(INSTANCE_A, "/e2e/page-outage", "stamp");
    await waitForStable(INSTANCE_A, "/e2e/data?id=outage-before", "remote");

    docker("stop", "-t", "1", REDIS_CONTAINER);
    redisStopped = true;

    // A request never fails because of the cache.
    for (let round = 0; round < 3; round++) {
      for (const base of [INSTANCE_A, INSTANCE_B]) {
        const started = Date.now();
        await readStamp(base, "/e2e/page-outage", "stamp");
        await readStamp(base, `/e2e/data?id=${uniqueId("outage-down")}`, "remote");
        expect(Date.now() - started, `${base} while Redis is down`).toBeLessThan(15_000);
      }
    }
    await revalidate(INSTANCE_A, { tag: "e2e-page-outage" });

    docker("start", REDIS_CONTAINER);
    redisStopped = false;
    await expect(async () => {
      expect(await withRedis((redis) => redis.ping())).toBe("PONG");
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });

    // Start from an empty Redis so any key below was written after the restart.
    await withRedis((redis) => redis.flushall());

    const id = uniqueId("outage-after");
    await expect(async () => {
      await readStamp(INSTANCE_A, "/e2e/page-outage", "stamp");
      await readStamp(INSTANCE_A, `/e2e/data?id=${id}`, "remote");
      const [pages, data] = await Promise.all([
        withRedis((redis) => redis.keys(buildKeyPattern("page", "page-outage"))),
        withRedis((redis) => redis.keys(buildKeyPattern("data"))),
      ]);
      expect(pages).not.toHaveLength(0);
      expect(data).not.toHaveLength(0);
    }).toPass({ timeout: 60_000, intervals: [1000, 2000] });

    // Shared again: B reads A's remote entry from Redis.
    const onA = await waitForStable(INSTANCE_A, `/e2e/data?id=${id}`, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, `/e2e/data?id=${id}`, "remote")).toBe(onA);
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });
  });
});
