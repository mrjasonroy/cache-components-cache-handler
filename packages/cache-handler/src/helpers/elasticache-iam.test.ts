import { EventEmitter } from "node:events";
import type { Cluster, Redis } from "ioredis";
import { afterEach, describe, expect, test, vi } from "vitest";
import { attachElastiCacheIamAuth } from "./elasticache-iam.js";

const credentials = async () => ({ accessKeyId: "AKID", secretAccessKey: "secret" });

class FakeRedis extends EventEmitter {
  readonly isCluster = false;
  status = "wait";
  constructor(readonly options: Record<string, unknown>) {
    super();
  }
  auth = vi.fn(async () => "OK");
  connect = vi.fn(async () => {
    this.status = "ready";
  });
}

class FakeCluster extends EventEmitter {
  readonly isCluster = true;
  status = "wait";
  options: { redisOptions?: Record<string, unknown> };
  constructor(
    readonly startupNodes: unknown[],
    redisOptions: Record<string, unknown>,
  ) {
    super();
    this.options = { redisOptions };
  }
  nodes() {
    return [];
  }
  connect = vi.fn(async () => {
    this.status = "ready";
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
}

describe("attachElastiCacheIamAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("connects your Redis client with a token once it is ready", async () => {
    const client = new FakeRedis({ host: "master.my-cache.use1.cache.amazonaws.com", tls: {} });
    const auth = attachElastiCacheIamAuth(client as unknown as Redis, {
      userId: "app-user",
      cacheName: "my-cache",
      region: "us-east-1",
      credentials,
    });
    await settle();

    expect(client.status).toBe("ready");
    expect(client.options.username).toBe("app-user");
    expect(String(client.options.password)).toMatch(
      /^my-cache\/\?Action=connect&User=app-user&X-Amz/,
    );
    expect(String(client.options.password)).not.toContain("ResourceType");
    auth.stop();
  });

  test("a Cluster on a serverless endpoint signs for a serverless cache", async () => {
    const cluster = new FakeCluster(
      [{ host: "my-cache-abc123.serverless.use1.cache.amazonaws.com", port: 6379 }],
      { tls: {} },
    );
    const auth = attachElastiCacheIamAuth(cluster as unknown as Cluster, {
      userId: "app-user",
      cacheName: "my-cache",
      region: "us-east-1",
      credentials,
    });
    await settle();

    expect(cluster.status).toBe("ready");
    expect(String(cluster.options.redisOptions?.password)).toContain(
      "ResourceType=ServerlessCache",
    );
    auth.stop();
  });

  test("throws for a client without TLS", () => {
    const client = new FakeRedis({ host: "cache" });
    expect(() =>
      attachElastiCacheIamAuth(client as unknown as Redis, {
        userId: "app-user",
        cacheName: "my-cache",
        region: "us-east-1",
      }),
    ).toThrow(/TLS is off/);
  });
});
