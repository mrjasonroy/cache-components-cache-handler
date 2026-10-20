/**
 * The cache logger: every warning, error and debug line goes to it when one is set (a handler's
 * `logger`, else `setCacheLogger`), the console gets exactly what it got before otherwise, a
 * logger that throws never fails a cache call, and no line carries a password.
 */

import { createRequire } from "node:module";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { FakeRedis } from "../testing/fake-redis.js";

const redis = vi.hoisted(() => ({
  created: [] as FakeRedis[],
  /** Tag writes are refused while set. */
  readonly: false,
  /** Tag writes throw this while set. */
  failWith: undefined as Error | undefined,
}));

// ioredis is loaded with `requireModule` (Node's `require`), which `vi.mock("ioredis")` cannot reach.
vi.mock("./node-require.js", async (importOriginal) => {
  const { FakeRedis: Fake } = await import("../testing/fake-redis.js");
  return {
    ...(await importOriginal<typeof import("./node-require.js")>()),
    requireModule: (moduleName: string) => {
      if (moduleName !== "ioredis") throw new Error(`Unexpected require for module: ${moduleName}`);
      return function Redis() {
        const client = new Fake();
        const evalsha = client.evalsha.bind(client);
        vi.spyOn(client, "evalsha").mockImplementation(async (...args) => {
          if (redis.readonly)
            throw new Error("READONLY You can't write against a read only replica.");
          if (redis.failWith) throw redis.failWith;
          return evalsha(...args);
        });
        redis.created.push(client);
        return client;
      };
    },
  };
});

import { createRemoteCacheHandler } from "../data-cache/remote.js";
import { CompositeHandler } from "../handlers/composite.js";
import { createRedisCacheHandler } from "../handlers/redis.js";
import { withCache } from "../helpers/with-cache.js";
import { setCacheLogger } from "../index.js";
import { resetCacheState } from "../testing/env.js";
import { getRedisConnection } from "./connection.js";
import { createErrorReporter } from "./error-reporter.js";
import { type CacheLogger, redactForLog } from "./logger.js";
import { createDebugLog, getCacheRuntime } from "./runtime.js";

const PASSWORD = "s3cr3t-pw";
const url = `redis://user:${PASSWORD}@logger-test:6379`;

interface Line {
  level: string;
  message: string;
  meta: Record<string, unknown> | undefined;
}

function recorder(): { logger: Required<CacheLogger>; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: string) =>
    (message: string, meta?: Record<string, unknown>): void => {
      lines.push({ level, message, meta });
    };
  return {
    lines,
    logger: { error: at("error"), warn: at("warn"), info: at("info"), debug: at("debug") },
  };
}

function entry(text: string) {
  return Promise.resolve({
    value: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
    tags: ["products"],
    stale: 30,
    timestamp: Date.now(),
    expire: 300,
    revalidate: 60,
  });
}

/** Everything a line hands the logger, as text, errors by message and stack. */
function text(line: Line): string {
  const seen = new WeakSet();
  return `${line.message} ${JSON.stringify(line.meta ?? {}, (_key, value: unknown) => {
    if (value instanceof Error) return `${value.message} ${value.stack}`;
    if (value && typeof value === "object") {
      if (seen.has(value)) return "[seen]";
      seen.add(value);
    }
    return value;
  })}`;
}

/**
 * The error ioredis 5.8 emits when Redis rejects AUTH: a `ReplyError` from `redis-errors` to which
 * `DataHandler.returnError` attached the command, with its arguments (DataHandler.js:40).
 */
function authError(): Error {
  const fromIoredis = createRequire(createRequire(import.meta.url).resolve("ioredis"));
  const { ReplyError } = fromIoredis("redis-errors") as { ReplyError: new (m: string) => Error };
  const error = new ReplyError("WRONGPASS invalid username-password pair or user is disabled.");
  Object.assign(error, { command: { name: "auth", args: ["app-user", PASSWORD] } });
  return error;
}

/** Everything a call hands over, as `console` would print it, hidden properties included. */
function inspected(args: unknown[]): string {
  return args
    .map((arg) => inspect(arg, { depth: Number.POSITIVE_INFINITY, showHidden: true }))
    .join(" ");
}

const consoleMethods = ["error", "warn", "info", "debug", "log"] as const;

function spyConsole() {
  return Object.fromEntries(
    consoleMethods.map((name) => [name, vi.spyOn(console, name).mockImplementation(() => {})]),
  ) as Record<(typeof consoleMethods)[number], ReturnType<typeof vi.spyOn>>;
}

