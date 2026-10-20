/**
 * The per-process state every handler shares: the Redis connection (or none), the key prefix,
 * the tag store and the in-process memory stores. One runtime exists per connection and key
 * prefix, registered on `globalThis`, so Next loading the handler modules more than once, or
 * constructing the singular handler per request, never adds a connection or splits tag state.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { MAX_STORED_ENTRY_BYTES } from "./codec.js";
import {
  type RedisClientLike,
  type RedisConnection,
  type RedisConnectionOptions,
  connectionKey,
  detachAllRedisConnections,
  findRedisConnection,
  getClientConnection,
  getRedisConnection,
  openRedisConnection,
} from "./connection.js";
import {
  isDebugEnabled,
  resolveEnvConnectionOptions,
  resolveKeyPrefix,
  shouldUseRedis,
} from "./env.js";
import { type ErrorReporter, createErrorReporter } from "./error-reporter.js";
import { type CacheLogger, type LoggerSource, debugWriter, loggerSource } from "./logger.js";
import { MemoryStore, clearAllMemoryStores } from "./memory-store.js";
import {
  type TagStateKey,
  clearTagStatesForTests,
  releaseTagState,
  tagStateOf,
} from "./tag-states.js";
import { TagStore } from "./tag-store.js";

/**
 * Tag an entry with this (`cacheTag(MEMORY_ONLY_TAG)`, or in a page's tags) to keep it out of
 * Redis, for per-instance data such as health checks or build info.
 */
export const MEMORY_ONLY_TAG = "cache:memory-only";

/**
 * Longest time an entry written while Redis is down is served, in seconds.
 */
export const FALLBACK_TTL_SECONDS = 60;

/**
 * Options shared by every handler factory and `flushCache`. Runtime settings normally come from
 * the environment (see the README); these override them in a custom handler file.
 */
export interface CacheOptions {
  /**
   * Redis URL (`redis://` or `rediss://`, password included).
   * @default process.env.REDIS_URL ?? process.env.VALKEY_URL ?? the ElastiCache env; unset → memory only
   */
  url?: string;

  /**
   * Bring your own ioredis `Redis` or `Cluster` (overrides `url`). You own its lifecycle and
   * options: the package never quits, disconnects or reconfigures it. The package's own commands
   * on it are still bounded by `commandTimeout`, and after 3 timeouts in a row the handlers serve
   * from memory for 2 s at a time until a command succeeds again. Your other uses of the client
   * are unaffected.
   */
  client?: Redis | Cluster;

  /**
   * Prefix for every key.
   * @default process.env.CACHE_KEY_PREFIX ?? "nextjs:"
   */
  keyPrefix?: string;

  /**
   * Serve from memory (each entry at most 60 s) while Redis is down. `false` → miss instead.
   * @default true
   */
  memoryFallback?: boolean;

  /**
   * Per-command timeout, in ms. Also applies, through a wrapper, to a `client` you pass in.
   * @default 1000
   */
  commandTimeout?: number;

  /**
   * Milliseconds to wait for the connection to open. Not used with `client`.
   * @default 2000 (10000 with the `ELASTICACHE_*` host form)
   */
  connectTimeout?: number;

  /**
   * Milliseconds a pending command may go without a reply before the connection is dropped and
   * reopened. Not used with `client`.
   * @default 2000
   */
  socketTimeout?: number;

  /**
   * Consecutive command timeouts after which an owned connection is dropped and reopened, or a
   * passed `client` is treated as down for 2 s.
   * @default 3
   */
  maxConsecutiveTimeouts?: number;

  /**
   * Log hits, misses and state changes. Never logs the URL.
   * @default `CACHE_DEBUG` is `1` or `true`
   */
  debug?: boolean;

  /**
   * Where this handler's warnings, errors and debug lines go, instead of the logger set with
   * `setCacheLogger` or the console. The connection and tag state that handlers share log through
   * the logger of the handler that opened them, so give every handler the same one (or use
   * `setCacheLogger`). Never given a Redis URL or the connection options.
   */
  logger?: CacheLogger;
}

/**
 * Internal extension of {@link CacheOptions} for the 16.5 `RedisCacheHandler` options.
 * @internal
 */
export interface RuntimeOptions extends CacheOptions {
  /** ioredis options object, from 16.5's `redis: RedisOptions`. */
  redisOptions?: RedisOptions;
}

