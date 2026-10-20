# @mrjasonroy/cache-components-cache-handler

One Redis-backed cache for a Next.js 16+ app: pages, route handlers, `"use cache"` and
`"use cache: remote"`, shared across every instance and safe through a Redis outage.

[![npm version](https://badge.fury.io/js/@mrjasonroy%2Fcache-components-cache-handler.svg)](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![Next.js 16+](https://img.shields.io/badge/Next.js-16%2B-black)](https://nextjs.org/)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen)](https://github.com/mrjasonroy/cache-components-cache-handler/tree/main/apps/e2e-test-app)

**📦 [View on npm](https://www.npmjs.com/package/@mrjasonroy/cache-components-cache-handler) | 🚀 [Releases](https://github.com/mrjasonroy/cache-components-cache-handler/releases)**

## Quick start

```bash
npm install @mrjasonroy/cache-components-cache-handler ioredis
```

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache({ cacheComponents: true });
```

```bash
REDIS_URL=redis://cache:6379   # unset → everything stays in memory (dev, CI, previews)
```

That's it. Pages, route handlers, `"use cache"` and `"use cache: remote"` are all cached.
`revalidateTag`, `updateTag` and `revalidatePath` work across every instance. A Redis outage
degrades to memory instead of taking the site down. `ioredis` is only needed when you use Redis.

## What goes where

`withCache` merges these settings into the config you pass:

| Next.js setting | Points at | What it does |
|---|---|---|
| `cacheHandler` (singular) | the page handler (`RedisCacheHandler`) | Page shells (`APP_PAGE`), route handler responses (`APP_ROUTE`) and cached `fetch` (`FETCH`) are stored in Redis. It honours `x-next-cache-tags`, soft tags, `cacheControl` and `revalidateTag(tag, { expire })`. |
| `cacheHandlers.remote` | the remote handler (`createRemoteCacheHandler`) | `"use cache: remote"` entries are stored in Redis, shared by every instance. |
| `cacheHandlers.default` | the local handler (`createLocalCacheHandler`) | `"use cache"` values are kept in each instance's memory. Tag invalidation still reaches every instance ([how](#distributed-tag-coordination-for-use-cache)). |
| `cacheMaxMemorySize: 0` | — | Turns off Next's built-in page LRU, so every page goes through the handler. |

What you get without configuring anything:

- **One Redis connection per process**, shared by every handler. It is registered on
  `globalThis`, so Next loading the handler modules more than once never opens a second one.
- **Entries scoped by build.** Entries live under the build ID that wrote them, so a deploy never
  serves the previous build's pages or RSC payloads. Tag records sit above the build ID, so a
  `revalidateTag` during a rolling deploy reaches the old build and the new one.
- **No Redis during `next build`.** The build uses memory and never connects to or waits on Redis.
- **Outages absorbed.** The app keeps serving from per-instance memory, each entry kept there for
  at most 60 s. Errors are logged at most once a minute, not once per request. When Redis comes
  back, that memory is dropped and Redis is authoritative again ([table](#when-redis-goes-down)).
- **Fast failure.** A command times out after 1 s. A connection that times out 3 times in a row
  is dropped and redialled. At startup a handler waits at most 500 ms for the first connection.
- **A compact binary format.** Entries are stored as raw bytes rather than base64 JSON: about 25%
  less Redis memory and network, and a page shell `get` about 40% faster. Entries of 16 KB and
  more are also Brotli-compressed, usually 5 to 15 times smaller (`CACHE_COMPRESSION`).
- **Prerendered pages survive a restart.** On a miss, prerendered pages and route handlers are
  served from the build output in `.next` until their revalidate window runs out
  ([details](#pages-and-route-handlers)).

## Configuration

### `withCache(nextConfig, options?)`

These options are read when `next.config` loads. They decide which handler files Next is pointed
at. Runtime settings come from the [environment](#environment-variables).

| Option | Default | What it does |
|---|---|---|
| `useCache` | `"memory"` | Where plain `"use cache"` stores entries. `"memory"` keeps values per instance with shared tag invalidation. `"redis"` uses the same Redis handler as `"use cache: remote"`. |
| `pages` | `true` | Set `cacheHandler` (pages, route handlers, cached `fetch`) and `cacheMaxMemorySize: 0`. A `cacheMaxMemorySize` you set yourself is kept, with a warning if it is not `0`. `false` leaves `cacheHandler` and `cacheMaxMemorySize` as your config has them. |
| `handlers` | built-in files | `{ page?, default?, remote? }`: paths to [your own handler files](#custom-handlers). Relative paths resolve against the working directory (`process.cwd()`, where `next` runs), not against `next.config`; when the two can differ, pass an absolute path (`fileURLToPath(new URL("./cache/page.mjs", import.meta.url))`). |

`withCache` throws if the config already sets `cacheHandlers`, or `cacheHandler` unless
`pages: false`, because two configs fighting over the cache is always a bug. Use `handlers`
instead.

`nextConfig` can also be a config function, `(phase, { defaultConfig }) => config`, sync or
async. `withCache` then returns an async function that applies the same settings to its result.

```js
// Keep plain "use cache" in Redis too (every entry is visible with redis-cli)
export default withCache({ cacheComponents: true }, { useCache: "redis" });

// "use cache" only; leave pages to Next's default cache
export default withCache({ cacheComponents: true }, { pages: false });
```

### Environment variables

Next loads handler files by path. It cannot pass them objects from `next.config`, and a standalone
`server.js` never runs `next.config` at all. So the built-in handlers read their runtime settings
from the environment, the same under `next start`, standalone and Docker.

| Variable | Default | Meaning |
|---|---|---|
| `REDIS_URL` (or `VALKEY_URL`) | unset → memory only | `redis://` or `rediss://` URL, password included. |
| `REDIS_PASSWORD` | — | Password when the URL has none. |
| `ELASTICACHE_ENDPOINT`, `ELASTICACHE_PORT`, `ELASTICACHE_AUTH_TOKEN` | port `6379` | Host form, used when no URL is set. TLS is on. |
| `ELASTICACHE_TLS` | `true` | `false` turns TLS off for the host form. |
| `CACHE_KEY_PREFIX` | `nextjs:` | Prefix for every key. Use it to share one Redis between apps. |
| `CACHE_REDIS` | `on` | `off` (or `0`, `false`, `no`) forces memory everywhere, even with a URL set. A kill switch for every backend: it turns off Valkey and ElastiCache too, whatever variable set the URL. |
| `CACHE_DEBUG` | unset | `1` (or `true`) logs hits, misses, writes (with each value's size in bytes) and state changes. It never logs the URL. |
| `CACHE_COMPRESSION` | `on` | Entries of 16 KB and more are stored Brotli-compressed (usually 5 to 15 times smaller). `off` (or `0`, `false`, `no`) stores them uncompressed. Either way, both forms are read. Entries over 64 MB are always stored uncompressed. |

There are no tuning variables for timeouts or TTLs: the defaults above are the product. If you
need different ones, write a [custom handler file](#custom-handlers).

Redis is used whenever a URL or endpoint is set, except during `next build`, on the edge runtime
and with `CACHE_REDIS=off`. If a dev `.env` file carries `REDIS_URL`, either remove it there or set
`CACHE_REDIS=off`.

## Distributed tag coordination for `"use cache"`

Plain `"use cache"` keeps its values in each instance's memory, which is what Next intends for
it. Invalidation is still shared, following Next's
[Distributed Tag Coordination](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination)
pattern:

- **Values live in per-instance memory**: an LRU of up to 10,000 entries. Like Next's built-in
  handler, a value is dropped once its `revalidate` period has passed, and the next request
  renders it again.
- **`updateTags` writes the invalidation to Redis**: one script call (`EVALSHA`) that merges it
  into the tag hash (a `stale,expired` timestamp record per tag) and one `ZADD GT` into the tag
  index, however many tags it carries. Both only move a record forward, so a write delayed in
  transit never undoes a newer revalidation from another instance.
- **`refreshTags` syncs once per request**, at most every 100 ms. Next calls it before the first
  `"use cache"` read. It reads the index for tags updated since the last sync (minus 5 s for clock
  skew), then fetches only those records with one `HMGET` and copies them into local state. While
  nothing changes, that is a single `ZRANGEBYSCORE`. Concurrent requests share one sync.
- **`getExpiration` reads only local state**, so there is no Redis call per cache lookup. It
  returns the most recent time any of the tags was invalidated.

So `revalidateTag` on instance A also invalidates B's memory copy.

The page handler and the remote handler use the same per-process tag store. Both are stricter
than `"use cache"`: Next reads the page handler before it calls any `refreshTags`, so the page
and remote handlers check the tag records in Redis on every read, and a failed tag read is a miss
([Pages and route handlers](#pages-and-route-handlers)). Next calls `updateTags` on every handler and then the page handler's
`revalidateTag` for one `revalidateTag()` call. Identical updates in the same synchronous run are
written to Redis once; a later identical update is written again.

Limits worth knowing:

- During a Redis outage only local tags apply. An invalidation made then reaches its own instance
  first, and a warning is logged; it is sent to Redis when the connection is back, as a fresh
  revalidation. Until a `"use cache"` instance has synced since it (re)connected, its memory
  values are misses rather than possibly stale hits.
- A process's first sync reads every tag in the index, 1,000 per round trip, paging by score so
  a tag revalidated mid-sync can never push another out of reach. After that it reads only what
  changed. The index is never trimmed, so a sync never misses an update.
- Tag records are never deleted, except by `flushCache({ scope: "all" })`: a deleted record would
  read as never-invalidated and bring stale entries back. Only tags that were revalidated get a
  record, about 230 B each, so the hash grows with the distinct tags ever revalidated (100,000
  tags take about 23 MB). No entry is kept or served past 365 days.
- Instances' clocks may differ by up to 5 s. A larger skew can delay an invalidation on other
  instances until the tag is invalidated again.
- Times are wall time, read without touching `Date` inside a prerender. If another library has
  replaced `Date` (fake timers, `timekeeper`, some APM agents) and Next's prerender state cannot
  be seen, the package does not read `Date` at all and keeps the process's performance clock, as
  Next's own handlers do. That is safe, but that instance's times can drift from the others'
  over a long uptime.

## Pages and route handlers

The page handler implements Next 16's singular `cacheHandler` contract:

- **Lifetime.** An entry is kept for `1.5 × revalidate`, capped at the profile's `expire`. That
  keeps a stale-while-revalidate window without keeping dead pages forever. An entry with `expire`
  but no `revalidate` is kept for `expire`. With neither, it is kept for `defaultTTL` (365 days).
  Nothing is kept or served longer than 365 days.
- **Tags, checked in Redis on every read.** A `get` sends the entry `GET` together with one
  `HMGET` of every tag record that applies: the soft tags (`revalidatePath`'s implicit path tags),
  the `fetch` tags, and the entry's own tags (the `x-next-cache-tags` header) as this process last
  saw them. They go out in one round trip, so a revalidation on any instance is seen by the very
  next read at no extra latency. The first time a process reads an entry it did not write, it
  learns the entry's tags from the entry itself, so that read takes a second round trip (one more
  `HMGET`). While Redis is down, pages are checked against local tag state: every record a `get`
  has read, kept current by the `"use cache"` handlers' `refreshTags` sync.
- **`revalidateTag(tag, "max")`** (or any `{ expire }`) leaves the page servable until `expire`:
  it is served once more and regenerated in the background. `revalidateTag(tag)`, `updateTag` and
  `revalidatePath` make it a miss. A page without a `revalidate` period cannot be served stale, so
  it is a miss either way.
- **Schedule.** A page's `cacheControl` is stored with it, so an instance that did not render the
  page revalidates it on the page's own schedule.
- **Prerendered routes are served from the build output.** `next build` writes prerendered pages
  and route handlers (sitemaps, robots, manifests) to disk only. On a miss the handler reads them
  through Next's own `FileSystemCache`, checks their tags with `lastModified` = the build time (a
  tag or path revalidated since the build wins, and so does a `flushCache`), then writes them to
  Redis unless an entry is already there. A route with a revalidate period is served from the
  build output only within `1.5 × revalidate` (capped at `expire`) of the build, as long as a
  render of it would be kept; after that a miss renders it. A dynamic route's prerendered fallback
  shell (partial prerendering) is served the same way, with the route's `fallbackRevalidate` and
  `fallbackExpire`. The build output is read from disk, so this holds after a restart or on a
  fresh instance too. While Redis is down it is not served, because its tags cannot be checked.
  The build time is not the files' mtime: the page handler writes `cache-handler-build.json` into
  `.next/server` when static generation starts, so ship that file with the build. Without it the
  build output is served only for `revalidate: false` routes none of whose tags was ever
  revalidated.
- **Edge middleware.** Next bundles this handler into the middleware too. On the edge runtime it
  imports without touching Node built-ins and does nothing: every read is a miss.
- Cached `fetch` entries share the `page:` key namespace.

## When Redis goes down

| Situation | Reads | Writes | `revalidateTag` |
|---|---|---|---|
| `next build` | memory | memory | memory |
| Redis down at boot | memory (each entry at most 60 s) | memory | applied locally, with a warning: other instances keep their copy until it ages out |
| Redis lost mid-run | the same; switches within one command timeout | the same | the same |
| Redis stalled (accepts, never answers) | 1 s timeout per command → miss; after 3 timeouts in a row, drop and redial → memory (a [client you pass in](#custom-handlers) is never dropped: memory for 2 s at a time instead) | the same | the same |
| Redis back | Redis; the outage memory is dropped | Redis | Redis and local |

A request never fails because of the cache. A cache error is always a miss plus a rate-limited log
line. With `memoryFallback: false` in a [custom handler](#custom-handlers), reads and writes made
during an outage are misses instead.

## Flushing the cache

```ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

await flushCache();                  // this build's entries
await flushCache({ scope: "all" });  // every key under CACHE_KEY_PREFIX, tag records included
```

`flushCache` uses SCAN + UNLINK and scans every master of a Cluster. It returns `{ deleted }`, the
number of Redis keys deleted. It also empties **this process's** in-memory stores. Other
instances keep their in-memory `"use cache"` values until those reach `revalidate`, or until a
tag invalidation reaches them. Without Redis it only empties the memory stores and returns how
many entries they held. Either way it then records the flush like a tag revalidation (a field in
`<prefix>tags`), so prerendered build output older than the flush is not served again, even
after the tag records were deleted. If Redis is configured but unavailable, it throws and deletes nothing. It
also refuses `scope: "all"` when the key prefix is empty, which would delete the whole database.

| Option | Default | Meaning |
|---|---|---|
| `scope` | `"build"` | `"build"` deletes `<prefix><buildId>:*`. `"all"` deletes every key under the prefix. |
| `buildId` | the app's `BUILD_ID` | The build that `scope: "build"` deletes. |
| `url`, `client`, `keyPrefix` | the environment | Which Redis and prefix, as in [`CacheOptions`](#custom-handlers). |

The package ships no HTTP endpoint. The route is yours to write and to authenticate:

```ts
// app/api/admin/cache/flush/route.ts
import { flushCache } from "@mrjasonroy/cache-components-cache-handler";

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CACHE_FLUSH_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json(await flushCache());
}
```

`scope: "all"` matches by prefix, so it also deletes keys written under the same prefix by
`createCacheHandler` and by 16.5.x's `RedisCacheHandler`. With the default `nextjs:` prefix that
means everything under it, 16.5's `nextjs:cache:*`, `nextjs:tags:*` and `nextjs:data-cache:*`
included, and any other app's keys that share the `nextjs:` prefix. On a Cluster, a key caught
in a slot migration is retried through the Cluster client; if any still fail, `flushCache` logs a
warning and returns `{ deleted, partial: true, failed }` instead of throwing, so run it again.
A Redis node that stops answering (each Cluster master is bounded by `commandTimeout` too) or
refuses part-way makes `flushCache` throw; some keys may already be deleted, so run it again.

## Closing the cache

A Next server never needs this. A test run, script or CLI that used the handlers or `flushCache`
calls `closeCache()` at the end, so Node can exit instead of waiting on an open Redis connection:

```ts
// a Vitest `setupFiles` file or a Jest `setupFilesAfterEnv` file
import { afterAll } from "vitest"; // Jest: the global afterAll
import { closeCache } from "@mrjasonroy/cache-components-cache-handler";

afterAll(() => closeCache());
```

`closeCache()` closes every Redis connection the package opened in this process (one per
connection settings, shared by all handlers) and empties its in-memory stores. It first waits
for revalidations in flight and sends any Redis has not acknowledged one last time. A
revalidation Redis still refuses (it is down, or read-only during a failover) is not lost: this
process keeps applying it, and the handlers send it once Redis takes writes again, if you use
them after the close. `closeCache()` does not fail because Redis is down. It is safe to call more than once,
and concurrently: a call made while a close runs closes, after it, any connection a cache call
opened meanwhile. A `client` you passed in is never
closed; close it yourself. Handlers created before it keep working: on their next call they
reconnect, all onto one new connection. The deprecated `createCacheHandler` is the exception: it
keeps its closed connection and serves from memory, so create it again after `closeCache()`.

## Logging

Warnings, errors and `CACHE_DEBUG` lines go to the console by default. To send them to your own
logger (anything with `error` and `warn` methods), set it once per process in `instrumentation.ts`:

```ts
// instrumentation.ts
import { setCacheLogger } from "@mrjasonroy/cache-components-cache-handler";
import { logger } from "./lib/logger";

export function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") setCacheLogger(logger);
}
```

Each line is `logger.error(message, meta)`, `logger.warn(...)`, `logger.info?.(...)` or
`logger.debug?.(...)`. `message` is the line the console would have printed, and `meta` carries
its details (an `error`, the `operation`). A logger without `info` or `debug` drops those lines. Errors stay rate-limited, as on the console. Lines written before `register()`
runs (a `withCache` warning while `next.config` loads) still go to the console.

winston and `console` take `(message, meta)` as they are. pino and bunyan take the fields first,
so pass an adapter, or `meta` is lost:

```ts
const log = (level: "error" | "warn" | "info" | "debug") =>
  (message: string, meta?: Record<string, unknown>) => logger[level](meta ?? {}, message);
setCacheLogger({ error: log("error"), warn: log("warn"), info: log("info"), debug: log("debug") });
```

In a custom handler file, `createRemoteCacheHandler`, `createLocalCacheHandler` and
`createRedisCacheHandler` also take `logger`, which wins over `setCacheLogger` for that handler.
The Redis connection and tag state that handlers share log through the logger of the handler
that opened them, so give every handler the same one, or use `setCacheLogger`.

The package never logs a Redis URL or the connection options, which can hold a password. What it
logs is scrubbed on the way out: an error (and each error in its `cause` chain) keeps only its
name, message, stack, `code`, `errno`, `syscall`, `address` and `port`, so the failed command
ioredis attaches to an error (a rejected `AUTH` carries the password it tried) is dropped; objects
lose `command`, `password` and similar keys; other values (a `Buffer`, a class instance) are logged
as a placeholder such as `[Buffer 12 bytes]`; and URLs in any text lose their user information.
Other free text in a message is not scrubbed: a credential an error message spells out some other
way reaches the log. A logger that throws never fails a cache call: the line goes to the console
instead, with one note that the logger threw.

## Custom handlers

Use your own handler files when you need a client you built yourself (Sentinel, a custom Cluster,
IAM auth) or different timeouts. Write one file per handler and give the paths to `withCache`:

```js
// cache/redis.mjs: one client for both files, parked on globalThis because Next can load the
// two handler modules separately
import Redis from "ioredis";

const key = Symbol.for("my-app.redis");
globalThis[key] ??= new Redis(process.env.REDIS_URL, { commandTimeout: 1000 });
export const client = globalThis[key];
```

```js
// cache/page.mjs
import { createRedisCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createRedisCacheHandler({ client });
```

```js
// cache/remote.mjs
import { createRemoteCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createRemoteCacheHandler({ client });
```

```js
// cache/default.mjs
import { createLocalCacheHandler } from "@mrjasonroy/cache-components-cache-handler";
import { client } from "./redis.mjs";

export default createLocalCacheHandler({ client });
```

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";

export default withCache(
  { cacheComponents: true },
  {
    handlers: {
      page: "./cache/page.mjs",
      remote: "./cache/remote.mjs",
      default: "./cache/default.mjs",
    },
  },
);
```

Handlers that share a client and key prefix share one connection and one tag store. A handler
you don't replace keeps reading the environment. So if you pass a `client` and leave `REDIS_URL`
unset, also provide `default`; otherwise `"use cache"` tag invalidation stays local to each
instance.

A client you pass in is yours: the package never closes, disconnects or reconfigures it. The
package's own commands reach it through a proxy that bounds them by `commandTimeout`. After 3
timeouts in a row the handlers serve from memory for 2 s at a time, until a command succeeds
again. Your other uses of the client are unaffected, so set its own `commandTimeout` (and a
`retryStrategy`) for those.

All commands share one connection, so a large value on a slow link delays the commands queued
behind it. At 1000 ms, a 5 MB entry needs about 40 Mbit/s (compression usually makes a page
entry much smaller than the page); on a slower link (cross-region, or an
ElastiCache node out of network burst credits) raise `commandTimeout`, or 3 timeouts in a row
send the handlers to memory.

All three factories take `CacheOptions`:

| Option | Default | Meaning |
|---|---|---|
| `url` | `REDIS_URL` / `VALKEY_URL` / the ElastiCache env; unset → memory only | Redis URL, password included. |
| `client` | — | Your own ioredis `Redis` or `Cluster`. Overrides `url`. |
| `keyPrefix` | `CACHE_KEY_PREFIX` / `nextjs:` | Prefix for every key. |
| `memoryFallback` | `true` | Serve from memory (each entry at most 60 s) while Redis is down. `false` → miss instead. |
| `commandTimeout` | `1000` | Per-command timeout in ms. Also bounds the package's commands on a `client` you pass in. |
| `connectTimeout` | `2000` (`10000` with the `ELASTICACHE_*` host form) | Ms to wait for a connection the package opens. Not used with `client`. |
| `socketTimeout` | `2000` | Ms a pending command may go without a reply before a connection the package opens is dropped and reopened. Not used with `client`. |
| `maxConsecutiveTimeouts` | `3` | Command timeouts in a row that drop a connection the package opens or, for a `client` you pass in, send the handlers to memory for 2 s at a time. |
| `debug` | `CACHE_DEBUG` | Log hits, misses and state changes. |
| `logger` | `setCacheLogger`'s, else the console | Where this handler's warnings, errors and debug lines go (see [Logging](#logging)). |

Handlers given the same connection settings share one connection and one tag state. Give every
handler file the same `url`, timeouts and `maxConsecutiveTimeouts`: different settings open a
second connection to the same server, and the package logs a warning when that happens.

`createRedisCacheHandler` and `createRemoteCacheHandler` also take `buildId` (default: the app's
`BUILD_ID`), the build that scopes entry keys. Both also take `defaultTTL`, in seconds:
`createRedisCacheHandler` keeps an entry with neither `revalidate` nor `expire` that long (default
and maximum 365 days), and `createRemoteCacheHandler` keeps an entry whose `expire` is infinite
that long (default 24 hours, maximum 365 days; anything but a number greater than 0 throws).

`CACHE_REDIS=off` and the build phase apply to custom handlers too: they never use Redis then.

## Exports

| Export | Kind | Purpose |
|---|---|---|
| `withCache(nextConfig, options?)` | function | Configures the whole cache. [Configuration](#configuration). |
| `createRedisCacheHandler(options?)` | function → class | The page handler with code-level options, for a custom `cacheHandler` file. |
| `RedisCacheHandler` | class | The page handler. Same constructor as 16.5.x, so subclasses still work. |
| `createRemoteCacheHandler(options?)` | function → `DataCacheHandler` | Redis data handler plus memory fallback, for `"use cache: remote"`. |
| `createLocalCacheHandler(options?)` | function → `DataCacheHandler` | Memory data handler with shared tag invalidation, for `"use cache"`. |
| `flushCache(options?)` | async function | Deletes this app's keys. [Flushing](#flushing-the-cache). |
| `closeCache()` | async function | Closes the package's Redis connections so a test run or script can exit. [Closing](#closing-the-cache). |
| `setCacheLogger(logger)` | function | Sends the package's log lines to your logger. [Logging](#logging). |
| `MEMORY_ONLY_TAG` | `"cache:memory-only"` | `cacheTag(MEMORY_ONLY_TAG)` keeps an entry, and a page that carries the tag, out of Redis. Use it for per-instance data such as health or build info. |
| `createCacheHandler({ type })` | function → `DataCacheHandler` | Deprecated: the 16.5 data handler factory ([legacy setup](#legacy-setup-deprecated)). |
| `createRedisDataCacheHandler`, `createMemoryDataCacheHandler`, `createIoredisAdapter` | functions | Deprecated: the 16.5 building blocks behind `createCacheHandler`. |
| `CacheOptions`, `CacheLogger`, `WithCacheOptions`, `FlushCacheOptions`, `FlushCacheResult`, `RedisCacheHandlerOptions`, `RemoteCacheHandlerOptions`, `LocalCacheHandlerOptions`, `DataCacheHandler`, `DataCacheEntry`, `PageCache*` | types | |

The [deprecated exports](#deprecated) are still exported.

## Key layout (for operators)

```
<prefix><buildId>:page:<key>   page, route handler or cached fetch entry
<prefix><buildId>:data:<key>   "use cache: remote" entry (and "use cache" with useCache: "redis")
<prefix>tags                   hash of every tag record: field = tag, value = "<stale>,<expired>" in ms
<prefix>tag-index              sorted set of the same tags, scored by last update (ms)
```

`<prefix>` is `CACHE_KEY_PREFIX` (`nextjs:` by default). `<buildId>` is the app's `BUILD_ID`. It
is read from the build output that `next start` and a standalone `server.js` use, and it is
`development` under `next dev`. Every entry key has a TTL. A remote entry is kept until its `expire`, or
for `defaultTTL` (24 hours) when `expire` is infinite, at most 365 days; page entries as described under [Pages and route handlers](#pages-and-route-handlers). The two tag keys
are shared by every build and have no TTL: they are kept until `flushCache({ scope: "all" })`.
Run Redis with `maxmemory-policy noeviction` or a `volatile-*` policy (`volatile-lru`), never
`allkeys-*`: an evicted tag hash brings every invalidated entry back.

`createCacheHandler` keeps its 16.5 layout: `nextjs:data-cache:<key>` and `nextjs:tags:<tag>`.

### Sizing

Redis command volume, not latency, is what grows with traffic:

| Operation | Redis commands |
|---|---|
| Page, route handler or cached `fetch` read | 1 `GET` + 1 `HMGET` of every tag that applies (soft tags, `fetch` tags, the entry's tags), in one round trip. The first read of an entry by a process that did not write it is 3 commands in 2 round trips. |
| `"use cache: remote"` read | 1 `GET` + 1 `HMGET` of the entry's tags and the soft tags, in one round trip (2 round trips the first time a process reads an entry it did not write). |
| `"use cache"` (memory) read | none. One tag sync per request, at most every 100 ms: 1 `ZRANGEBYSCORE` of the index since the last sync, plus 1 `HMGET` of the tags that changed, if any. |
| `revalidateTag`, `updateTag`, `revalidatePath` | 1 `EVALSHA` (one single-key script) + 1 `ZADD GT`, however many tags. The first one on a server that has not seen the script adds 1 `EVAL`. |

The tag read shares the entry's round trip, so page latency is unchanged; size Redis for the
command rate. Nothing runs `HGETALL`: an `HMGET` costs in proportion to the tags it reads, not to
the size of the hash. 100,000 tags take about 23 MB.

**Memory and network.** Entries of 16 KB and more are stored Brotli-compressed (quality 4, off the
event loop), usually 5 to 15 times smaller: a ~200 KB page entry takes about 14 KB in Redis. Size
Redis memory for the compressed entries; `CACHE_DEBUG` logs both sizes for page and remote entries
(`bytes`, `encodedBytes`).

**Hot key.** One shard serves the tag hash, on a Cluster too. At 2,000 page reads/s that is about
2% of one core; it starts to matter around 50,000 page reads/s, or with hundreds of tags per page.
Read replicas are the escape hatch if it ever does.

[DEC-3](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/implementation/DECISIONS.md) has the measurements.

## Migrating

### From 16.5.x (`createCacheConfig` and a handler file)

```diff
- import { createCacheConfig } from "@mrjasonroy/cache-components-cache-handler";
- import { resolve } from "node:path";
- const cacheConfig = createCacheConfig({
-   dataCacheHandlerPath: resolve(process.cwd(), "./data-cache-handler.mjs"),
- });
- export default { cacheComponents: true, ...cacheConfig };
+ import { withCache } from "@mrjasonroy/cache-components-cache-handler";
+ export default withCache({ cacheComponents: true });
```

Then delete `data-cache-handler.mjs`. Two things change:

- `"use cache"` now goes to memory and `"use cache: remote"` to Redis. Pass `{ useCache: "redis" }`
  to keep both in Redis.
- Pages and route handlers now go through Redis too. Pass `{ pages: false }` to opt out.

The cache starts cold, because the key layout is new. Every deploy starts cold anyway, because
entries are scoped by build ID, so there is no data to migrate.

#### Revalidations do not cross the upgrade

16.5 records a revalidation in `nextjs:tags:<tag>`
keys; 16.6 reads and writes only the `<prefix>tags` hash. While 16.5 and 16.6 instances serve side
by side, a `revalidateTag` or `revalidatePath` handled by a 16.5 instance never reaches the 16.6
instances, so a page they cached can stay stale until its tag is revalidated again or the entry
expires (up to a year for `revalidate: false` or the `"max"` profile). The reverse holds too. For
this one upgrade, either:

- deploy with recreate rather than rolling, so no 16.5 instance serves alongside 16.6; or
- once the last 16.5 instance is gone, revalidate once from a 16.6 instance:
  `revalidatePath("/", "layout")`, or the tags that changed during the rollout. That goes through
  the shared tag store, so it reaches every instance, including each one's `"use cache"` memory.
  `flushCache()` is not a substitute: it empties only the calling process's memory.

`createCacheHandler` keeps its 16.5 key layout, so its own revalidations are unaffected. Between
16.6 builds, a revalidation reaches every instance, old build and new.

If you keep `createCacheHandler` for now, it keeps working. It now uses the shared connection and
the memory fallback, and its `commandTimeout` default drops from 2000 to 1000 ms.

### From a 16.5.1 `RedisCacheHandler` subclass

Your code keeps working: the class name and constructor are the same, and the internals now
implement the Next 16 contract. Revalidations made by 16.5 instances do not reach 16.6 ones during
the rollout ([above](#revalidations-do-not-cross-the-upgrade) has what to do). You can delete the subclass and use `withCache`. If you keep it:

- With no `redis` option, the handler reads `REDIS_URL`. If that is unset it runs in memory; in
  16.5 it connected to `localhost:6379`.
- `tagPrefix` is ignored. Tag records live in the `<keyPrefix>tags` hash.
- `get` no longer returns `age`. Next computes staleness from `lastModified` and `cacheControl`.

Old keys (`nextjs:cache:*`, `nextjs:tags:*`) are no longer read and expire on their own.

### From `@fortedigital/nextjs-cache-handler` or `@neshca/cache-handler`

```diff
- cacheHandler: require.resolve("./cache-handler.mjs"),   // CacheHandler.onCreation(...)
- cacheMaxMemorySize: 0,
+ export default withCache({ cacheComponents: true });
```

Delete `cache-handler.mjs`. `REDIS_URL` is read directly. neshca's `instrumentation.ts`
`registerInitialCache` pre-population isn't needed: a miss on a prerendered page renders it once
and stores it.

## Deprecated

Kept until the Next 17 line, with JSDoc pointing at the replacement. They keep working in 16.x;
on the Next 17 line they are removed or become a thin shim over the replacement.

| Deprecated | Use instead | Why |
|---|---|---|
| `createCacheHandler` | `withCache`, or `createRemoteCacheHandler` / `createLocalCacheHandler` in a [custom handler](#custom-handlers) | The 16.5 data stack: `"use cache"` only, its own key layout, and no page handler. It does not reconnect after `closeCache()`: create it again. |
| `createRedisDataCacheHandler`, `createIoredisAdapter` | `createRemoteCacheHandler({ client })` | It takes an ioredis client directly; no adapter. |
| `createMemoryDataCacheHandler` | `createLocalCacheHandler` | Memory with tag invalidation shared across instances. |
| `RedisCacheHandler#close()` | `closeCache()` | The same, without needing a handler. |
| `createCacheConfig`, `createCacheConfigWithProfiles` | `withCache` | Both make you write and wire handler files yourself. They keep working. |
| `CompositeHandler`, `createCompositeHandler` | built in | The memory fallback is now inside every handler. |
| `MemoryCacheHandler`, `createMemoryCacheHandler` | `withCache` without `REDIS_URL` | Memory only is the no-URL mode. |
| `bufferToString`, `stringToBuffer`, `jsonReplacer`, `jsonReviver`, `isImplicitTag`, `calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX`, and the Next 14 `CacheHandler*` / `CacheValue` / `LifespanParameters` types | none | Internals of the Next 14 handlers. They still work. |

`RedisCacheHandler` is **not** deprecated. It is the page handler `withCache` uses.

### Legacy setup (deprecated)

The 16.5 wiring still works: a handler file that exports `createCacheHandler({ type })` (`type` is
`"memory"`, `"redis"`, `"valkey"` or `"elasticache"`), wired with `createCacheConfig` or by hand
into `cacheHandlers`. It covers `"use cache"` only, not pages. In production it logs a one-time
reminder to use `withCache`; pass `suppressIsrWarning: true` to silence it.

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

## Usage

Nothing about how you write cached code changes. The package sits behind Next's own APIs:

```tsx
import { cacheLife, cacheTag, revalidateTag } from "next/cache";

async function BlogPost({ id }: { id: string }) {
  "use cache";
  cacheLife("hours");
  cacheTag(`post:${id}`);
  const post = await db.posts.findUnique({ where: { id } });
  return <Article post={post} />;
}

async function ProductList() {
  "use cache: remote"; // shared by every instance through Redis
  return <ProductGrid products={await db.products.findMany()} />;
}

// In a Server Action or route handler
export async function savePost(id: string) {
  await db.posts.update(/* ... */);
  revalidateTag(`post:${id}`, "max"); // every instance, every handler
}
```

## Supported backends

| Backend | How |
|---|---|
| **Memory** | No `REDIS_URL`: dev, CI, previews, single instance |
| **Redis 7+** | `REDIS_URL=redis://…` or `rediss://…` |
| **Valkey** | `VALKEY_URL` or `REDIS_URL`, same URL format |
| **AWS ElastiCache** | `ELASTICACHE_ENDPOINT` + `ELASTICACHE_AUTH_TOKEN`, TLS on |
| **Redis Cluster, Sentinel** | Your own ioredis client through a [custom handler](#custom-handlers). `flushCache` scans every master. |

The minimum is Redis 6.2 (or any Valkey): revalidations use `ZADD GT` and a single-key Lua
script, so the server must allow `EVAL`/`EVALSHA`. CI runs Redis 7 and Valkey 8.

## How it's tested

- **Unit tests** for every module: the codec, the connection, the fallback, the tag store, the page
  handler's Next 16 contract, `withCache` and `flushCache`.
- **A real-Redis outage suite** in CI on Redis 7 and Valkey 8: Redis down at boot, lost mid-run,
  stalled (`docker pause`) and back; a tag revalidation reaching the page, remote and local
  handlers; the build phase never connecting; build-ID scoping and tags crossing builds.
- **End-to-end tests on production builds** (`next build && next start`) with Playwright, against
  memory, Redis, Valkey and TLS + AUTH ElastiCache mode. They cover pages, `"use cache"`,
  `"use cache: remote"`, `revalidateTag`, `revalidatePath`, two instances sharing Redis, and Redis
  stopped mid-run.
- **Next.js's own caching suites** through its deploy-test harness: each suite runs against a
  plain `next start` baseline and against the package with two instances behind a proxy, and a
  suite that passes on the baseline must pass with the package. See
  [tests/next-deploy/README.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/tests/next-deploy/README.md).

| Workflow | What it verifies |
|---|---|
| `.github/workflows/ci.yml` | Lint, format, typecheck, unit tests, the Redis outage suite and the e2e matrix |
| `.github/workflows/next-deploy-tests.yml` | Next.js's caching suites in deploy mode |
| `.github/workflows/nextjs-canary-test.yml` | Daily compatibility runs against Next.js canary and latest |
| `.github/workflows/nextjs-version-check.yml` | Nightly scan for new Next.js releases; opens bump PRs |
| `.github/workflows/publish.yml` | Trusted publishing with provenance |

## Why this package

I was originally going to contribute to
[fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler), but that
project is focused on backwards compatibility and carries a lot of legacy baggage. This one is
written for Next.js 16+ only (Cache Components, `"use cache"`, `cacheLife`), ships with real
end-to-end coverage for every backend, and keeps the surface small: one `withCache` call.

## Documentation

- [GitHub Repository](https://github.com/mrjasonroy/cache-components-cache-handler)
- [Installation & Setup](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/installation.md)
- [Usage Examples](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/usage.md)
- [API Reference](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/api-reference.md)
- [Redis Configuration](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md)
- [Contributing](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CONTRIBUTING.md)

## Development

```bash
git clone https://github.com/mrjasonroy/cache-components-cache-handler
cd cache-components-cache-handler
pnpm install
pnpm build
pnpm test
```

See [docs/development.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/development.md) for details.

## Contributing

This project is AI-friendly and contributor-friendly.

- **For AI Agents:** See [CLAUDE.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CLAUDE.md) for instructions
- **For Humans:** See [CONTRIBUTING.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/CONTRIBUTING.md)

## License

MIT © [Jason Roy](https://github.com/mrjasonroy)

## Acknowledgments

Inspired by [@fortedigital/nextjs-cache-handler](https://github.com/fortedigital/nextjs-cache-handler),
but focused only on Next.js 16+ and its new caching system.
