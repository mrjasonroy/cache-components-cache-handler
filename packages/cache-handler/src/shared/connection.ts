/**
 * One ioredis connection per process, shared by every handler that asks for the same server.
 *
 * Next.js loads the `cacheHandlers` modules once per process and constructs the singular
 * `cacheHandler` class per request, and a build can load the same module more than once. The
 * registry lives on `globalThis`, so the "use cache" handlers and the page cache handler get one
 * pool and one view of Redis health, however many times they are created.
 *
 * A cache must never take the site down with it, so the client:
 * - never queues commands while disconnected (`enableOfflineQueue: false`) and times them out
 *   (`commandTimeout`), so callers can fall back to memory instead of waiting;
 * - never resends a command after a reconnect (`autoResendUnfulfilledCommands: false`): its
 *   caller has long since had its timeout and moved on;
 * - reconnects forever with a backoff capped at 5s (`retryStrategy` never returns `null`, which
 *   would end the client for good);
 * - drops a connection that stops answering without closing: `socketTimeout` when a pending
 *   command gets no reply, TCP keepalive when the peer is gone, and `maxConsecutiveTimeouts`
 *   command timeouts in a row.
 *
 * A client the application passes in (`CacheOptions.client`) is wrapped, never configured: the
 * application owns its lifecycle and its settings, so it is never patched, quit or disconnected.
 * The handlers reach it through a proxy instead ({@link watchUnownedClient}): each of their
 * commands is bounded by `commandTimeout`, and `maxConsecutiveTimeouts` timeouts in a row mark the
 * connection not ready (handlers fall back to memory) for a short cooldown, without touching the
 * client.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { nowMs } from "./clock.js";
import { DEFAULT_ERROR_LOG_INTERVAL_MS, createErrorReporter } from "./error-reporter.js";
import { type LoggerSource, processLogger, writeLog } from "./logger.js";
import { requireModule } from "./node-require.js";

const REGISTRY_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/connections");
const TIMEOUT_MESSAGE = "Command timed out";

export const DEFAULT_COMMAND_TIMEOUT_MS = 1000;
export const DEFAULT_CONNECT_TIMEOUT_MS = 2000;
export const DEFAULT_SOCKET_TIMEOUT_MS = 2000;
export const DEFAULT_KEEP_ALIVE_MS = 10_000;
export const DEFAULT_INITIAL_CONNECT_WAIT_MS = 500;
export const DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 3;
/** How long an application client stays marked not ready after repeated timeouts, in ms. */
export const DEFAULT_UNOWNED_COOLDOWN_MS = 2000;

export interface RedisConnectionOptions {
  /**
   * Redis URL, e.g. `redis://localhost:6379` or `rediss://user:pass@host:6380`. Ignored when
   * `host` is set.
   */
  url?: string;

  /**
   * Hostname, for endpoints given as host and port (e.g. ElastiCache).
   */
  host?: string;

  /**
   * Port, with `host`.
   * @default 6379
   */
  port?: number;

  /**
   * Password or auth token.
   */
  password?: string;

  /**
   * Enable TLS.
   * @default false
   */
  tls?: boolean;

  /**
   * Per-command timeout in ms. A command that gets no reply in time fails, and the handler
   * treats it as a miss or falls back to memory.
   * @default 1000
   */
  commandTimeout?: number;

  /**
   * Connect timeout in ms.
   * @default 2000
   */
  connectTimeout?: number;

  /**
   * Drop the connection when a pending command gets no reply for this many ms.
   * @default 2000
   */
  socketTimeout?: number;

  /**
   * Start TCP keepalive probes after this many ms idle.
   * @default 10000
   */
  keepAlive?: number;

  /**
   * How long the first cache call in a process waits for the first connection, in ms. Bounded,
   * so a process that starts without Redis serves from memory instead of hanging. A refused
   * connection ends the wait at once, and later outages never wait.
   * @default 500
   */
  initialConnectWaitMs?: number;

  /**
   * Drop and rebuild the connection after this many command timeouts in a row: a half-open or
   * stalled server keeps the client `ready` while every command waits out its timeout.
   * @default 3
   */
  maxConsecutiveTimeouts?: number;

  /**
   * Minimum time in ms between two logged connection errors.
   * @default 60000
   */
  errorLogIntervalMs?: number;

  /**
   * Extra ioredis options, applied last.
   */
  redisOptions?: RedisOptions;
}

