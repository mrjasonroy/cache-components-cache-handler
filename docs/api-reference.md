# API Reference

Everything the package exports. Start with [`withCache`](#withcachenextconfig-options); the rest is
for custom handler files, operations and the legacy data cache API. Behaviour (outages, tag
coordination) is described in [How it works](./how-it-works.md), and the key layout in
[Redis Configuration](./redis.md#whats-in-redis).

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `withCache(nextConfig, options?)` | function | Configures the whole cache. [Below](#withcachenextconfig-options). |
| `createRedisCacheHandler(options?)` | function → class | The page handler with code-level options, for a custom `cacheHandler` file. |
| `RedisCacheHandler` | class | The page handler. Same constructor as 16.4.2, so subclasses still work. |
| `createRemoteCacheHandler(options?)` | function → `DataCacheHandler` | Redis data handler plus memory fallback, for `"use cache: remote"`. |
| `createLocalCacheHandler(options?)` | function → `DataCacheHandler` | Memory data handler with shared tag invalidation, for `"use cache"`. |
| `flushCache(options?)` | async function | Deletes this app's keys. [Flushing](./operations.md#flushing-the-cache). |
| `closeCache()` | async function | Closes the package's Redis connections so a test run or script can exit. [Closing](./operations.md#closing-the-cache). |
| `setCacheLogger(logger)` | function | Sends the package's log lines to your logger. [Logging](./operations.md#logging). |
| `MEMORY_ONLY_TAG` | `"cache:memory-only"` | `cacheTag(MEMORY_ONLY_TAG)` keeps an entry, and a page that carries the tag, out of Redis. Use it for per-instance data such as health or build info. |
| `createCacheHandler({ type })` | function → `DataCacheHandler` | Deprecated: the original data handler factory ([legacy data cache API](#legacy-data-cache-api)). |
| `createRedisDataCacheHandler`, `createMemoryDataCacheHandler`, `createIoredisAdapter` | functions | Deprecated: the original building blocks behind `createCacheHandler`. |
| `CacheOptions`, `CacheLogger`, `WithCacheOptions`, `FlushCacheOptions`, `FlushCacheResult`, `RedisCacheHandlerOptions`, `RemoteCacheHandlerOptions`, `LocalCacheHandlerOptions`, `DataCacheHandler`, `DataCacheEntry`, `PageCache*` | types | |

The [deprecated exports](#deprecated) are still exported.

## `withCache(nextConfig, options?)`

```ts
function withCache<T extends object>(
  nextConfig: T,
  options?: WithCacheOptions,
): T & WithCacheConfig;
function withCache<T extends object>(
  nextConfig: (phase: string, context: { defaultConfig: object }) => T | Promise<T>,
  options?: WithCacheOptions,
): (phase: string, context: { defaultConfig: object }) => Promise<T & WithCacheConfig>;

interface WithCacheOptions {
  /** Where plain "use cache" stores entries. @default "memory" */
  useCache?: "memory" | "redis";
  /** Set cacheHandler and cacheMaxMemorySize: 0. @default true */
  pages?: boolean;
  /** Your own handler files. Relative paths resolve against process.cwd(). */
  handlers?: { page?: string; default?: string; remote?: string };
}
```

Returns `nextConfig` plus:

| Key | Value |
|---|---|
| `cacheHandler` | `handlers.page`, or the built-in page handler. Omitted with `pages: false`. |
| `cacheHandlers.remote` | `handlers.remote`, or the built-in remote handler. |
| `cacheHandlers.default` | `handlers.default`; else the remote handler with `useCache: "redis"`; else the built-in local handler. |
| `cacheMaxMemorySize` | `0`, unless `nextConfig` sets it: then that value is kept, with a warning if it is not `0` (it has no effect once `withCache` sets the handlers). Omitted with `pages: false`. |

Throws if `nextConfig` already sets `cacheHandlers`, or `cacheHandler` unless `pages: false`
(then yours is kept). A config function is wrapped
in an async one that applies the same settings to its result.

The built-in handlers read the [environment](./installation.md#environment-variables) at runtime.

## `CacheOptions`

Shared by every factory below and by `flushCache`. Each defaults to the environment, so a factory
called with no options behaves like the built-in handler.

```ts
interface CacheOptions {
  /** @default REDIS_URL ?? VALKEY_URL ?? the ELASTICACHE_* env; unset → memory only */
  url?: string;
  /** Your own ioredis Redis or Cluster. Overrides url. Never closed or reconfigured. */
  client?: Redis | Cluster;
  /** @default CACHE_KEY_PREFIX ?? "nextjs:" */
  keyPrefix?: string;
  /** Serve from memory (each entry at most 60 s) while Redis is down. @default true */
  memoryFallback?: boolean;
  /**
   * Per-command timeout in ms. On a client you pass in, it bounds the package's own commands
   * through a proxy; 3 timeouts in a row → memory for 2 s. @default 1000
   */
  commandTimeout?: number;
  /**
   * Ms to wait for a connection the package opens. Not used with client.
   * @default 2000 (10000 with the ELASTICACHE_* host form)
   */
  connectTimeout?: number;
  /** Ms a pending command may wait for a reply before an owned connection is reopened. @default 2000 */
  socketTimeout?: number;
  /** Timeouts in a row that reopen an owned connection, or send a passed client to memory for 2 s. @default 3 */
  maxConsecutiveTimeouts?: number;
  /** @default CACHE_DEBUG is `1` or `true` */
  debug?: boolean;
  /** Where this handler's warnings, errors and debug lines go. @default setCacheLogger's, else the console */
  logger?: CacheLogger;
}
```

Handlers in one process with the same connection and `keyPrefix` share one connection, one tag
store and one set of memory stores. `CACHE_REDIS=off` and `next build` force memory regardless of
these options. Different timeouts for the same server open a second connection, and the package
logs a warning when that happens, so give every handler the same settings.

## Page handler

### `createRedisCacheHandler(options?)`

```ts
function createRedisCacheHandler(options?: RedisCacheHandlerOptions): typeof RedisCacheHandler;
```

Returns a `RedisCacheHandler` subclass with `options` applied. Export it as the default of a
custom `cacheHandler` file:

```js
// cache/page.mjs
import { createRedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createRedisCacheHandler({ client });
```

### `RedisCacheHandler`

The class Next constructs for the singular `cacheHandler`. It implements `get`, `set`,
`revalidateTag`, `resetRequestCache`, `delete` and `close`. `get` reads the entry and the tag
records that apply to it in one round trip (1 `GET` + 1 `HMGET` of the `<prefix>tags` hash), so a
revalidation on any instance is seen by the next read. The first read of an entry by a process
that did not write it takes one more `HMGET`, for the tags it learns from the entry. See
[Sizing](./redis.md#sizing).

`RedisCacheHandlerOptions` is Next's constructor context plus `CacheOptions` and:

| Option | Default | Meaning |
|---|---|---|
| `buildId` | the app's `BUILD_ID` | The build that scopes entry keys. |
| `defaultTTL` | `31536000` (365 days) | Lifetime in seconds of an entry with neither `revalidate` nor `expire`, at most 365 days. |
| `redis` | — | The 16.4.2 form: an ioredis client, a URL or an ioredis options object. Prefer `client` / `url`. |
| `tagPrefix` | — | Deprecated and ignored. Tag records live in the `<keyPrefix>tags` hash. |

The constructor has the same shape as in 16.4.2, so subclasses keep working. `close()` is deprecated:
it is the same as [`closeCache()`](#closecache).

## Data handlers

Both return a Next `DataCacheHandler` (`get`, `set`, `refreshTags`, `getExpiration`,
`updateTags`). Export the result as the default of a `cacheHandlers` file.

### `createRemoteCacheHandler(options?)`

For `"use cache: remote"`, and for `"use cache"` with `useCache: "redis"`. Entries are stored in
Redis under `<prefix><buildId>:data:<key>` until their `expire`, with the memory fallback during
an outage. Takes `CacheOptions` plus `buildId` and `defaultTTL`: the seconds to keep an entry whose
`expire` is infinite (default `86400`, 24 hours; anything but a finite number greater than 0 throws when the
handler is created). Every entry is kept at most 365 days.

### `createLocalCacheHandler(options?)`

For `"use cache"`. Values live in this process's memory (up to 10,000 entries and 32 MiB; a
larger value is not kept) until their `revalidate` period. When Redis is configured, tag invalidations are shared across instances.
Takes `CacheOptions`; only the connection, `keyPrefix` and `debug` matter.

```js
// cache/default.mjs
import { createLocalCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createLocalCacheHandler({ client });
```

## `flushCache(options?)`

```ts
function flushCache(options?: FlushCacheOptions): Promise<FlushCacheResult>;

interface FlushCacheOptions extends CacheOptions {
  /** "build": <prefix><buildId>:*. "all": every key under the prefix. @default "build" */
  scope?: "build" | "all";
  /** @default the app's BUILD_ID */
  buildId?: string;
}

interface FlushCacheResult {
  /** Redis keys deleted; without Redis, in-process entries dropped. */
  deleted: number;
  /** Set when some matching keys could not be deleted (a Cluster slot migration). Run it again. */
  partial?: true;
  /** How many matching keys could not be deleted; set with partial. */
  failed?: number;
}
```

Deletes with SCAN + UNLINK on every master of a Cluster, and empties this process's memory stores.
`deleted` is the number of Redis keys deleted, or, without Redis, the number of memory entries
dropped. It throws, deleting nothing, if Redis is configured but unavailable, or for
`scope: "all"` with an empty `keyPrefix`. It also throws if a Redis node stops answering
(`commandTimeout`, also on each Cluster master) or refuses part-way: some keys may already be
deleted, so run it again. After the delete it writes a tag record for the flush
(`__cch_flush__`, or `__cch_flush__:<buildId>` for `scope: "build"`) that prerendered build output
is checked against, so build output older than the flush is not served again. See
[Flushing the cache](./operations.md#flushing-the-cache).

## `closeCache()`

```ts
function closeCache(): Promise<void>;
```

For test runs, scripts and CLIs, so Node can exit; a Next server never needs it. Closes every
Redis connection the package opened in this process and empties its memory stores. It first
waits for tag writes in flight and sends any Redis has not acknowledged once more; one still
refused is kept, applied by this process and sent by the handlers once Redis takes it, if they
are used again. It never rejects because Redis is down. Safe to call more than once, and
concurrently: a call made while a close runs closes, after it, any connection opened meanwhile. A `client` you passed in is never closed.
Handlers created before it reconnect on their next call, onto one new connection; the deprecated
`createCacheHandler` does not, and serves from memory until it is created again.

```ts
import { afterAll } from "vitest";
import { closeCache } from "@mrjasonroy/cache-components-cache-handler";

afterAll(() => closeCache());
```

## `setCacheLogger(logger)`

```ts
interface CacheLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  debug?(message: string, meta?: Record<string, unknown>): void;
}
function setCacheLogger(logger: CacheLogger | undefined): void;
```

Sends the package's warnings, errors and `CACHE_DEBUG` lines to `logger` for the whole process
(every module graph), or back to the console with `undefined`. Call it in `instrumentation.ts`'s
`register()` or a custom handler file. The `logger` option of `createRemoteCacheHandler`,
`createLocalCacheHandler` and `createRedisCacheHandler` wins over it for that handler; the shared
connection and tag state use the logger of the handler that opened them. `message` is what the
console would print; `meta` holds the details (`error`, `operation`). Without `info` or `debug`
those lines are dropped. Errors stay rate-limited. No line carries a Redis URL or connection
options; errors, their causes, objects and URLs are scrubbed of credentials, but other free text in
a message is not. A logger that throws never fails a cache call: the line goes to the console.

## `MEMORY_ONLY_TAG`

`"cache:memory-only"`. An entry tagged with it (`cacheTag(MEMORY_ONLY_TAG)`), and a page that
carries it, is kept in process memory and never written to Redis.

## Legacy data cache API

The data cache API of 16.4.2 and earlier. Deprecated in 16.4.3: it keeps working in 16.x and is removed, or becomes a shim, on the Next 17
line. Use `withCache`, or `createRemoteCacheHandler` / `createLocalCacheHandler`. `createCacheHandler` keeps its own key layout (`nextjs:data-cache:`,
`nextjs:tags:`) and covers `"use cache"` only, not pages.

### `createCacheHandler(options)`

```js
// data-cache-handler.mjs
import { createCacheHandler } from "@mrjasonroy/cache-components-cache-handler";

export default createCacheHandler({ type: process.env.REDIS_URL ? "redis" : "memory" });
```

`type` is `"memory"`, `"redis"`, `"valkey"` or `"elasticache"`. The Redis types share the process's
connection, fall back to memory during an outage, and use memory during `next build` and with
`CACHE_REDIS=off`.

The 16.4.2 wiring still works: a handler file that exports `createCacheHandler({ type })`, wired
with `createCacheConfig` or by hand into `cacheHandlers`. It covers `"use cache"` only, not
pages. In production it logs a one-time reminder to use `withCache`; pass
`suppressIsrWarning: true` to silence it.

`createCacheHandler` reads `REDIS_URL` / `VALKEY_URL`, `REDIS_PASSWORD` and the `ELASTICACHE_*`
variables, and honours `CACHE_REDIS=off` and the build phase. It does not read `CACHE_KEY_PREFIX`
or `CACHE_DEBUG`. Its options:

| Option | Default | What it does |
|---|---|---|
| `url` | `REDIS_URL` / `VALKEY_URL`, else `redis://localhost:6379` | Connection URL (redis, valkey) |
| `endpoint` / `port` | `ELASTICACHE_ENDPOINT` / `ELASTICACHE_PORT`, `6379` | Host and port (elasticache) |
| `tls` | `true` for elasticache, else `false` | Use TLS |
| `password` | `ELASTICACHE_AUTH_TOKEN` / `REDIS_PASSWORD` | Auth token or password |
| `client` | — | Your own ioredis `Redis` or `Cluster`; you own its lifecycle |
| `keyPrefix` / `tagPrefix` | `"nextjs:data-cache:"` / `"nextjs:tags:"` | Key prefixes |
| `commandTimeout` | `1000` (ms) | Per-command timeout |
| `connectTimeout` | `2000` (ms; `10000` for elasticache) | Connect timeout |
| `socketTimeout` | `2000` (ms) | Drop the connection when a pending command gets no reply for this long |
| `maxConsecutiveTimeouts` | `3` | Timeouts in a row before the connection is dropped and redialled (with `client`: before it is marked not ready for 2 s) |
| `memoryFallback` / `fallbackTTL` | `true` / `60` (s) | Serve from memory during an outage, each entry for at most `fallbackTTL` |
| `defaultTTL` | `86400` (s) | TTL for entries without a finite `expire` |
| `tagTTL` | `31622400` (s, 366 days) | TTL for tag records; entry TTLs are capped at it |
| `errorLogIntervalMs` | `60000` | Redis errors are logged at most once per operation per interval |
| `suppressIsrWarning` | `false` | Silence the one-time production reminder |
| `maxSize` | 100 MB | Memory budget (memory) |
| `debug` | `false` | Debug logging |

### `createMemoryDataCacheHandler(options?)`

A memory data handler. Options: `maxSize` in bytes (default 50 MB) and `debug`.

### `createRedisDataCacheHandler(options)`

The Redis data handler behind `createCacheHandler`, without the shared connection or the
fallback. Options: `redis` (a node-redis-style client, required), `keyPrefix`
(`"nextjs:data-cache:"`), `tagPrefix` (`"nextjs:tags:"`), `defaultTTL` (`86400`), `tagTTL`
(366 days), `errorLogIntervalMs` (`60000`) and `debug`.

### `createIoredisAdapter(client)`

Wraps an ioredis `Redis` or `Cluster` so `createRedisDataCacheHandler` can use it. It translates
node-redis `SET` options (`{ EX: seconds }`) to ioredis positional arguments. Without it, Redis
rejects writes with `ERR syntax error`. The new handlers take ioredis directly and don't need it.

```js
import Redis from "ioredis";
import {
  createIoredisAdapter,
  createRedisDataCacheHandler,
} from "@mrjasonroy/cache-components-cache-handler";

export default createRedisDataCacheHandler({
  redis: createIoredisAdapter(new Redis(process.env.REDIS_URL)),
});
```

## Deprecated

Kept until the Next 17 line, with JSDoc pointing at the replacement. They keep working in 16.x;
on the Next 17 line they are removed or become a thin shim over the replacement.

| Deprecated | Use instead | Why |
|---|---|---|
| `createCacheHandler` | `withCache`, or `createRemoteCacheHandler` / `createLocalCacheHandler` in a [custom handler](./custom-handlers.md) | The original data stack: `"use cache"` only, its own key layout, and no page handler. It does not reconnect after `closeCache()`: create it again. |
| `createRedisDataCacheHandler`, `createIoredisAdapter` | `createRemoteCacheHandler({ client })` | It takes an ioredis client directly; no adapter. |
| `createMemoryDataCacheHandler` | `createLocalCacheHandler` | Memory with tag invalidation shared across instances. |
| `RedisCacheHandler#close()` | `closeCache()` | The same, without needing a handler. |
| `createCacheConfig`, `createCacheConfigWithProfiles` | `withCache` | Both make you write and wire handler files yourself. They keep working. |
| `CompositeHandler`, `createCompositeHandler` | built in | The memory fallback is now inside every handler. |
| `MemoryCacheHandler`, `createMemoryCacheHandler` | `withCache` without `REDIS_URL` | Memory only is the no-URL mode. |
| `bufferToString`, `stringToBuffer`, `jsonReplacer`, `jsonReviver`, `isImplicitTag`, `calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX`, and the Next 14 `CacheHandler*` / `CacheValue` / `LifespanParameters` types | none | Internals of the Next 14 handlers. They still work. |

`RedisCacheHandler` is **not** deprecated. It is the page handler `withCache` uses.

### `createCacheConfig(options)` / `createCacheConfigWithProfiles(options)`

Use `withCache`. They return `{ cacheHandlers, cacheMaxMemorySize }` for handler files you write
yourself:

- `createCacheConfig({ dataCacheHandlerPath, isrHandlerPath?, disableDefaultMemoryCache? })`
  points `default` and `remote` at one file.
- `createCacheConfigWithProfiles({ defaultDataCacheHandlerPath, remoteDataCacheHandlerPath, isrHandlerPath?, disableDefaultMemoryCache? })`
  takes one file per profile.

`isrHandlerPath` is passed through as `cacheHandler`. `disableDefaultMemoryCache` defaults to
`true` (`cacheMaxMemorySize: 0`).

### Next 14 handlers and helpers

`MemoryCacheHandler`, `createMemoryCacheHandler`, `CompositeHandler`, `createCompositeHandler`,
`bufferToString`, `stringToBuffer`, `jsonReplacer`, `jsonReviver`, `isImplicitTag`,
`calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX`, and the types `CacheHandler`,
`CacheHandlerContext`, `CacheHandlerGetMeta`, `CacheHandlerOptions`, `CacheHandlerValue`,
`CacheValue` and `LifespanParameters`. See the [Deprecated](#deprecated) table above for
replacements.

## Types

`WithCacheOptions`, `WithCacheConfig`, `CacheOptions`, `RedisCacheHandlerOptions`,
`RemoteCacheHandlerOptions`, `LocalCacheHandlerOptions`, `FlushCacheOptions`, `FlushCacheResult`,
`PageCacheControl`, `PageCacheGetContext`, `PageCacheHandlerContext`, `PageCacheHandlerValue`,
`PageCacheSetContext`, `PageCacheValue`, `DataCacheHandler`, `DataCacheEntry`, `Timestamp`,
`DataCacheHandlerOptions`, `CacheHandlerType`, `MemoryDataCacheHandlerOptions`,
`RedisDataCacheHandlerOptions`, `RedisClient`, `IoredisLike`, `CacheHandlerConfig`.

## Next.js APIs

The package sits behind Next's own caching APIs: `"use cache"`, `"use cache: remote"`,
`cacheLife`, `cacheTag`, `revalidateTag`, `updateTag` and `revalidatePath`. See
[Usage Examples](./usage.md) and Next's
[Caching and Revalidating](https://nextjs.org/docs/app/getting-started/caching-and-revalidating).
