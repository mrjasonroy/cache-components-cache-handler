import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** Enough of an ioredis client for a connection the package opens with IAM. */
class FakeClient extends EventEmitter {
  readonly isCluster = false;
  status: string;
  readonly options: Record<string, unknown>;
  readonly connects: Array<{ username?: unknown; password?: unknown }> = [];
  sendCommand = vi.fn(() => undefined);
  auth = vi.fn(async () => "OK");
  quit = vi.fn(async () => {
    this.status = "end";
    return "OK";
  });
  disconnect = vi.fn(() => {
    this.status = "end";
  });
  connect = vi.fn(async () => {
    this.connects.push({ username: this.options.username, password: this.options.password });
    this.status = "ready";
    this.emit("ready");
  });

  constructor(...args: unknown[]) {
    super();
    this.options = { ...(args.find((arg) => typeof arg === "object") as object) };
    this.status = this.options.lazyConnect ? "wait" : "connecting";
    clients.push(this);
  }
}

const clients: FakeClient[] = [];
const aws = vi.hoisted(() => ({ available: true }));
const ioredisMock = vi.hoisted(() =>
  vi.fn(function (this: unknown, ...args: unknown[]) {
    return new FakeClient(...args);
  }),
);

vi.mock("./node-require.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./node-require.js")>();
  return {
    ...original,
    requireModule: (id: string) => {
      if (id === "ioredis") return ioredisMock;
      if (!aws.available) throw new Error(`Cannot find module '${id}'`);
      return original.requireModule(id);
    },
  };
});

import type { Redis } from "ioredis";
import { resetCacheState } from "../testing/env.js";
import {
  DEFAULT_IAM_OPERATION_CONNECT_WAIT_MS,
  DEFAULT_INITIAL_CONNECT_WAIT_MS,
  closeAllRedisConnections,
  findRedisConnection,
  getRedisConnection,
} from "./connection.js";
import { DEFAULT_IAM_REFRESH_INTERVAL_MS, type ResolvedIamOptions } from "./elasticache-iam.js";
import { getCacheRuntime } from "./runtime.js";

function iamOptions(
  credentials = vi.fn(async () => ({ accessKeyId: "AKID", secretAccessKey: "s" })),
) {
  const iam: ResolvedIamOptions = {
    userId: "app-user",
    cacheName: "my-cache",
    region: "us-east-1",
    serverless: false,
    credentials,
  };
  return { iam, credentials };
}