/**
 * A process-wide ioredis client plus the state the handlers need to choose between Redis and
 * their memory fallback.
 */
export interface RedisConnection {
  /**
   * The ioredis client (`Redis` or `Cluster`). Share it; never `quit()` it from a handler.
   */
  readonly client: RedisClientLike;

  /**
   * True when this package opened the client and may close it; false for a client the
   * application passed in.
   */
  readonly owned: boolean;

  /**
   * True while the client can run commands.
   */
  isReady(): boolean;

  /**
   * Resolves once the first connection is ready (`true`), fails or has taken
   * `initialConnectWaitMs` (`false`). Settled once per connection.
   */
  waitForInitialConnection(): Promise<boolean>;

  /**
   * Call `listener` every time the client becomes ready, including after a reconnect.
   * Returns a function that removes the listener.
   */
  onReady(listener: () => void): () => void;

  /**
   * Close the client and forget it, so the next request for this server opens a new one.
   */
  close(): Promise<void>;

  /**
   * Counters since the connection was created, for tests and diagnostics. Internal.
   * @internal
   */
  stats(): ConnectionStats;
}

/**
 * What a connection has seen of the server's health.
 * @internal
 */
export interface ConnectionStats {
  /** Commands of the package's that timed out (`commandTimeout`), each counted once. */
  readonly timeouts: number;
  /**
   * Times the connection was given up on after `maxConsecutiveTimeouts` timeouts in a row:
   * dropped and redialled (a client the package opened), or marked not ready (an application's).
   */
  readonly drops: number;
}

interface MutableStats {
  timeouts: number;
  drops: number;
}

/**
 * An ioredis `Redis` or `Cluster` client.
 */
export type RedisClientLike = Redis | Cluster;

type Registry = Map<string, RedisConnection>;

const CLIENT_CONNECTIONS_KEY = Symbol.for(
  "@mrjasonroy/cache-components-cache-handler/client-connections",
);

function getClientConnections(): WeakMap<object, RedisConnection> {
  const store = globalThis as unknown as Record<
    symbol,
    WeakMap<object, RedisConnection> | undefined
  >;
  let connections = store[CLIENT_CONNECTIONS_KEY];
  if (!connections) {
    connections = new WeakMap();
    store[CLIENT_CONNECTIONS_KEY] = connections;
  }
  return connections;
}

function getRegistry(): Registry {
  const store = globalThis as unknown as Record<symbol, Registry | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = new Map();
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

function loadIoredis(): typeof import("ioredis").default {
  try {
    return requireModule<typeof import("ioredis").default>("ioredis");
  } catch {
    throw new Error(
      "ioredis is required for the Redis cache handlers. Install it with: npm install ioredis",
    );
  }
}

/**
 * The registry key: which server, as whom, and with which client settings. Kept in memory only
 * and never logged, since it can hold a password. Options that differ only in their error log
 * interval share one connection.
 */
export function connectionKey(options: RedisConnectionOptions): string {
  const { errorLogIntervalMs: _ignored, ...rest } = options;
  return stableStringify(rest);
}

/** Options that tune a connection without changing which server it reaches, or as whom. */
const TUNING_OPTIONS = [
  "commandTimeout",
  "connectTimeout",
  "socketTimeout",
  "keepAlive",
  "initialConnectWaitMs",
  "maxConsecutiveTimeouts",
  "errorLogIntervalMs",
] as const;

/**
 * A registry key without the tuning: two keys with the same server key reach the same server.
 * `undefined` for a key that is not JSON (an option holding a symbol, or `undefined` in an array).
 */
function serverKey(key: string): string | undefined {
  try {
    const options = JSON.parse(key) as Record<string, unknown>;
    for (const name of TUNING_OPTIONS) delete options[name];
    return stableStringify(options);
  } catch {
    return undefined;
  }
}

/** Servers already warned about, by server key: one warning per server per module graph. */
const warnedSplits = new Set<string>();

/**
 * Forget which servers were warned about, so each test sees its own warning. Test-only.
 * @internal
 */
export function resetSplitWarningsForTests(): void {
  warnedSplits.clear();
}

/**
 * Warn, once per server, when a connection opens to a server another connection already reaches
 * with different tuning: the handlers then no longer share one client and one tag state (DEC-4).
 * Never logs the options, which can hold a password.
 */
function warnOnSplit(registry: Registry, key: string, logger: LoggerSource): void {
  const server = serverKey(key);
  // Only a warning: a key it cannot read is skipped, never a reason to fail the connection.
  if (server === undefined || warnedSplits.has(server)) return;
  if (![...registry.keys()].some((other) => other !== key && serverKey(other) === server)) return;
  warnedSplits.add(server);
  writeLog(
    logger,
    "warn",
    "[RedisCache]: a second connection to the same Redis server was opened with different connection settings (commandTimeout, connectTimeout, socketTimeout, maxConsecutiveTimeouts...), so these handlers do not share one client or one tag state. Give every handler the same settings.",
    undefined,
  );
}

/**
 * JSON with object keys sorted at every level, so nested options (`redisOptions`, `tls`) are part
 * of the key and their order does not matter. Functions (e.g. `retryStrategy`) count by source.
 * Throws on an object that contains itself, which no key can describe; `path` names it.
 */
function stableStringify(value: unknown, path = "", ancestors: object[] = []): string {
  if (typeof value === "function") return JSON.stringify(`fn:${value.toString()}`);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (ancestors.includes(value)) {
    throw new Error(
      `Redis connection options must be serializable: ${path} refers back to an enclosing object`,
    );
  }
  const inner = [...ancestors, value];
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => stableStringify(item, `${path}[${i}]`, inner)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item, path ? `${path}.${key}` : key, inner)}`).join(",")}}`;
}