describe("the cache logger", () => {
  beforeEach(async () => {
    await resetCacheState();
    redis.created.length = 0;
    redis.readonly = false;
  });

  afterEach(async () => {
    redis.readonly = false;
    redis.failWith = undefined;
    vi.unstubAllEnvs();
    await resetCacheState();
    vi.restoreAllMocks();
  });

  test("without a logger, the console gets what it got before", () => {
    const console = spyConsole();
    const error = new Error("boom");
    createErrorReporter("[RedisCache]:")("get", error);
    expect(console.error).toHaveBeenCalledWith(
      "[RedisCache]: get failed (further get errors suppressed for 60s)",
      error,
    );

    createDebugLog("[RemoteCache]:", true)?.("get", "k", { bytes: 3 });
    expect(console.debug).toHaveBeenCalledWith("[RemoteCache]:", "get", "k", { bytes: 3 });

    getCacheRuntime({ url, keyPrefix: "app:" });
    redis.created[0]?.goDown();
    expect(console.warn).toHaveBeenCalledWith(
      "[RedisCache]: Redis unavailable, serving from memory until it reconnects:",
      "ECONNREFUSED",
    );
    redis.created[0]?.comeUp();
    expect(console.info).toHaveBeenCalledWith("[RedisCache]: Redis connected again");
  });

  test("every warning, error and debug line goes to the process logger, none to the console", async () => {
    const console = spyConsole();
    const { logger, lines } = recorder();
    setCacheLogger(logger);

    // Connection: down (a warning and a rate-limited error), up again (info).
    const handler = createRemoteCacheHandler({
      url,
      keyPrefix: "app:",
      buildId: "b1",
      debug: true,
    });
    await handler.get("k", []);
    redis.created[0]?.goDown();
    redis.created[0]?.comeUp();
    // Tag store: a refused revalidation.
    redis.readonly = true;
    await handler.updateTags(["products"]);
    // A second connection to the same server with other settings.
    getCacheRuntime({ url, keyPrefix: "app:", commandTimeout: 250 });
    // withCache keeping a page memory size.
    withCache({ cacheMaxMemorySize: 5 });
    // The deprecated composite handler.
    await new CompositeHandler({
      handlers: [
        {
          name: "broken",
          get: () => Promise.reject(new Error("down")),
          set: () => Promise.resolve(),
          revalidateTag: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        },
      ],
    } as unknown as ConstructorParameters<typeof CompositeHandler>[0]).get("k");

    for (const name of consoleMethods) expect(console[name]).not.toHaveBeenCalled();
    const messages = lines.map((line) => `${line.level} ${line.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^debug \[RemoteCache\]: get k/),
        "warn [RedisCache]: Redis unavailable, serving from memory until it reconnects: ECONNREFUSED",
        "error [RedisCache]: connection failed (further connection errors suppressed for 60s)",
        "info [RedisCache]: Redis connected again",
        "error [RedisCache]: updateTags failed (further updateTags errors suppressed for 60s)",
        expect.stringMatching(/^warn \[RedisCache\]: a second connection to the same Redis server/),
        expect.stringMatching(/^warn withCache: keeping cacheMaxMemorySize: 5\./),
        "error Handler broken failed:",
      ]),
    );
    const refused = lines.find((line) => line.message.startsWith("[RedisCache]: updateTags"));
    expect(refused?.meta).toMatchObject({ operation: "updateTags", error: expect.any(Error) });
  });

  test("a handler's logger wins over the process logger, for that handler", async () => {
    spyConsole();
    const own = recorder();
    const process = recorder();
    setCacheLogger(process.logger);
    const handler = createRemoteCacheHandler({
      url,
      keyPrefix: "app:",
      buildId: "b1",
      debug: true,
      logger: own.logger,
    });
    await handler.get("k", []);
    expect(own.lines.some((line) => line.message.startsWith("[RemoteCache]: get k"))).toBe(true);
    expect(process.lines).toEqual([]);
  });

  test("a page handler that opens the runtime logs its connection and tag errors to its logger", async () => {
    spyConsole();
    const own = recorder();
    const process = recorder();
    setCacheLogger(process.logger);
    const Handler = createRedisCacheHandler({ url, keyPrefix: "app:", logger: own.logger });
    const handler = new Handler();
    await handler.get("/a", { kind: "APP_PAGE" } as never);
    redis.created[0]?.goDown();
    redis.created[0]?.comeUp();
    redis.readonly = true;
    await handler.revalidateTag("products");

    const levels = own.lines.map((line) => `${line.level} ${line.message}`);
    expect(levels).toContainEqual(expect.stringMatching(/^warn \[RedisCache\]: Redis unavailable/));
    expect(levels).toContainEqual(
      expect.stringMatching(/^error \[RedisCache\]: connection failed/),
    );
    expect(levels).toContainEqual(
      expect.stringMatching(/^error \[RedisCache\]: updateTags failed/),
    );
    expect(process.lines).toEqual([]);
  });

  test("a logger without info or debug drops those lines", () => {
    const console = spyConsole();
    setCacheLogger({ error: () => {}, warn: () => {} });
    createDebugLog("[RemoteCache]:", true)?.("get", "k");
    expect(console.debug).not.toHaveBeenCalled();
  });

  test("a logger that throws never fails get, set or updateTags; its lines go to the console", async () => {
    const console = spyConsole();
    const throwing = () => {
      throw new Error("logger broke");
    };
    setCacheLogger({ error: throwing, warn: throwing, info: throwing, debug: throwing });
    const handler = createRemoteCacheHandler({
      url,
      keyPrefix: "app:",
      buildId: "b1",
      debug: true,
    });

    await handler.set("k", entry("hello"));
    expect(await handler.get("k", [])).toBeDefined();
    redis.readonly = true;
    await expect(handler.updateTags(["products"])).resolves.toBeUndefined();

    const reports = console.error.mock.calls.filter(
      ([message]) =>
        message === "[RedisCache]: the cache logger threw; its lines go to the console",
    );
    expect(reports).toHaveLength(1);
    expect(console.debug).toHaveBeenCalledWith(
      "[RemoteCache]:",
      "set",
      "k",
      expect.anything(),
      expect.anything(),
    );
    expect(console.error).toHaveBeenCalledWith(
      "[RedisCache]: updateTags failed (further updateTags errors suppressed for 60s)",
      expect.any(Error),
    );
  });

  test("a logger set in one module graph is used by another", async () => {
    spyConsole();
    const { logger, lines } = recorder();
    vi.resetModules();
    const graphA = await import("./logger.js");
    graphA.setCacheLogger(logger);
    vi.resetModules();
    const graphB = await import("./error-reporter.js");
    expect(graphB.createErrorReporter).not.toBe(createErrorReporter);
    graphB.createErrorReporter("[RedisCache]:")("get", new Error("down"));
    expect(lines.map((line) => line.message)).toEqual([
      "[RedisCache]: get failed (further get errors suppressed for 60s)",
    ]);
  });

  test.each(["logger", "console"])(
    "a rejected AUTH never puts the password in a line, to the %s",
    async (destination) => {
      const consoleCalls = spyConsole();
      const { logger, lines } = recorder();
      if (destination === "logger") setCacheLogger(logger);

      const handler = createRemoteCacheHandler({ url, keyPrefix: "app:", buildId: "b1" });
      await handler.get("k", []);
      const client = redis.created[0];
      if (!client) throw new Error("no client");
      client.goDown(authError());
      client.comeUp();
      redis.failWith = authError();
      await handler.updateTags(["products"]);

      const written = [
        ...lines.map((line) => inspected([line.message, line.meta])),
        ...Object.values(consoleCalls).flatMap((spy) =>
          spy.mock.calls.map((call: unknown[]) => inspected(call)),
        ),
      ];
      expect(written.join("\n")).toContain("WRONGPASS");
      for (const line of written) expect(line).not.toContain(PASSWORD);
    },
  );

  test("a redacted error keeps its name, message, code and stack, and nothing else", () => {
    const error = authError();
    Object.assign(error, { code: "WRONGPASS", cause: authError() });
    const safe = redactForLog({ error, args: ["k", 1], url, nested: { password: PASSWORD } });

    expect(safe.error).toBeInstanceOf(Error);
    expect(safe.error.name).toBe("ReplyError");
    expect(safe.error.message).toBe(error.message);
    expect(safe.error.stack).toBe(error.stack);
    expect((safe.error as { code?: string }).code).toBe("WRONGPASS");
    expect(Object.keys(safe.error)).toEqual(["code"]);
    expect(safe.args).toEqual(["k", 1]);
    expect(safe.url).toBe("redis://[redacted]@logger-test:6379");
    expect(inspected([safe])).not.toContain(PASSWORD);
  });

  test("no line carries the password of the Redis URL or options", async () => {
    spyConsole();
    const { logger, lines } = recorder();
    setCacheLogger(logger);
    vi.stubEnv("CACHE_DEBUG", "1");

    const handler = createRemoteCacheHandler({ url, keyPrefix: "app:", buildId: "b1" });
    await handler.set("k", entry("hello"));
    await handler.get("k", []);
    redis.created[0]?.goDown();
    redis.created[0]?.comeUp();
    redis.readonly = true;
    await handler.updateTags(["products"]);
    getCacheRuntime({ url, keyPrefix: "app:", commandTimeout: 250 });
    getRedisConnection({ redisOptions: { host: "logger-test", password: PASSWORD } });
    getRedisConnection({
      redisOptions: { host: "logger-test", password: PASSWORD, commandTimeout: 99 },
    });

    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(text(line)).not.toContain(PASSWORD);
  });
});