describe("a connection the package opens with IAM", () => {
  beforeEach(async () => {
    aws.available = true;
    clients.length = 0;
    await resetCacheState();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await closeAllRedisConnections();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("connects lazily, with the first token as the password and the user id as the user name", async () => {
    const { iam } = iamOptions();
    const connection = getRedisConnection({ host: "cache.aws", tls: true, password: "x", iam });
    const client = clients[0] as FakeClient;
    expect(client.options.lazyConnect).toBe(true);

    expect(await connection.waitForInitialConnection()).toBe(true);
    expect(client.connects).toHaveLength(1);
    expect(client.connects[0]?.username).toBe("app-user");
    expect(String(client.connects[0]?.password)).toMatch(
      /^my-cache\/\?Action=connect&User=app-user&X-Amz-Algorithm=AWS4-HMAC-SHA256&/,
    );
  });

  test("a slow token: requests wait 500 ms as without IAM, a one-off operation up to 5 s", async () => {
    vi.useFakeTimers();
    const credentials = vi.fn(
      () =>
        new Promise<{ accessKeyId: string; secretAccessKey: string }>((resolve) => {
          setTimeout(() => resolve({ accessKeyId: "AKID", secretAccessKey: "s" }), 3000);
        }),
    );
    const { iam } = iamOptions(credentials);
    const connection = getRedisConnection({ host: "cache.aws", tls: true, iam });
    const request = vi.fn();
    const operation = vi.fn();
    void connection.waitForInitialConnection().then(request);
    void connection.waitForOperationConnection().then(operation);

    await vi.advanceTimersByTimeAsync(DEFAULT_INITIAL_CONNECT_WAIT_MS);
    expect(request).toHaveBeenCalledWith(false);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(operation).toHaveBeenCalledWith(true);
    expect(connection.isReady()).toBe(true);
  });

  test("a one-off operation gives up after DEFAULT_IAM_OPERATION_CONNECT_WAIT_MS", async () => {
    vi.useFakeTimers();
    const { iam } = iamOptions(vi.fn(() => new Promise<never>(() => {})));
    const connection = getRedisConnection({ host: "cache.aws", tls: true, iam });
    const operation = vi.fn();
    void connection.waitForOperationConnection().then(operation);

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_OPERATION_CONNECT_WAIT_MS - 1);
    expect(operation).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(operation).toHaveBeenCalledWith(false);
  });

  test("close stops the refresh timer", async () => {
    vi.useFakeTimers();
    const { iam, credentials } = iamOptions();
    const connection = getRedisConnection({ host: "cache.aws", tls: true, iam });
    await vi.advanceTimersByTimeAsync(0);
    const client = clients[0] as FakeClient;
    expect(client.status).toBe("ready");

    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS);
    const minted = credentials.mock.calls.length;
    expect(client.auth).toHaveBeenCalledTimes(1);

    await connection.close();
    expect(client.quit).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DEFAULT_IAM_REFRESH_INTERVAL_MS * 3);
    expect(credentials.mock.calls.length).toBe(minted);
    expect(client.auth).toHaveBeenCalledTimes(1);
  });

  test("without the AWS packages it throws at startup with what to install, and keeps no client", () => {
    aws.available = false;
    const { iam } = iamOptions();
    const options = { host: "cache.aws", tls: true, iam };

    expect(() => getRedisConnection(options)).toThrow(
      /npm install @smithy\/signature-v4 @aws-crypto\/sha256-js @aws-sdk\/credential-provider-node/,
    );
    expect(clients[0]?.disconnect).toHaveBeenCalled();
    expect(findRedisConnection(options)).toBeUndefined();
  });

  test("without the AWS packages, connections without IAM are unaffected", async () => {
    aws.available = false;
    const connection = getRedisConnection({ url: "redis://localhost:6379" });
    expect(connection).toBeDefined();
    const index = await import("../index.js");
    expect(index.attachElastiCacheIamAuth).toBeTypeOf("function");
  });

  test("the iam option with a client of your own throws, pointing at attachElastiCacheIamAuth", () => {
    const client = new FakeClient() as unknown as Redis;
    expect(() =>
      getCacheRuntime({ client, iam: { userId: "u", cacheName: "c", region: "r" } }),
    ).toThrow(/attachElastiCacheIamAuth/);
  });

  test("IAM with ioredis options and no url fails at startup instead of connecting without it", () => {
    const redisOptions = { host: "cache.aws", port: 6379, tls: {} };
    expect(() =>
      getCacheRuntime({ redisOptions, iam: { userId: "u", cacheName: "c", region: "r" } }),
    ).toThrow(/The iam option needs a url/);

    process.env.ELASTICACHE_IAM_USER = "app-user";
    try {
      expect(() => getCacheRuntime({ redisOptions })).toThrow(
        /ELASTICACHE_IAM_USER needs a url or the ELASTICACHE_\* environment/,
      );
    } finally {
      Reflect.deleteProperty(process.env, "ELASTICACHE_IAM_USER");
    }
    expect(clients).toHaveLength(0);
  });

  test("ELASTICACHE_IAM_USER with TLS off fails the handler at startup", () => {
    process.env.ELASTICACHE_ENDPOINT = "cache.aws";
    process.env.ELASTICACHE_IAM_USER = "app-user";
    process.env.ELASTICACHE_CACHE_NAME = "my-cache";
    process.env.ELASTICACHE_REGION = "us-east-1";
    process.env.ELASTICACHE_TLS = "false";
    try {
      expect(() => getCacheRuntime()).toThrow(/TLS is off/);
    } finally {
      for (const name of ["ELASTICACHE_IAM_USER", "ELASTICACHE_CACHE_NAME", "ELASTICACHE_REGION"]) {
        Reflect.deleteProperty(process.env, name);
      }
    }
  });
});
