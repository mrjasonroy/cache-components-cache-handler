import { expect, test } from "@playwright/test";
import {
  INSTANCE_A,
  INSTANCE_B,
  REDIS_CONTAINER,
  docker,
  isRedisLane,
  readStamp,
  readTagRecord,
  revalidate,
  uniqueId,
  waitForStable,
  withRedis,
} from "./helpers/cache";

/** The package's `fallbackTTL` default: an outage memory entry is served for at most 60 s. */
const MEMORY_FALLBACK_CAP_MS = 60_000;
/** Slack on top of the cap for reconnect, polling and request latency. */
const RECOVERY_SLACK_MS = 20_000;

const PAGE = "/e2e/page-outage";
const PAGE_TAG = "e2e-page-outage";

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

  test("requests keep serving while Redis is down; an outage revalidation is not lost on reconnect", async () => {
    test.setTimeout(300_000);

    // Shared entries written to Redis before the outage: a page and a remote data entry, each
    // readable by B with A's value.
    const id = uniqueId("outage-before");
    const dataPath = `/e2e/data?id=${id}`;
    const pageBefore = await waitForStable(INSTANCE_A, PAGE, "stamp");
    const dataBefore = await waitForStable(INSTANCE_A, dataPath, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, PAGE, "stamp")).toBe(pageBefore);
      expect(await readStamp(INSTANCE_B, dataPath, "remote")).toBe(dataBefore);
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });

    docker("stop", "-t", "1", REDIS_CONTAINER);
    redisStopped = true;

    // A request never fails because of the cache.
    for (let round = 0; round < 3; round++) {
      for (const base of [INSTANCE_A, INSTANCE_B]) {
        const started = Date.now();
        await readStamp(base, PAGE, "stamp");
        await readStamp(base, `/e2e/data?id=${uniqueId("outage-down")}`, "remote");
        expect(Date.now() - started, `${base} while Redis is down`).toBeLessThan(15_000);
      }
    }

    // Revalidate both entries on A during the outage. The tag write cannot reach Redis, so it
    // applies to A only (README "When Redis goes down"); B may keep its copy until it ages out.
    const revalidatedAt = Date.now();
    await revalidate(INSTANCE_A, { tag: PAGE_TAG });
    await revalidate(INSTANCE_A, { tag: `e2e-remote-${id}` });

    // On A itself the invalidation applies at once.
    expect(await readStamp(INSTANCE_A, PAGE, "stamp"), "A, page, during outage").not.toBe(
      pageBefore,
    );
    expect(await readStamp(INSTANCE_A, dataPath, "remote"), "A, data, during outage").not.toBe(
      dataBefore,
    );

    docker("start", REDIS_CONTAINER);
    redisStopped = false;
    await expect(async () => {
      expect(await withRedis((redis) => redis.ping())).toBe("PONG");
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });
    const reconnectedAt = Date.now();

    // Redis still holds the pre-outage entries (no flush), so the only thing standing between
    // them and a stale read is the outage revalidation reaching Redis: the failed tag write is
    // replayed when the handler reconnects. Its record must carry the outage timestamp.
    await expect(async () => {
      // A request on A drives the handler's reconnect.
      await readStamp(INSTANCE_A, PAGE, "stamp");
      const { record, indexScore } = await readTagRecord(PAGE_TAG);
      expect(record, `${PAGE_TAG} record in Redis`).not.toBeNull();
      expect(indexScore, `${PAGE_TAG} in the tag index`).not.toBeNull();
      const expired = Number(record?.split(",")[1]);
      expect(expired, `${PAGE_TAG} expired (ms)`).toBeGreaterThanOrEqual(revalidatedAt - 1_000);
    }).toPass({ timeout: MEMORY_FALLBACK_CAP_MS, intervals: [1000, 2000] });

    // Neither instance serves a pre-outage value once the fallback cap has passed since Redis
    // came back: B never saw the revalidation directly, only through Redis.
    const remaining = MEMORY_FALLBACK_CAP_MS + RECOVERY_SLACK_MS - (Date.now() - reconnectedAt);
    await expect(async () => {
      for (const base of [INSTANCE_A, INSTANCE_B]) {
        expect(await readStamp(base, PAGE, "stamp"), `${base} page`).not.toBe(pageBefore);
        expect(await readStamp(base, dataPath, "remote"), `${base} data`).not.toBe(dataBefore);
      }
    }).toPass({ timeout: Math.max(remaining, 5_000), intervals: [1000, 2000] });

    // ...and it stays that way.
    for (let round = 0; round < 3; round++) {
      for (const base of [INSTANCE_A, INSTANCE_B]) {
        expect(await readStamp(base, PAGE, "stamp"), `${base} page, later`).not.toBe(pageBefore);
        expect(await readStamp(base, dataPath, "remote"), `${base} data, later`).not.toBe(
          dataBefore,
        );
      }
    }

    // Caching resumes and is shared again: both instances converge on one value from Redis.
    await expect(async () => {
      const [pageA, pageB] = [
        await readStamp(INSTANCE_A, PAGE, "stamp"),
        await readStamp(INSTANCE_B, PAGE, "stamp"),
      ];
      expect(pageB).toBe(pageA);
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });

    const afterId = uniqueId("outage-after");
    const onA = await waitForStable(INSTANCE_A, `/e2e/data?id=${afterId}`, "remote");
    await expect(async () => {
      expect(await readStamp(INSTANCE_B, `/e2e/data?id=${afterId}`, "remote")).toBe(onA);
    }).toPass({ timeout: 30_000, intervals: [500, 1000] });
  });
});