/**
 * Drop the connection after `max` command timeouts in a row. `commandTimeout` rejects a command
 * without closing the socket, so a stalled server would otherwise stay `ready` and cost every
 * cached call its full timeout. `disconnect(true)` makes the client not ready at once and
 * reconnects with the usual backoff.
 *
 * Each command is watched once. ioredis can send a command object again (on reconnect, when
 * `autoResendUnfulfilledCommands` is on, or on a Cluster redirection), and its promise may have
 * been rejected long before: counting it again turned every reconnect into a fresh run of
 * "timeouts" and dropped the connection again, forever.
 */
function dropConnectionOnTimeouts(
  client: Redis,
  max: number,
  stats: MutableStats,
  onDrop: () => void,
): void {
  let timeouts = 0;
  const watched = new WeakSet<object>();
  const sendCommand = client.sendCommand.bind(client);
  client.sendCommand = ((command, stream) => {
    const result = sendCommand(command, stream);
    if (watched.has(command)) return result;
    watched.add(command);
    command.promise.then(
      () => {
        timeouts = 0;
      },
      (error: Error | undefined) => {
        if (error?.message !== TIMEOUT_MESSAGE) return;
        stats.timeouts += 1;
        timeouts += 1;
        if (timeouts < max) return;
        timeouts = 0;
        stats.drops += 1;
        onDrop();
        client.disconnect(true);
      },
    );
    return result;
  }) as Redis["sendCommand"];
}