/**
 * The in-process stores.
 */
export interface RuntimeStores {
  /** Page entries kept in memory: memory-only ones, or all of them without Redis. */
  page: MemoryStore<unknown>;
  /** Page entries written while Redis is down. Emptied on reconnect. */
  pageFallback: MemoryStore<unknown>;
  /** Remote data entries kept in memory: memory-only ones, or all of them without Redis. */
  data: MemoryStore<unknown>;
  /** Remote data entries written while Redis is down. Emptied on reconnect. */
  dataFallback: MemoryStore<unknown>;
  /** `"use cache"` values of the local handler. */
  local: MemoryStore<unknown>;
  /**
   * The tag list last seen for each page or remote entry's Redis key, so the next `get` reads
   * those tag records in the same round trip as the entry.
   */
  entryTags: MemoryStore<string[]>;
}

/**
 * Shared per-process state for one connection and key prefix.
 */
export interface CacheRuntime {
  /** The Redis connection, or `undefined` in memory-only mode (no URL, build, `CACHE_REDIS=off`). */
  readonly connection: RedisConnection | undefined;
  readonly keyPrefix: string;
  readonly tags: TagStore;
  readonly stores: RuntimeStores;
  /** Rate-limited error log. */
  readonly reportError: ErrorReporter;
  /**
   * True once {@link closeCache} has dropped this runtime: its connection is closed and its
   * stores are gone. A handler then asks {@link getCacheRuntime} again ({@link liveCacheRuntime}).
   */
  readonly closed: boolean;
}

/** A runtime as this module holds it: it can be marked closed and let go of its listeners. */
interface OwnedRuntime extends CacheRuntime {
  closed: boolean;
  /**
   * The key of this runtime's tag state, which the next runtime of the same connection and key
   * prefix uses too; `undefined` without Redis, whose tag state is this process's only.
   */
  readonly stateKey: TagStateKey | undefined;
  /** Stop following the connection and leave the memory store registry. */
  dispose(): void;
}

const REGISTRY_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/runtimes");
const CONNECTION_IDS_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/connection-ids");

