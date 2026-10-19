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
import {
  DEFAULT_ERROR_LOG_INTERVAL_MS,
  createErrorReporter,
} from "../data-cache/error-reporter.js";
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
 * and never logged, since it can hold a password.
 */
function connectionKey(options: RedisConnectionOptions): string {
  const { errorLogIntervalMs: _ignored, ...rest } = options;
  return stableStringify(rest);
}

/**
 * JSON with object keys sorted at every level, so nested options (`redisOptions`, `tls`) are part
 * of the key and their order does not matter. Functions (e.g. `retryStrategy`) count by source.
 */
function stableStringify(value: unknown): string {
  if (typeof value === "function") return JSON.stringify(`fn:${value.toString()}`);
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/**
 * Drop the connection after `max` command timeouts in a row. `commandTimeout` rejects a command
 * without closing the socket, so a stalled server would otherwise stay `ready` and cost every
 * cached call its full timeout. `disconnect(true)` makes the client not ready at once and
 * reconnects with the usual backoff.
 */
function dropConnectionOnTimeouts(client: Redis, max: number, onDrop: () => void): void {
  let timeouts = 0;
  const sendCommand = client.sendCommand.bind(client);
  client.sendCommand = ((command, stream) => {
    const result = sendCommand(command, stream);
    command.promise.then(
      () => {
        timeouts = 0;
      },
      (error: Error | undefined) => {
        if (error?.message !== TIMEOUT_MESSAGE) return;
        timeouts += 1;
        if (timeouts < max) return;
        timeouts = 0;
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
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    ...(options.password ? { password: options.password } : {}),
    ...(options.tls ? { tls: {} } : {}),
    ...options.redisOptions,
  };

  if (options.host) {
    return new RedisClient({ ...clientOptions, host: options.host, port: options.port ?? 6379 });
  }
  if (!options.url && options.redisOptions) {
    // An ioredis options object (e.g. 16.5's `new RedisCacheHandler({ redis: { host, port } })`).
    return new RedisClient(clientOptions);
  }
  return new RedisClient(options.url ?? "redis://localhost:6379", clientOptions);
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
 * command) is raced against `commandTimeout`; the client and its options are left as they are,
 * and the command itself is not cancelled. After `max` timeouts in a row the client is reported
 * not ready for `cooldownMs`; after that, the first command that succeeds marks it ready again
 * and calls `onRecover` (as a reconnect would). Only the package's calls go through the proxy.
 */
function watchUnownedClient(
  client: RedisClientLike,
  options: { commandTimeout: number; max: number; cooldownMs: number },
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
    timeouts += 1;
    if (timeouts < options.max) return;
    // One more timeout after the cooldown marks it again at once.
    timeouts = options.max - 1;
    unhealthyUntil = Date.now() + options.cooldownMs;
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

  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result: unknown = value.apply(target, args);
        return result instanceof Promise ? withTimeout(result) : result;
      };
    },
  });

  return { proxy, health: { healthy: () => Date.now() >= unhealthyUntil } };
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
  > & { owned?: boolean; unownedCooldownMs?: number } = {},
): RedisConnection {
  const owned = options.owned ?? true;
  const reportError = createErrorReporter(
    "[RedisCache]:",
    options.errorLogIntervalMs ?? DEFAULT_ERROR_LOG_INTERVAL_MS,
  );
  const initialConnectWaitMs = options.initialConnectWaitMs ?? DEFAULT_INITIAL_CONNECT_WAIT_MS;
  const maxTimeouts = options.maxConsecutiveTimeouts ?? DEFAULT_MAX_CONSECUTIVE_TIMEOUTS;
  const readyListeners = new Set<() => void>();

  // Log each change of state once. Never the URL: it can carry credentials.
  let state: "connecting" | "up" | "down" = client.status === "ready" ? "up" : "connecting";
  client.on("ready", () => {
    if (state === "down") console.info("[RedisCache]: Redis connected again");
    state = "up";
  });
  client.on("error", (error: Error) => {
    if (state !== "down") {
      console.warn(
        "[RedisCache]: Redis unavailable, serving from memory until it reconnects:",
        error.message,
      );
    }
    state = "down";
    reportError("connection", error);
  });

  let commandClient = client;
  let health: UnownedHealth = { healthy: () => true };
  if (owned) {
    dropConnectionOnTimeouts(client as Redis, maxTimeouts, () => {
      console.warn("[RedisCache]: Redis stopped answering, reconnecting and serving from memory");
    });
  } else {
    const watched = watchUnownedClient(
      client,
      {
        commandTimeout: options.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT_MS,
        max: maxTimeouts,
        cooldownMs: options.unownedCooldownMs ?? DEFAULT_UNOWNED_COOLDOWN_MS,
      },
      () => {
        console.warn("[RedisCache]: Redis stopped answering, serving from memory");
      },
      () => {
        console.info("[RedisCache]: Redis answering again");
        for (const listener of readyListeners) listener();
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
      client.on("ready", listener);
      readyListeners.add(listener);
      return () => {
        client.off("ready", listener);
        readyListeners.delete(listener);
      };
    },
    async close() {
      if (!owned) return;
      await client.quit().catch(() => client.disconnect());
    },
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
  options: { commandTimeout?: number } = {},
): RedisConnection {
  const connections = getClientConnections();
  const existing = connections.get(client);
  if (existing) return existing;
  const connection = createRedisConnection(client, {
    owned: false,
    ...(options.commandTimeout === undefined ? {} : { commandTimeout: options.commandTimeout }),
  });
  connections.set(client, connection);
  return connection;
}

/**
 * Get the process-wide connection for these options, opening it on first use. Every handler
 * created with the same options shares it.
 */
export function getRedisConnection(options: RedisConnectionOptions = {}): RedisConnection {
  const registry = getRegistry();
  const key = connectionKey(options);
  const existing = registry.get(key);
  if (existing) return existing;

  const connection = createRedisConnection(buildClient(options), options);
  const close = connection.close;
  const shared: RedisConnection = {
    ...connection,
    async close() {
      if (registry.get(key) === shared) registry.delete(key);
      await close();
    },
  };
  registry.set(key, shared);
  return shared;
}

/**
 * Close and forget every shared connection. For tests and graceful shutdown.
 */
export async function closeAllRedisConnections(): Promise<void> {
  const registry = getRegistry();
  const connections = [...registry.values()];
  registry.clear();
  await Promise.all(connections.map((connection) => connection.close()));
}