function buildClient(options: RedisConnectionOptions): Redis {
  const RedisClient = loadIoredis();
  const clientOptions: RedisOptions = {
    connectTimeout: options.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_MS,
    commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
    socketTimeout: options.socketTimeout ?? DEFAULT_SOCKET_TIMEOUT_MS,
    keepAlive: options.keepAlive ?? DEFAULT_KEEP_ALIVE_MS,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    autoResendUnfulfilledCommands: false,
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    ...(options.password ? { password: options.password } : {}),
    ...(options.tls ? { tls: {} } : {}),
    ...options.redisOptions,
  };

  if (options.host) {
    return new RedisClient({ ...clientOptions, host: options.host, port: options.port ?? 6379 });
  }
  if (!options.url && options.redisOptions) {
    // An ioredis options object (e.g. 16.4.2's `new RedisCacheHandler({ redis: { host, port } })`).
    return new RedisClient(clientOptions);
  }
  return new RedisClient(options.url ?? "redis://localhost:6379", clientOptions);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Health of an application client, seen only through the package's own commands.
 */
interface UnownedHealth {
  /** False while the client is marked not ready after repeated timeouts. */
  healthy(): boolean;
}

/**
 * A proxy over a client the application owns. Every method call that returns a promise (a
 * command) is raced against `commandTimeout`, also on a Cluster's master clients and on a
 * pipeline's `exec`; the client and its options are left as they are,
 * and the command itself is not cancelled. After `max` timeouts in a row the client is reported
 * not ready for `cooldownMs`; after that, the first command that succeeds marks it ready again
 * and calls `onRecover` (as a reconnect would). Only the package's calls go through the proxy.
 */
function watchUnownedClient(
  client: RedisClientLike,
  options: { commandTimeout: number; max: number; cooldownMs: number },
  stats: MutableStats,
  onUnhealthy: () => void,
  onRecover: () => void,
): { proxy: RedisClientLike; health: UnownedHealth } {
  let timeouts = 0;
  let unhealthyUntil = 0;
  let marked = false;

  const settled = (timedOut: boolean) => {
    if (!timedOut) {
      timeouts = 0;
      if (marked) {
        marked = false;
        onRecover();
      }
      return;
    }
    stats.timeouts += 1;
    timeouts += 1;
    if (timeouts < options.max) return;
    // One more timeout after the cooldown marks it again at once.
    timeouts = options.max - 1;
    stats.drops += 1;
    unhealthyUntil = nowMs() + options.cooldownMs;
    if (!marked) onUnhealthy();
    marked = true;
  };

  const withTimeout = (result: Promise<unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      // A reply that arrives after its timeout says nothing about the server's health now: it
      // must not reset the count or mark the client recovered.
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        settled(true);
        reject(new Error(TIMEOUT_MESSAGE));
      }, options.commandTimeout);
      timer.unref?.();
      result.then(
        (value) => {
          if (timedOut) return;
          clearTimeout(timer);
          settled(false);
          resolve(value);
        },
        (error: unknown) => {
          if (timedOut) return;
          clearTimeout(timer);
          // A reply, even an error reply, means the server answers.
          settled(false);
          reject(error);
        },
      );
    });

  // A Cluster's master clients (`nodes()`, used by flushCache's SCAN) and a pipeline's `exec` run
  // outside the client's own methods, so what they return is bounded the same way.
  const bound = <T extends object>(object: T): T =>
    new Proxy(object, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = value.apply(target, args);
          if (result instanceof Promise) return withTimeout(result);
          if (property === "nodes" && Array.isArray(result)) {
            return result.map((node: object) => bound(node));
          }
          if ((property === "pipeline" || property === "multi") && isObject(result)) {
            return bound(result);
          }
          return result;
        };
      },
    });

  return { proxy: bound(client), health: { healthy: () => nowMs() >= unhealthyUntil } };
}

/**
 * Wrap an ioredis client in a {@link RedisConnection}. The client is not registered for sharing;
 * use {@link getRedisConnection} or {@link getClientConnection} for that.
 *
 * With `owned: false` (a client the application passed in) the client is only observed: its
 * options are not changed, it is never patched, quit or disconnected, and `connection.client` is a
 * proxy that bounds the package's own commands by `commandTimeout` (see the module comment).
 */
export function createRedisConnection(
  client: RedisClientLike,
  options: Pick<
    RedisConnectionOptions,
    "initialConnectWaitMs" | "maxConsecutiveTimeouts" | "errorLogIntervalMs" | "commandTimeout"
  > & { owned?: boolean; unownedCooldownMs?: number; logger?: LoggerSource } = {},
): RedisConnection {
  const owned = options.owned ?? true;
  const logger = options.logger ?? processLogger;
  const reportError = createErrorReporter(
    "[RedisCache]:",
    options.errorLogIntervalMs ?? DEFAULT_ERROR_LOG_INTERVAL_MS,
    logger,
  );
  const info = (message: string) => writeLog(logger, "info", message, undefined);
  const warn = (message: string) => writeLog(logger, "warn", message, undefined);
  const initialConnectWaitMs = options.initialConnectWaitMs ?? DEFAULT_INITIAL_CONNECT_WAIT_MS;
  const maxTimeouts = options.maxConsecutiveTimeouts ?? DEFAULT_MAX_CONSECUTIVE_TIMEOUTS;
  // Subscribers to `ready`: one client listener calls them all, so the client's listener count
  // stays the same however many runtimes (key prefixes) share the connection.
  const readyListeners = new Set<() => void>();
  const notifyReady = () => {
    for (const listener of [...readyListeners]) listener();
  };
  const stats: MutableStats = { timeouts: 0, drops: 0 };

  // Log each change of state once. Never the URL: it can carry credentials.
  let state: "connecting" | "up" | "down" = client.status === "ready" ? "up" : "connecting";
  client.on("ready", () => {
    if (state === "down") info("[RedisCache]: Redis connected again");
    state = "up";
    notifyReady();
  });
  client.on("error", (error: Error) => {
    if (state !== "down") {
      const message = "[RedisCache]: Redis unavailable, serving from memory until it reconnects:";
      writeLog(logger, "warn", `${message} ${error.message}`, { error }, [message, error.message]);
    }
    state = "down";
    reportError("connection", error);
  });

  let commandClient = client;
  let health: UnownedHealth = { healthy: () => true };
  if (owned) {
    dropConnectionOnTimeouts(client as Redis, maxTimeouts, stats, () => {
      warn("[RedisCache]: Redis stopped answering, reconnecting and serving from memory");
    });
  } else {
    const watched = watchUnownedClient(
      client,
      {
        commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
        max: maxTimeouts,
        cooldownMs: options.unownedCooldownMs ?? DEFAULT_UNOWNED_COOLDOWN_MS,
      },
      stats,
      () => {
        warn("[RedisCache]: Redis stopped answering, serving from memory");
      },
      () => {
        info("[RedisCache]: Redis answering again");
        notifyReady();
      },
    );
    commandClient = watched.proxy;
    health = watched.health;
  }

  const initialConnection = new Promise<boolean>((resolve) => {
    if (client.status === "ready") {
      resolve(true);
      return;
    }
    const settle = (ready: boolean) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      resolve(ready);
    };
    const onReady = () => settle(true);
    const onError = () => settle(false);
    const timer = setTimeout(() => settle(false), initialConnectWaitMs);
    timer.unref?.();
    client.once("ready", onReady);
    client.once("error", onError);
  });

  return {
    client: commandClient,
    owned,
    isReady: () => client.status === "ready" && health.healthy(),
    waitForInitialConnection: () => initialConnection,
    onReady(listener) {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    async close() {
      if (!owned) return;
      await client.quit().catch(() => client.disconnect());
    },
    stats: () => ({ ...stats }),
  };
}

