/**
 * The page handler's build-output fallback against a real Redis: a prerendered entry is written
 * through, and is never served over a tag or path revalidated since the build, even by a process
 * that starts after the revalidation.
 *
 * Runs only when `CACHE_TEST_REDIS_URL` points at a disposable Redis (see outage.redis.test.ts).
 */

import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RedisCacheHandler } from "../handlers/redis.js";
import { pageKey, tagIndexKey, tagsKey } from "../shared/keys.js";
import {
  BLOG,
  type BuildOutput,
  SITEMAP,
  appPageCtx,
  appRouteCtx,
  writeBuildOutput,
} from "../testing/build-output.js";
import { resetCacheState } from "../testing/env.js";

const url = process.env.CACHE_TEST_REDIS_URL;

describe.runIf(Boolean(url))("page handler build output (real Redis)", () => {
  let prefix = "";
  let build: BuildOutput;
  const clients: Redis[] = [];

  /** A process: its own Redis client and handler, nothing shared in memory with earlier ones. */
  async function startProcess(): Promise<RedisCacheHandler> {
    await resetCacheState();
    const client = new Redis(url as string);
    clients.push(client);
    return new RedisCacheHandler({
      client,
      keyPrefix: prefix,
      fs: build.fs,
      serverDistDir: build.serverDistDir,
    });
  }

  beforeEach(() => {
    prefix = `cch-build-test:${randomUUID()}:`;
    build = writeBuildOutput();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const [client] = clients;
    if (client) {
      const keys = await client.keys(`${prefix}*`);
      if (keys.length > 0) await client.del(...keys);
    }
    await Promise.all(clients.splice(0).map((client) => client.quit()));
    await resetCacheState();
    rmSync(dirname(build.serverDistDir), { recursive: true, force: true });
  });

  test("the build output is written through, and a later process reads it from Redis", async () => {
    const first = await startProcess();
    expect((await first.get(BLOG, appPageCtx))?.value.html).toBe("<html>built blog</html>");
    expect(await clients[0].exists(pageKey(prefix, "development", BLOG))).toBe(1);

    rmSync(build.serverDistDir, { recursive: true, force: true });
    const second = await startProcess();
    const result = await second.get(BLOG, appPageCtx);
    expect(result?.value.html).toBe("<html>built blog</html>");
    expect(result?.lastModified).toBe(build.builtAt);
  });

  test("a tag revalidated after a read is never served from the build output after a restart", async () => {
    const first = await startProcess();
    expect(await first.get(BLOG, appPageCtx)).not.toBeNull();
    await first.revalidateTag("products");

    const second = await startProcess();
    expect(await second.get(BLOG, appPageCtx)).toBeNull();
    expect(await clients[0].hget(tagsKey(prefix), "products")).toMatch(/^\d+,\d+$/);
  });

  test("a path revalidated before any read is never served from the build output after a restart", async () => {
    const first = await startProcess();
    await first.revalidateTag("_N_T_/sitemap.xml");
    expect(await clients[0].zscore(tagIndexKey(prefix), "_N_T_/sitemap.xml")).not.toBeNull();

    const second = await startProcess();
    expect(await second.get(SITEMAP, appRouteCtx)).toBeNull();
    expect(await clients[0].exists(pageKey(prefix, "development", SITEMAP))).toBe(0);
  });
});
