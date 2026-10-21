/**
 * ElastiCache IAM authentication against a real IAM-enabled ElastiCache cache: connect with a
 * token, set and get, re-`AUTH` the live connection with a new token, and reconnect with it.
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
 */

import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, test } from "vitest";
import { type RedisConnection, getRedisConnection } from "../shared/connection.js";
import { attachIamAuth } from "../shared/elasticache-iam.js";
import { resolveEnvConnectionOptions } from "../shared/env.js";
import { type CacheLogger, setCacheLogger } from "../shared/logger.js";

const enabled = process.env.ELASTICACHE_IAM_E2E === "1";

async function until(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(!enabled)("ElastiCache IAM against a real cache", () => {
  const errors: string[] = [];
  const logger: CacheLogger = {
    error: (message, meta) => errors.push(`${message} ${String(meta?.error)}`),
    warn: () => {},
  };
  const key = `iam-e2e:${randomUUID()}`;
  let connection: RedisConnection | undefined;
  const ownClients: Redis[] = [];

  afterAll(async () => {
    await connection?.client.del(key).catch(() => 0);
    await connection?.close();
    for (const client of ownClients) client.disconnect();
    setCacheLogger(undefined);
  });

  test("the package's connection from the environment authenticates and serves commands", async () => {
    setCacheLogger(logger);
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
});