/**
 * The connection for a client the application created. One per client per process; the client
 * is never closed, disconnected or reconfigured by this package. The package's own commands on it
 * are bounded by `commandTimeout` (default 1000 ms; the first caller's value is used for the
 * process), and repeated timeouts make the handlers serve from memory for a short while.
 */
export function getClientConnection(
  client: RedisClientLike,
  options: { commandTimeout?: number; maxConsecutiveTimeouts?: number; logger?: LoggerSource } = {},
): RedisConnection {
  const connections = getClientConnections();
  const existing = connections.get(client);
  if (existing) return existing;
  const connection = createRedisConnection(client, {
    owned: false,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.commandTimeout === undefined ? {} : { commandTimeout: options.commandTimeout }),
    ...(options.maxConsecutiveTimeouts === undefined
      ? {}
      : { maxConsecutiveTimeouts: options.maxConsecutiveTimeouts }),
  });
  connections.set(client, connection);
  return connection;
}

/**
 * The process-wide connection for these options if one is open, without opening one.
 */
export function findRedisConnection(
  options: RedisConnectionOptions = {},
): RedisConnection | undefined {
  return getRegistry().get(connectionKey(options));
}

/**
 * A new connection for these options, not shared: only the caller uses it, and closes it.
 */
export function openRedisConnection(
  options: RedisConnectionOptions = {},
  logger: LoggerSource = processLogger,
): RedisConnection {
  return createRedisConnection(buildClient(options), { ...options, logger });
}

/**
 * Get the process-wide connection for these options, opening it on first use. Every handler
 * created with the same options shares it, and the logger of the first.
 */
export function getRedisConnection(
  options: RedisConnectionOptions = {},
  logger: LoggerSource = processLogger,
): RedisConnection {
  const registry = getRegistry();
  const key = connectionKey(options);
  const existing = registry.get(key);
  if (existing) return existing;

  const connection = openRedisConnection(options, logger);
  const close = connection.close;
  const shared: RedisConnection = {
    ...connection,
    async close() {
      if (registry.get(key) === shared) registry.delete(key);
      await close();
    },
  };
  registry.set(key, shared);
  warnOnSplit(registry, key, logger);
  return shared;
}

/**
 * Close and forget every shared connection. For tests and graceful shutdown.
 */
export async function closeAllRedisConnections(): Promise<void> {
  await Promise.all(detachAllRedisConnections().map((connection) => connection.close()));
}

/**
 * Forget every shared connection without closing it, and return them: a connection asked for
 * from now on is a new one.
 */
export function detachAllRedisConnections(): RedisConnection[] {
  const registry = getRegistry();
  const connections = [...registry.values()];
  registry.clear();
  return connections;
}
