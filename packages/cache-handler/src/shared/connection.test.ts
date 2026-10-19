import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Enough of an ioredis client for the connection: events, `status`,
 * `sendCommand` (whose command carries a `promise`) and the close methods.
 */
class FakeClient extends EventEmitter {
  status = "connecting";
  readonly constructorArgs: unknown[];
  sendCommand = vi.fn((_command: { promise: Promise<unknown> }) => undefined);
  quit = vi.fn(async () => "OK");
  disconnect = vi.fn((_reconnect?: boolean) => {
    this.status = "reconnecting";
  });

  constructor(...args: unknown[]) {
    super();
    this.constructorArgs = args;
  }

  becomeReady() {
    this.status = "ready";
    this.emit("ready");
  }
}

const ioredisMock = vi.hoisted(() =>
  vi.fn(function (this: unknown, ...args: unknown[]) {
    return new FakeClient(...args);
  }),
);

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-require.js")>()),
  requireModule: (moduleName: string) => {
    if (moduleName === "ioredis") return ioredisMock;
    throw new Error(`Unexpected require for module: ${moduleName}`);
  },
}));

import type { Redis } from "ioredis";
import {
  closeAllRedisConnections,
  createRedisConnection,
  getClientConnection,
  getRedisConnection,
} from "./connection.js";

function asRedis(client: FakeClient): Redis {
  return client as unknown as Redis;
}

/**
 * Run a command through the (wrapped) `sendCommand` that settles with `outcome`.
 */
