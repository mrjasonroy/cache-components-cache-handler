/**
 * The per-process state every handler shares: the Redis connection (or none), the key prefix,
 * the tag store and the in-process memory stores. One runtime exists per connection and key
 * prefix, registered on `globalThis`, so Next loading the handler modules more than once, or
 * constructing the singular handler per request, never adds a connection or splits tag state.
 */

import type { Cluster, Redis, RedisOptions } from "ioredis";
import { type ErrorReporter, createErrorReporter } from "../data-cache/error-reporter.js";
import {
  type RedisConnection,
  type RedisConnectionOptions,
  getClientConnection,
  getRedisConnection,
} from "./connection.js";
import {
  isDebugEnabled,
  resolveEnvConnectionOptions,
  resolveKeyPrefix,
  shouldUseRedis,
} from "./env.js";
import { MemoryStore } from "./memory-store.js";
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
   * Log hits, misses and state changes. Never logs the URL.
   * @default process.env.CACHE_DEBUG === "1"
   */
  debug?: boolean;
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
   * The tag list last seen for each page entry's Redis key, so the next `get` reads those tag
   * records in the same round trip as the entry.
   */
  pageTags: MemoryStore<string[]>;
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
}

const REGISTRY_KEY = Symbol.for("@mrjasonroy/cache-components-cache-handler/runtimes");
const CONNECTION_IDS = new WeakMap<RedisConnection, number>();
let nextConnectionId = 1;

function getRegistry(): Map<string, CacheRuntime> {
  const store = globalThis as unknown as Record<symbol, Map<string, CacheRuntime> | undefined>;
  let registry = store[REGISTRY_KEY];
  if (!registry) {
    registry = new Map();
    store[REGISTRY_KEY] = registry;
  }
  return registry;
}

/**
 * The connection these options ask for, or `undefined` for memory only. Never connects during
 * `next build` or with `CACHE_REDIS=off`.
 */
export function resolveConnection(options: RuntimeOptions = {}): RedisConnection | undefined {
  if (!shouldUseRedis()) return undefined;
  if (options.client) {
    return getClientConnection(
      options.client,
      options.commandTimeout === undefined ? {} : { commandTimeout: options.commandTimeout },
    );
  }

  const timeout =
    options.commandTimeout === undefined ? {} : { commandTimeout: options.commandTimeout };
  if (options.redisOptions && !options.url) {
    const connectionOptions: RedisConnectionOptions = {
      ...timeout,
      redisOptions: options.redisOptions,
    };
    return getRedisConnection(connectionOptions);
  }
  const connectionOptions = resolveEnvConnectionOptions({ url: options.url, ...timeout });
  return connectionOptions ? getRedisConnection(connectionOptions) : undefined;
}

function connectionId(connection: RedisConnection | undefined): string {
  if (!connection) return "memory";
  let id = CONNECTION_IDS.get(connection);
  if (id === undefined) {
    id = nextConnectionId++;
    CONNECTION_IDS.set(connection, id);
  }
  return String(id);
}

/**
 * The shared runtime for these options, created on first use.
 */
export function getCacheRuntime(options: RuntimeOptions = {}): CacheRuntime {
  const connection = resolveConnection(options);
  const keyPrefix = options.keyPrefix ?? resolveKeyPrefix();
  const registry = getRegistry();
  const key = `${connectionId(connection)}|${keyPrefix}`;
  const existing = registry.get(key);
  if (existing) return existing;

  const stores: RuntimeStores = {
    page: new MemoryStore({ maxBytes: 64 * 1024 * 1024 }),
    pageFallback: new MemoryStore({ maxBytes: 64 * 1024 * 1024 }),
    data: new MemoryStore(),
    dataFallback: new MemoryStore(),
    local: new MemoryStore({ maxEntries: 10_000 }),
    pageTags: new MemoryStore({ maxEntries: 10_000, maxBytes: 8 * 1024 * 1024 }),
  };
  // Outage entries are never read once Redis is back; dropping them frees the memory.
  connection?.onReady(() => {
    stores.pageFallback.clear();
    stores.dataFallback.clear();
  });

  const runtime: CacheRuntime = {
    connection,
    keyPrefix,
    tags: new TagStore(connection, keyPrefix),
    stores,
    reportError: createErrorReporter("[RedisCache]:"),
  };
  registry.set(key, runtime);
  return runtime;
}

/**
 * Forget every runtime (their tag state and memory stores). Test-only.
 * @internal
 */
export function resetCacheRuntimesForTests(): void {
  getRegistry().clear();
}

/**
 * `console.debug` under `prefix` when debug logging is on (`debug` or `CACHE_DEBUG=1`).
 */
export function createDebugLog(
  prefix: string,
  debug: boolean | undefined,
): ((...args: unknown[]) => void) | undefined {
  return (debug ?? isDebugEnabled()) ? console.debug.bind(console, prefix) : undefined;
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