function getRegistry(): Map<string, OwnedRuntime> {
  const store = globalThis as unknown as Record<symbol, Map<string, OwnedRuntime> | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = new Map();
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * The connection these options ask for: the application's client, the options of a connection
 * of the package's own, or `undefined` for memory only (`next build`, `CACHE_REDIS=off`).
 */
function connectionRequest(
  options: RuntimeOptions,
): { client: RedisClientLike } | { options: RedisConnectionOptions } | undefined {
  if (!shouldUseRedis()) return undefined;
  if (options.client) return { client: options.client };

  const tuning = definedOnly({
    commandTimeout: options.commandTimeout,
    connectTimeout: options.connectTimeout,
    socketTimeout: options.socketTimeout,
    maxConsecutiveTimeouts: options.maxConsecutiveTimeouts,
  });
  if (options.redisOptions && !options.url) {
    return { options: { ...tuning, redisOptions: options.redisOptions } };
  }
  const connectionOptions = resolveEnvConnectionOptions({ url: options.url, ...tuning });
  return connectionOptions ? { options: connectionOptions } : undefined;
}

/**
 * The connection these options ask for, or `undefined` for memory only. Never connects during
 * `next build` or with `CACHE_REDIS=off`.
 */
export function resolveConnection(options: RuntimeOptions = {}): RedisConnection | undefined {
  return connectionFor(connectionRequest(options), options);
}

function connectionFor(
  request: ReturnType<typeof connectionRequest>,
  options: RuntimeOptions,
): RedisConnection | undefined {
  if (!request) return undefined;
  const logger = loggerSource(options.logger);
  if ("client" in request) {
    const { commandTimeout, maxConsecutiveTimeouts } = options;
    return getClientConnection(request.client, {
      ...definedOnly({ commandTimeout, maxConsecutiveTimeouts }),
      logger,
    });
  }
  return getRedisConnection(request.options, logger);
}

/**
 * `options` without its undefined values, so they neither override a default nor split the
 * connection pool.
 */
function definedOnly<T extends object>(options: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/**
 * The connection's id in the runtime registry key. Kept on `globalThis` with the registry: the
 * connections are shared by every module graph, so their ids must be too, or a second graph
 * numbering them from 1 again would get another connection's runtime (see DEC-5).
 */
function connectionId(connection: RedisConnection | undefined): string {
  if (!connection) return "memory";
  const store = globalThis as unknown as Record<
    symbol,
    { ids: WeakMap<RedisConnection, number>; next: number } | undefined
  >;
  let state = store[CONNECTION_IDS_KEY];
  if (!state) {
    state = { ids: new WeakMap(), next: 1 };
    store[CONNECTION_IDS_KEY] = state;
  }
  let id = state.ids.get(connection);
  if (id === undefined) {
    id = state.next++;
    state.ids.set(connection, id);
  }
  return String(id);
}

/**
 * The shared runtime for these options, created on first use.
 */
export function getCacheRuntime(options: RuntimeOptions = {}): CacheRuntime {
  const request = connectionRequest(options);
  const connection = connectionFor(request, options);
  const keyPrefix = options.keyPrefix ?? resolveKeyPrefix();
  const registry = getRegistry();
  const key = `${connectionId(connection)}|${keyPrefix}`;
  const existing = registry.get(key);
  if (existing) return existing;

  // Unlike `key`, the same for the connection that replaces a closed one: an application client
  // keeps its connection, and a connection of the package's own is pooled by its options.
  const stateKey: TagStateKey | undefined =
    request && connection
      ? "client" in request
        ? { client: request.client, keyPrefix }
        : { pooled: connectionKey(request.options), keyPrefix }
      : undefined;
  const runtime = createRuntime(connection, keyPrefix, loggerSource(options.logger), {
    stateKey,
    // Once closed, its tag store sends updates to the live runtime of the same options.
    liveStore: () => getCacheRuntime({ ...options, keyPrefix }).tags,
  });
  registry.set(key, runtime);
  return runtime;
}

/**
 * The current runtime for these options: the one {@link getCacheRuntime} gave, until
 * {@link closeCache} closes it, and then a new one, on a new connection. Handlers that live
 * longer than a request (the `cacheHandlers` singletons, a page handler kept by a test) read
 * their runtime through this, so they reconnect on next use after a close instead of keeping a
 * closed connection.
 */
export function liveCacheRuntime(options: RuntimeOptions = {}): () => CacheRuntime {
  let runtime = getCacheRuntime(options);
  return () => {
    if (runtime.closed) runtime = getCacheRuntime(options);
    return runtime;
  };
}

/**
 * A runtime for one operation outside the handlers (`flushCache`). The shared runtime when its
 * connection is already open (a handler opened it) or is not the package's own (memory only, an
 * application client); otherwise a runtime on a connection of its own, which `release` closes and
 * whose memory stores it unregisters, so that a script that only flushes keeps neither a client
 * open (and its process alive) nor stores registered after. `shared` says which.
 */
export function acquireCacheRuntime(options: RuntimeOptions = {}): {
  runtime: CacheRuntime;
  shared: boolean;
  release(): Promise<void>;
} {
  const request = connectionRequest(options);
  if (!request || "client" in request || findRedisConnection(request.options)) {
    return { runtime: getCacheRuntime(options), shared: true, release: async () => {} };
  }
  const logger = loggerSource(options.logger);
  const connection = openRedisConnection(request.options, logger);
  const runtime = createRuntime(connection, options.keyPrefix ?? resolveKeyPrefix(), logger);
  return {
    runtime,
    shared: false,
    async release() {
      runtime.dispose();
      await connection.close();
    },
  };
}

/**
 * Bytes of page entries kept in memory per store. The size of the largest stored entry today, but
 * a memory budget, not the codec's inflation cap: the two may change apart.
 */
const PAGE_MEMORY_MAX_BYTES = MAX_STORED_ENTRY_BYTES;

function createRuntime(
  connection: RedisConnection | undefined,
  keyPrefix: string,
  logger: LoggerSource,
  shared?: { stateKey: TagStateKey | undefined; liveStore(): TagStore },
): OwnedRuntime {
  const stores: RuntimeStores = {
    page: new MemoryStore({ maxBytes: PAGE_MEMORY_MAX_BYTES }),
    pageFallback: new MemoryStore({ maxBytes: PAGE_MEMORY_MAX_BYTES }),
    data: new MemoryStore(),
    dataFallback: new MemoryStore(),
    local: new MemoryStore({ maxEntries: 10_000 }),
    entryTags: new MemoryStore({ maxEntries: 10_000, maxBytes: 8 * 1024 * 1024 }),
  };
  // Outage entries are never read once Redis is back; dropping them frees the memory.
  const stopListening = connection?.onReady(() => {
    stores.pageFallback.clear();
    stores.dataFallback.clear();
  });
  const stateKey = shared?.stateKey;
  const tags = new TagStore(connection, keyPrefix, {
    logger,
    state: stateKey && tagStateOf(stateKey),
    key: shared && {
      liveStore: shared.liveStore,
      currentState: () =>
        stateKey ? tagStateOf(stateKey) : { records: new Map(), unsent: new Map() },
    },
  });

  return {
    connection,
    keyPrefix,
    tags,
    stores,
    reportError: createErrorReporter("[RedisCache]:", undefined, logger),
    closed: false,
    stateKey,
    dispose() {
      stopListening?.();
      tags.dispose();
      for (const store of Object.values(stores)) store.unregister();
    },
  };
}

/** The last close requested while one may still run; the next one starts once it has finished. */
let lastClose: Promise<void> | undefined;

/**
 * Close every Redis connection this package opened in this process, empty its in-process memory
 * stores and drop its tag state, so that a test runner, script or custom server can exit. A
 * client the application passed in (`client`) is never closed or disconnected. Safe to call more
 * than once: a call made while another runs closes, after it, whatever was opened meanwhile.
 *
 * Handlers are not broken by it: a handler created before the call opens a new connection on its
 * next use, and every handler of a connection and key prefix shares the new one, as before.
 *
 * @example
 * ```ts
 * // jest / vitest
 * import { closeCache } from "@mrjasonroy/cache-components-cache-handler";
 * afterAll(() => closeCache());
 * ```
 */
export function closeCache(): Promise<void> {
  // A cache call during a close opens a new connection; a later call must close that one too, so
  // it runs a close of its own after the current one rather than sharing it.
  // The first starts at once, so the runtimes are closed before the caller goes on.
  const close = lastClose ? lastClose.then(closeOnce, closeOnce) : closeOnce();
  lastClose = close;
  const settled = () => {
    if (lastClose === close) lastClose = undefined;
  };
  close.then(settled, settled);
  return close;
}

async function closeOnce(): Promise<void> {
  // Everything up to the first await runs at once, so a cache call made during the close gets a
  // new runtime, on a new connection, which takes over the tag state of its key, and an update on
  // a closed runtime goes to that one.
  const registry = getRegistry();
  const runtimes = [...registry.values()];
  registry.clear();
  const connections = detachAllRedisConnections();
  for (const runtime of runtimes) {
    runtime.closed = true;
    runtime.tags.close();
  }
  clearAllMemoryStores();
  await Promise.allSettled(runtimes.map((runtime) => runtime.tags.drain()));
  // Dropped unless a newer runtime has taken it over or Redis has not taken all of it; a kept
  // state is the next runtime's of its key.
  for (const runtime of runtimes) {
    if (runtime.stateKey) releaseTagState(runtime.stateKey, runtime.tags);
  }
  for (const runtime of runtimes) runtime.dispose();
  await Promise.all(connections.map((connection) => connection.close()));
}

/**
 * Forget every runtime (their tag state and memory stores). Test-only.
 * @internal
 */
export function resetCacheRuntimesForTests(): void {
  getRegistry().clear();
  clearTagStatesForTests();
}

/**
 * Debug lines under `prefix` when debug logging is on (`debug` or `CACHE_DEBUG=1`): the logger's
 * `debug`, or `console.debug`.
 */
export function createDebugLog(
  prefix: string,
  debug: boolean | undefined,
  logger?: CacheLogger,
): ((...args: unknown[]) => void) | undefined {
  return (debug ?? isDebugEnabled()) ? debugWriter(prefix, loggerSource(logger)) : undefined;
}

/**
 * True while the runtime's Redis can take commands. The first call in a process waits, briefly,
 * for the first connection.
 */
export async function isRedisReady(runtime: CacheRuntime): Promise<boolean> {
  const connection = runtime.connection;
  if (!connection) return false;
  await connection.waitForInitialConnection();
  return connection.isReady();
}

/**
 * Read a stream into one Buffer.
 */
export async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  return Buffer.from(await new Response(stream).arrayBuffer());
}

/**
 * A new single-use stream over `bytes`.
 */
export function bufferToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}