async function runCommand(client: FakeClient, outcome: "ok" | "timeout" | "other-error") {
  const promise =
    outcome === "ok"
      ? Promise.resolve("OK")
      : Promise.reject(new Error(outcome === "timeout" ? "Command timed out" : "ERR other"));
  promise.catch(() => {});
  client.sendCommand({ promise });
  await promise.catch(() => {});
  // Let the wrapper's handlers run.
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createRedisConnection", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("waitForInitialConnection resolves true when the client becomes ready", async () => {
    const client = new FakeClient();
    const connection = createRedisConnection(asRedis(client));
    expect(connection.isReady()).toBe(false);

    client.becomeReady();
    expect(await connection.waitForInitialConnection()).toBe(true);
    expect(connection.isReady()).toBe(true);
  });

  test("waitForInitialConnection resolves true at once for an already-ready client", async () => {
    const client = new FakeClient();
    client.status = "ready";
    const connection = createRedisConnection(asRedis(client));
    expect(await connection.waitForInitialConnection()).toBe(true);
  });

  test("waitForInitialConnection resolves false on a connection error", async () => {
    const client = new FakeClient();
    const connection = createRedisConnection(asRedis(client), { initialConnectWaitMs: 60_000 });

    client.emit("error", new Error("ECONNREFUSED"));
    expect(await connection.waitForInitialConnection()).toBe(false);
    // Settled once: a later ready does not change the answer.
    client.becomeReady();
    expect(await connection.waitForInitialConnection()).toBe(false);
    expect(connection.isReady()).toBe(true);
  });

  test("waitForInitialConnection resolves false after initialConnectWaitMs", async () => {
    vi.useFakeTimers();
    const client = new FakeClient();
    const connection = createRedisConnection(asRedis(client), { initialConnectWaitMs: 500 });

    let result: boolean | undefined;
    void connection.waitForInitialConnection().then((ready) => {
      result = ready;
    });

    await vi.advanceTimersByTimeAsync(499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  test("waitForInitialConnection defaults to a 500ms wait", async () => {
    vi.useFakeTimers();
    const connection = createRedisConnection(asRedis(new FakeClient()));

    let result: boolean | undefined;
    void connection.waitForInitialConnection().then((ready) => {
      result = ready;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
  });

  test("onReady fires on every ready and can be removed", () => {
    const client = new FakeClient();
    const connection = createRedisConnection(asRedis(client));
    const listener = vi.fn();
    const remove = connection.onReady(listener);

    client.becomeReady();
    client.becomeReady();
    expect(listener).toHaveBeenCalledTimes(2);

    remove();
    client.becomeReady();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test("drops the connection after 3 consecutive command timeouts", async () => {
    const client = new FakeClient();
    const original = client.sendCommand;
    createRedisConnection(asRedis(client));
    client.becomeReady();

    await runCommand(client, "timeout");
    await runCommand(client, "timeout");
    expect(client.disconnect).not.toHaveBeenCalled();
    await runCommand(client, "timeout");
    expect(client.disconnect).toHaveBeenCalledTimes(1);
    expect(client.disconnect).toHaveBeenCalledWith(true);
    // Commands still reach the real sendCommand.
    expect(original).toHaveBeenCalledTimes(3);

    // The count starts over after a drop.
    await runCommand(client, "timeout");
    await runCommand(client, "timeout");
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  test("a successful command resets the timeout count", async () => {
    const client = new FakeClient();
    createRedisConnection(asRedis(client));

    await runCommand(client, "timeout");
    await runCommand(client, "timeout");
    await runCommand(client, "ok");
    await runCommand(client, "timeout");
    await runCommand(client, "timeout");
    expect(client.disconnect).not.toHaveBeenCalled();

    await runCommand(client, "timeout");
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  test("errors other than timeouts do not count", async () => {
    const client = new FakeClient();
    createRedisConnection(asRedis(client), { maxConsecutiveTimeouts: 2 });

    await runCommand(client, "timeout");
    await runCommand(client, "other-error");
    await runCommand(client, "other-error");
    expect(client.disconnect).not.toHaveBeenCalled();
    await runCommand(client, "timeout");
    expect(client.disconnect).toHaveBeenCalledWith(true);
  });

  test("logs each state change once", () => {
    const warn = vi.mocked(console.warn);
    const info = vi.mocked(console.info);
    const client = new FakeClient();
    createRedisConnection(asRedis(client));

    client.becomeReady();
    expect(info).not.toHaveBeenCalled();

    client.emit("error", new Error("ECONNRESET"));
    client.emit("error", new Error("ECONNRESET"));
    expect(warn).toHaveBeenCalledTimes(1);

    client.becomeReady();
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("connected again");
  });

  test("close quits the client, and disconnects if quit fails", async () => {
    const client = new FakeClient();
    await createRedisConnection(asRedis(client)).close();
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();

    const failing = new FakeClient();
    failing.quit.mockRejectedValueOnce(new Error("Connection is closed."));
    await createRedisConnection(asRedis(failing)).close();
    expect(failing.disconnect).toHaveBeenCalled();
  });
});

describe("getRedisConnection", () => {
  beforeEach(() => {
    ioredisMock.mockClear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    await closeAllRedisConnections();
    vi.restoreAllMocks();
  });

  test("shares one connection per set of options", () => {
    const a = getRedisConnection({ url: "redis://a:6379" });
    const b = getRedisConnection({ url: "redis://a:6379" });
    expect(b).toBe(a);
    expect(b.client).toBe(a.client);

    const c = getRedisConnection({ url: "redis://b:6379" });
    const d = getRedisConnection({ url: "redis://a:6379", commandTimeout: 250 });
    expect(c).not.toBe(a);
    expect(d).not.toBe(a);
    expect(ioredisMock).toHaveBeenCalledTimes(3);
  });

  test("option order does not matter, and the log interval does not split the pool", () => {
    const a = getRedisConnection({ url: "redis://a:6379", commandTimeout: 250 });
    const b = getRedisConnection({ commandTimeout: 250, url: "redis://a:6379" });
    const c = getRedisConnection({
      url: "redis://a:6379",
      commandTimeout: 250,
      errorLogIntervalMs: 5,
    });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test("nested redisOptions keep different servers apart, in any key order", () => {
    const a = getRedisConnection({ redisOptions: { host: "10.0.0.1", db: 1 } });
    const b = getRedisConnection({ redisOptions: { host: "10.0.0.2", port: 6380, db: 5 } });
    const c = getRedisConnection({ redisOptions: { db: 1, host: "10.0.0.1" } });
    const d = getRedisConnection({ redisOptions: { host: "10.0.0.1", tls: { servername: "x" } } });
    const e = getRedisConnection({ redisOptions: { host: "10.0.0.1", tls: { servername: "y" } } });
    expect(b).not.toBe(a);
    expect(c).toBe(a);
    expect(e).not.toBe(d);
  });

  test("close removes the connection from the registry", async () => {
    const a = getRedisConnection({ url: "redis://a:6379" });
    await a.close();
    expect((a.client as unknown as FakeClient).quit).toHaveBeenCalledTimes(1);

    const b = getRedisConnection({ url: "redis://a:6379" });
    expect(b).not.toBe(a);
    expect(ioredisMock).toHaveBeenCalledTimes(2);
  });

  test("closeAllRedisConnections closes and forgets every connection", async () => {
    const a = getRedisConnection({ url: "redis://a:6379" });
    const b = getRedisConnection({ url: "redis://b:6379" });
    await closeAllRedisConnections();

    expect((a.client as unknown as FakeClient).quit).toHaveBeenCalled();
    expect((b.client as unknown as FakeClient).quit).toHaveBeenCalled();
    expect(getRedisConnection({ url: "redis://a:6379" })).not.toBe(a);
  });

  test("builds a resilient client", () => {
    getRedisConnection({ url: "redis://a:6379" });
    const [url, options] = ioredisMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(url).toBe("redis://a:6379");
    expect(options).toMatchObject({
      enableOfflineQueue: false,
      commandTimeout: 1000,
      socketTimeout: 2000,
      keepAlive: 10_000,
      maxRetriesPerRequest: 1,
    });
    const retryStrategy = options.retryStrategy as (times: number) => number;
    expect(retryStrategy(1)).toBe(200);
    expect(retryStrategy(10)).toBe(2000);
    expect(retryStrategy(1000)).toBe(5000);
  });

  test("uses host and port when host is set", () => {
    getRedisConnection({ host: "cache.internal", port: 6380, tls: true, password: "pw" });
    expect(ioredisMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: "cache.internal", port: 6380, tls: {}, password: "pw" }),
    );
  });

  test("never logs credentials", () => {
    const connection = getRedisConnection({
      url: "redis://admin:s3cret-url@cache:6379",
      password: "s3cret-pw",
    });
    const client = connection.client as unknown as FakeClient;

    client.emit("error", new Error("ECONNREFUSED"));
    client.becomeReady();
    client.emit("error", new Error("ETIMEDOUT"));
    client.becomeReady();

    const logged = [console.warn, console.info, console.error, console.log, console.debug]
      .flatMap((fn) => (vi.isMockFunction(fn) ? fn.mock.calls : []))
      .flat()
      .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg)))
      .join("\n");

    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain("s3cret");
  });
});

describe("a client the application passes in", () => {
  /** An application client whose commands answer, or never answer while stalled. */
  class AppClient extends EventEmitter {
    status = "ready";
    stalled = false;
    readonly options = { commandTimeout: undefined, enableOfflineQueue: true };
    disconnect = vi.fn();
    quit = vi.fn(async () => "OK");
    get = vi.fn((key: string) => (this.stalled ? new Promise(() => {}) : Promise.resolve(key)));
  }

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("its commands are bounded by commandTimeout without touching the client", async () => {
    const app = new AppClient();
    const connection = getClientConnection(app as unknown as Redis, { commandTimeout: 20 });
    expect(await (connection.client as unknown as AppClient).get("k")).toBe("k");

    app.stalled = true;
    await expect((connection.client as unknown as AppClient).get("k")).rejects.toThrow(
      "Command timed out",
    );
    expect(app.options).toEqual({ commandTimeout: undefined, enableOfflineQueue: true });
    expect(Object.hasOwn(app, "sendCommand")).toBe(false);
  });

  test("3 timeouts in a row: not ready for the cooldown, never disconnected, ready again after a success", async () => {
    const app = new AppClient();
    const connection = createRedisConnection(app as unknown as Redis, {
      owned: false,
      commandTimeout: 10,
      unownedCooldownMs: 50,
    });
    const onReady = vi.fn();
    connection.onReady(onReady);
    const client = connection.client as unknown as AppClient;

    app.stalled = true;
    for (let i = 0; i < 3; i++) await client.get("k").catch(() => {});
    expect(connection.isReady()).toBe(false);
    expect(app.disconnect).not.toHaveBeenCalled();

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(connection.isReady()).toBe(true);
    app.stalled = false;
    await client.get("k");
    expect(onReady).toHaveBeenCalledTimes(1);

    await connection.close();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.disconnect).not.toHaveBeenCalled();
  });

  test("a reply that arrives after its timeout neither resets the count nor marks it recovered", async () => {
    vi.useFakeTimers();
    const app = new AppClient();
    // A server that answers every command, but only after 1.5 s.
    app.get.mockImplementation(
      (key: string) => new Promise((resolve) => setTimeout(() => resolve(key), 1_500)),
    );
    const connection = createRedisConnection(app as unknown as Redis, {
      owned: false,
      commandTimeout: 1_000,
      unownedCooldownMs: 60_000,
    });
    const onReady = vi.fn();
    connection.onReady(onReady);
    const client = connection.client as unknown as AppClient;

    // Three commands in a row each time out; the earlier ones' late replies land in between.
    for (let i = 0; i < 3; i++) {
      const pending = client.get("k").catch(() => "timed out");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toBe("timed out");
    }
    expect(connection.isReady()).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(connection.isReady()).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
  });
});
