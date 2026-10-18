import type { RedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { type APIRequestContext, expect, test } from "@playwright/test";
import Redis from "ioredis";

/**
 * The ISR RedisCacheHandler under a real `next start` (Next.js 16), shared
 * through Redis with this test process, which plays the second server: it
 * revalidates through its own handler and Next.js must see it.
 *
 * Runs only against Redis/Valkey (CACHE_HANDLER=redis).
 */
test.skip(process.env.CACHE_HANDLER !== "redis", "needs CACHE_HANDLER=redis");
test.describe.configure({ mode: "serial" });

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
// The prefixes apps/e2e-test-app/cache-handler.mjs gives the server's handler
const KEY_PREFIX = "e2e:isr:";
const TAG_PREFIX = "e2e:isr-tags:";
const PAGE = "/isr-redis";

let redis: Redis;
let otherServer: RedisCacheHandler;

test.beforeAll(async () => {
  // Imported at run time: the package is ESM, and Playwright compiles specs to CommonJS
  const { RedisCacheHandler } = await import("@mrjasonroy/cache-components-cache-handler");
  redis = new Redis(REDIS_URL);
  otherServer = new RedisCacheHandler({
    redis: REDIS_URL,
    keyPrefix: KEY_PREFIX,
    tagPrefix: TAG_PREFIX,
  });
});

test.afterAll(async () => {
  await otherServer.close();
  await redis.quit();
});

async function scan(pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

interface StoredEntry {
  key: string;
  lastModified: number;
  tags: string[];
  cacheControl?: { revalidate?: number | false; expire?: number };
}

/** The page's entry as the server stored it, once there is exactly one. */
async function pageEntry(): Promise<StoredEntry> {
  let entry: StoredEntry | undefined;
  await expect(async () => {
    const keys = await scan(`${KEY_PREFIX}*/$${PAGE}`);
    expect(keys).toHaveLength(1);
    const raw = await redis.get(keys[0]);
    expect(raw).not.toBeNull();
    entry = { key: keys[0], ...JSON.parse(raw as string) };
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
  return entry as StoredEntry;
}

async function cacheState(request: APIRequestContext): Promise<string | undefined> {
  const response = await request.get(PAGE);
  expect(response.ok()).toBe(true);
  return response.headers()["x-nextjs-cache"];
}

/** Requests the page until the server serves it from the handler. */
async function expectHit(request: APIRequestContext): Promise<void> {
  await expect(async () => {
    expect(await cacheState(request)).toBe("HIT");
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
}

/** Waits until the server has stored a newer render of the page. */
async function expectRegenerated(previous: StoredEntry): Promise<StoredEntry> {
  let entry = previous;
  await expect(async () => {
    entry = await pageEntry();
    expect(entry.lastModified).toBeGreaterThan(previous.lastModified);
  }).toPass({ timeout: 20_000, intervals: [250, 500, 1000] });
  return entry;
}

test("the server stores the page with its header tags and cacheControl, kept past revalidate", async ({
  request,
}) => {
  await expectHit(request);
  const entry = await pageEntry();

  expect(entry.tags).toEqual(expect.arrayContaining(["isr-redis", `_N_T_${PAGE}`]));
  expect(entry.cacheControl).toEqual({ revalidate: 60, expire: 3600 });
  // revalidate 60 x the default expireFactor of 2, so it can be served stale
  const ttl = await redis.ttl(entry.key);
  expect(ttl).toBeGreaterThan(60);
  expect(ttl).toBeLessThanOrEqual(120);
});

test("revalidatePath in another process makes the server regenerate the page", async ({
  request,
}) => {
  await expectHit(request);
  const before = await pageEntry();

  await otherServer.revalidateTag([`_N_T_${PAGE}`]);

  expect(await cacheState(request)).not.toBe("HIT");
  await expectRegenerated(before);
  await expectHit(request);
});

test("revalidateTag in another process makes the server regenerate the page", async ({
  request,
}) => {
  await expectHit(request);
  const before = await pageEntry();

  await otherServer.revalidateTag(["isr-redis"]);

  expect(await cacheState(request)).not.toBe("HIT");
  await expectRegenerated(before);
  await expectHit(request);
});

test("revalidateTag with durations serves the page stale while it regenerates", async ({
  request,
}) => {
  await expectHit(request);
  const before = await pageEntry();

  await otherServer.revalidateTag(["isr-redis"], { expire: 300 });

  expect(await cacheState(request)).toBe("STALE");
  await expectRegenerated(before);
  await expectHit(request);
});

test("Redis holds one key per entry and per revalidated tag, with no tag index", async () => {
  expect(await scan(`${KEY_PREFIX}*/$${PAGE}`)).toHaveLength(1);
  expect(await scan(`${TAG_PREFIX}*:keys`)).toEqual([]);
  for (const key of await scan(`${TAG_PREFIX}*`)) {
    expect(await redis.type(key)).toBe("string");
  }
});
