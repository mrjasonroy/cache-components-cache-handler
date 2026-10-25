/**
 * ElastiCache IAM authentication against a real IAM-enabled ElastiCache cache: connect with a
 * token, set and get, re-`AUTH` the live connection with a new token, reconnect with it, carry a
 * tag revalidation from one connection to another, and flush a build.
 *
 * Runs only with `ELASTICACHE_IAM_E2E=1`, from somewhere that can reach the cache (its VPC) with
 * AWS credentials allowed `elasticache:Connect` on the cache and the user:
 *
 * ```sh
 * ELASTICACHE_IAM_E2E=1 \
 * ELASTICACHE_ENDPOINT=master.my-cache.abc123.use1.cache.amazonaws.com \
 * ELASTICACHE_IAM_USER=app-user ELASTICACHE_CACHE_NAME=my-cache ELASTICACHE_REGION=us-east-1 \
 *   pnpm --filter @mrjasonroy/cache-components-cache-handler exec vitest run src/integration/elasticache-iam
 * ```
 *
 * Node-based (cluster mode disabled) and serverless caches both work. A serverless endpoint is
 * reached here with a plain `Redis` client, as the package's environment connection does: the
 * cache is sharded behind its proxy, so a command over keys of different slots is refused with
 * `CROSSSLOT`. The handlers send single-key commands only; `flushCache` falls back to one UNLINK
 * per key when its batched UNLINK is refused, and tag pruning (a two-key script) is skipped with a
 * warning. So nothing here needs hash tags.
 *
 * Every key is under a prefix unique to the run, deleted in `afterAll`.
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { DataCacheEntry } from "../data-cache/types.js";
import { attachElastiCacheIamAuth } from "../helpers/elasticache-iam.js";
import { createRemoteCacheHandler } from "../index.js";
import { type RedisConnection, getRedisConnection } from "../shared/connection.js";
import { attachIamAuth } from "../shared/elasticache-iam.js";
import { resolveEnvConnectionOptions } from "../shared/env.js";
import { flushCache } from "../shared/flush.js";
import { dataKey, tagIndexKey, tagsKey } from "../shared/keys.js";
import { type CacheLogger, setCacheLogger } from "../shared/logger.js";
import { closeCache, getCacheRuntime } from "../shared/runtime.js";

const enabled = process.env.ELASTICACHE_IAM_E2E === "1";

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function entry(value: string, tags: string[]): Promise<DataCacheEntry> {
  return Promise.resolve({
    value: new Blob([value]).stream(),
    tags,
    stale: 0,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 300,
  });
}

async function read(found: DataCacheEntry | undefined): Promise<string | undefined> {
  return found ? new Response(found.value).text() : undefined;
}

describe.skipIf(!enabled)("ElastiCache IAM against a real cache", () => {
  const errors: string[] = [];
  const logger: CacheLogger = {
    error: (message, meta) => errors.push(`${message} ${String(meta?.error)}`),
    warn: () => {},
  };
  const run = randomUUID();
  const key = `iam-e2e:${run}`;
  // Everything the handler tests write: entries under `<prefix><buildId>:`, tag records under it.
  const prefix = `iam-e2e:${run}:`;
  const buildId = "b1";
  const otherBuildId = "b2";
  let connection: RedisConnection | undefined;
  const ownClients: Redis[] = [];
  /** Clients made by `ownIamClient`, still authenticated at the end: one cleans up. */
  const iamClients: Redis[] = [];
  const stops: Array<() => void> = [];

  /** A `Redis` of the test's own, IAM-authenticated through the public API, once ready. */
  async function ownIamClient(): Promise<Redis> {
    const options = resolveEnvConnectionOptions();
    if (!options?.host || !options.iam) throw new Error("set the ELASTICACHE_* environment");
    const client = new Redis({
      host: options.host,
      port: options.port ?? 6379,
      tls: {},
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 10_000,
    });
    ownClients.push(client);
    client.on("error", () => {});
    stops.push(attachElastiCacheIamAuth(client, { logger }).stop);
    await until(() => client.status === "ready");
    iamClients.push(client);
    return client;
  }

  beforeAll(() => {
    setCacheLogger(logger);
  });

  afterAll(async () => {
    await connection?.client.del(key).catch(() => 0);
    await connection?.close();
    // The run's prefix: every entry, then the tag records the flush itself writes afterwards.
    const cleaner = iamClients[0];
    if (cleaner?.status === "ready") {
      await flushCache({ client: cleaner, keyPrefix: prefix, scope: "all" }).catch(() => undefined);
      await cleaner.del(tagsKey(prefix)).catch(() => 0);
      await cleaner.del(tagIndexKey(prefix)).catch(() => 0);
    }
    await closeCache();
    for (const stop of stops) stop();
    for (const client of ownClients) client.disconnect();
    setCacheLogger(undefined);
  });

  test("the package's connection from the environment authenticates and serves commands", async () => {
    const options = resolveEnvConnectionOptions();
    expect(options?.iam).toBeDefined();
    connection = getRedisConnection({ ...options, initialConnectWaitMs: 15_000 });
    expect(await connection.waitForInitialConnection()).toBe(true);

    await connection.client.set(key, "value", "EX", 60);
    expect(await connection.client.get(key)).toBe("value");
    expect(await connection.client.call("ACL", "WHOAMI")).toBe(options?.iam?.userId);
    expect(errors).toEqual([]);
  });

  test("a new token re-AUTHs the live connection, and a reconnect uses it", async () => {
    const options = resolveEnvConnectionOptions();
    const iam = options?.iam;
    if (!options?.host || !iam) throw new Error("set the ELASTICACHE_* environment");
    const client = new Redis({
      host: options.host,
      port: options.port ?? 6379,
      tls: {},
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 10_000,
    });
    ownClients.push(client);
    client.on("error", () => {});
    const auth = attachIamAuth(client, iam, { logger: () => logger, connect: true });
    try {
      await until(() => client.status === "ready");
      const first = client.options.password;

      // A fresh token on the live connection: the `AUTH` that extends ElastiCache's 12 hours.
      // SigV4 signs to the second, so a token minted in the same second is the same token.
      await sleep(1100);
      expect(await auth.refresh()).toBe(true);
      const second = client.options.password;
      expect(second).not.toBe(first);
      expect(await client.call("ACL", "WHOAMI")).toBe(iam.userId);

      // Drop the socket: ioredis reconnects with the options' (new) token.
      client.disconnect(true);
      await until(() => client.status !== "ready", 5_000);
      await until(() => client.status === "ready");
      expect(await client.ping()).toBe("PONG");
      expect(errors).toEqual([]);
    } finally {
      auth.stop();
    }
  });

  test("flushCache({ scope: 'build' }) on a connection of its own deletes that build's entries only", async () => {
    // Written over a client of the test's own; the flush opens an IAM connection of its own from
    // the environment (no handler has opened one for this prefix), waiting up to 5 s for its token.
    const writer = await ownIamClient();
    const handler = createRemoteCacheHandler({ client: writer, keyPrefix: prefix, buildId });
    const other = createRemoteCacheHandler({
      client: writer,
      keyPrefix: prefix,
      buildId: otherBuildId,
    });
    const keys = ["flush-a", "flush-b", "flush-c"];
    for (const cacheKey of keys) await handler.set(cacheKey, entry(cacheKey, []));
    await other.set("flush-other", entry("other", []));
    for (const cacheKey of keys) {
      expect(await writer.exists(dataKey(prefix, buildId, cacheKey))).toBe(1);
    }

    const result = await flushCache({ keyPrefix: prefix, scope: "build", buildId });

    expect(result).toEqual({ deleted: keys.length });
    for (const cacheKey of keys) {
      expect(await writer.exists(dataKey(prefix, buildId, cacheKey))).toBe(0);
      expect(await handler.get(cacheKey, [])).toBeUndefined();
    }
    expect(await read(await other.get("flush-other", []))).toBe("other");
    expect(errors).toEqual([]);
  });

  test("a tag revalidated on one connection invalidates the entry for another", async () => {
    // Connection A: the package's own, from the environment. Connection B: the test's client.
    const runtime = getCacheRuntime({ keyPrefix: prefix });
    const own = runtime.connection;
    if (!own) throw new Error("expected a Redis connection from the ELASTICACHE_* environment");
    expect(await own.waitForOperationConnection()).toBe(true);
    const a = createRemoteCacheHandler({ keyPrefix: prefix, buildId });
    const b = createRemoteCacheHandler({
      client: await ownIamClient(),
      keyPrefix: prefix,
      buildId,
    });
    const tag = `products-${run}`;

    await a.set("tagged-a", entry("from a", [tag]));
    await b.set("tagged-b", entry("from b", [tag]));
    await a.set("untagged", entry("kept", ["other-tag"]));
    expect(await read(await b.get("tagged-a", []))).toBe("from a");
    expect(await read(await a.get("tagged-b", []))).toBe("from b");

    // A revalidation newer than the entries.
    await sleep(50);
    await b.updateTags([tag]);

    expect(await a.get("tagged-a", [])).toBeUndefined();
    expect(await a.get("tagged-b", [])).toBeUndefined();
    expect(await b.get("tagged-a", [])).toBeUndefined();
    expect(await read(await a.get("untagged", []))).toBe("kept");

    // The "use cache" side: A's tag state picks up B's revalidation on its next sync (at most
    // one per 100 ms).
    await sleep(150);
    await a.refreshTags();
    expect(await a.getExpiration([tag])).toBeGreaterThan(0);

    // An entry written after the revalidation is served again, on both connections.
    await a.set("tagged-a", entry("again", [tag]));
    expect(await read(await b.get("tagged-a", []))).toBe("again");
    expect(errors).toEqual([]);
  });
});
