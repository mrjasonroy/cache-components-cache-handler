import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "@playwright/test";
import Redis from "ioredis";

/** The two `next start` instances. B only runs on the Redis lanes (see playwright.config.ts). */
export const INSTANCE_A = "http://localhost:3000";
export const INSTANCE_B = "http://localhost:3001";

/** Set by CI on the Redis lanes: the docker container name, which the outage spec stops. */
export const REDIS_CONTAINER = process.env.E2E_REDIS_CONTAINER ?? "";
export const isRedisLane = REDIS_CONTAINER !== "";

/**
 * Mirrors the package default (`CACHE_KEY_PREFIX`, `nextjs:`). The 16.4.2-config lane sets
 * E2E_KEY_PREFIX to its page handler's `keyPrefix`.
 */
export const KEY_PREFIX = process.env.E2E_KEY_PREFIX || process.env.CACHE_KEY_PREFIX || "nextjs:";

/** Entries live under `<prefix><buildId>:`; the build ID is the one `next build` wrote. */
export function buildId(): string {
  return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
}

export function buildKeyPattern(kind: "page" | "data", match = ""): string {
  return `${KEY_PREFIX}${buildId()}:${kind}:*${match}${match ? "*" : ""}`;
}

/**
 * Runs `fn` with a short-lived client that never retries, so a stopped Redis fails the call
 * instead of hanging the test.
 */
export async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379", {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 2000,
  });
  redis.on("error", () => {});
  try {
    await redis.connect();
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

export async function scanKeys(pattern: string): Promise<string[]> {
  return withRedis(async (redis) => {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 1000);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  });
}

/**
 * A tag's record as the handlers store it: the field of the `<prefix>tags` hash
 * (`"<stale>,<expired>"`, ms) and its score in the `<prefix>tag-index` sorted set.
 */
export async function readTagRecord(
  tag: string,
): Promise<{ record: string | null; indexScore: string | null }> {
  return withRedis(async (redis) => {
    const [record, indexScore] = await Promise.all([
      redis.hget(`${KEY_PREFIX}tags`, tag),
      redis.zscore(`${KEY_PREFIX}tag-index`, tag),
    ]);
    return { record, indexScore };
  });
}

export function docker(...args: string[]): void {
  execFileSync("docker", args, { stdio: "inherit" });
}

/** GETs `path` and returns the text of the element with `data-testid="<testId>"`. */
export async function readStamp(base: string, path: string, testId: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { cache: "no-store" });
  expect(response.status, `${base}${path}`).toBe(200);
  const html = await response.text();
  const match = html.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]+)<`));
  expect(match, `data-testid="${testId}" in ${base}${path}`).not.toBeNull();
  return match?.[1] ?? "";
}

/**
 * Returns the stamp once two reads in a row agree, i.e. once it is served from the cache. The
 * first render is a miss whose cache write commits asynchronously, so a single reload can race.
 */
export async function waitForStable(base: string, path: string, testId: string): Promise<string> {
  let stable = "";
  await expect(async () => {
    const first = await readStamp(base, path, testId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await readStamp(base, path, testId);
    expect(second).toBe(first);
    stable = second;
  }).toPass({ timeout: 30_000, intervals: [500, 1000] });
  return stable;
}

/** Reads until the stamp differs from `previous` (covers stale-while-revalidate). */
export async function waitForChange(
  base: string,
  path: string,
  testId: string,
  previous: string,
): Promise<string> {
  let current = "";
  await expect(async () => {
    current = await readStamp(base, path, testId);
    expect(current).not.toBe(previous);
  }).toPass({ timeout: 30_000, intervals: [500, 1000] });
  return current;
}

/**
 * How the revalidate route calls `revalidateTag` (see app/api/e2e/revalidate/route.ts):
 * `"expire-0"` (the default) passes `{ expire: 0 }`, `"none"` passes no profile (no durations reach
 * the handlers: an immediate miss) and `"max"` passes `"max"` (stale-while-revalidate).
 */
export type RevalidateProfile = "expire-0" | "none" | "max";

export async function revalidate(
  base: string,
  body: { tag?: string; path?: string; profile?: RevalidateProfile },
) {
  const response = await fetch(`${base}/api/e2e/revalidate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
}

export function uniqueId(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
