# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [16.4.3] - Unreleased

This is a large release under a patch number. The package version follows Next.js, so the work that went into the 16.4.3 release candidates ships as 16.4.3, and every install on `^16.4.2` or `~16.4.2` gets it on its next update. A 16.4.2 setup keeps working: deprecated APIs still run and log a one-time warning, and are removed in 16.5.0.

To upgrade, replace your cache config with `withCache` and set `REDIS_URL` in production:

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";
export default withCache({ cacheComponents: true });
```

To wait, pin the exact version `16.4.2` (not `^16.4.2`). `docs/migrating.md` has the step-by-step guide.

### Upgrading from 16.4.2

What changes when you upgrade, even if you change no code:

- **Node.js 22.3 or later.** `engines.node` moves from `>=22.0.0` to `>=22.3.0`. The package needs `process.getBuiltinModule`: on Node 22.0–22.2 the first cache call throws `Cannot load node:…: this package needs Node.js 22.3 or later`, and Yarn 1 refuses to install. Upgrade Node first.
- **Redis 6.2 or later (or Valkey), with Lua scripting allowed,** for `withCache` and the page handler: a revalidation runs one `EVALSHA` and one `ZADD GT`. The deprecated `createCacheHandler` keeps its 16.4.2 commands.
- **The cache starts cold once.** The page handler's keys are new: `<keyPrefix><buildId>:page:<key>` (`:data:` for `"use cache: remote"`), in a binary format, plus two tag keys, `<keyPrefix>tags` and `<keyPrefix>tag-index`. The build ID is the deployment ID when `deploymentId` or `NEXT_DEPLOYMENT_ID` is set, else `BUILD_ID`, so every deploy starts cold for pages from now on. 16.4.2's page keys (`nextjs:cache:*`) are never read. `createCacheHandler` keeps the 16.4.2 layout and format, and reads entries 16.4.2 wrote.
- **Revalidations do not cross a rolling deploy from 16.4.2.** While 16.4.2 and 16.4.3 instances serve side by side, a `revalidateTag` or `revalidatePath` handled by one version does not reach the other's page cache. Deploy this upgrade with recreate, or revalidate once from 16.4.3 (for example `revalidatePath("/", "layout")`) after the last 16.4.2 instance is gone. Between 16.4.3 builds, revalidations reach both.
- **Old keys stay in Redis.** 16.4.2 entries written with a TTL expire on their own. Entries 16.4.2 wrote without a TTL, and its `nextjs:tags:<tag>` tag strings, stay until deleted. Once no 16.4.2 instance is left, `flushCache({ scope: "all" })` deletes every key under the prefix (`CACHE_KEY_PREFIX`, default `nextjs:`; pass `keyPrefix` for another one), 16.4.2's included. It also empties the current cache, including `createCacheHandler`'s `nextjs:data-cache:*` entries, and any other app's keys that share the prefix.
- **New warnings in the logs.** Each deprecated API the app calls logs one line per process, naming its replacement and linking `docs/migrating.md`. `createCacheHandler` with a Redis backend logs once in production that it does not cover pages, unless the package's page handler runs in the same process or `suppressIsrWarning: true` is set. A `RedisCacheHandler` subclass with no connection setting logs once in production that it is running in memory. Redis errors that 16.4.2 swallowed are now logged, rate-limited (once a minute by default), through `setCacheLogger`'s logger or the console.
- **Redis commands time out after 1 s** (`commandTimeout`, default 1000 ms; 16.4.2 had no timeout). All handlers in a process share one connection with no offline queue. It reconnects forever with a backoff capped at 5 s; 16.4.2's ElastiCache client gave up after 3 retries and left the cache off until a restart.
- **A Redis outage falls back to memory.** While Redis is down, handlers serve from a bounded per-instance memory store, each entry for at most 60 s, and the request does not fail. That memory is dropped when Redis is back.
- **`next build` no longer connects to Redis.** Entries written during the build stay in the build process. 16.4.2 connected and wrote them to Redis. The same holds with `CACHE_REDIS=off` and on the edge runtime.
- **In-process memory is capped at 10% of the V8 heap limit** by default, shared by every in-process store. Change it with `withCache(config, { memory: { heapPercent } })` or `{ memory: { maxMiB } }`, or `CACHE_MEMORY_HEAP_PERCENT` / `CACHE_MEMORY_MAX_MIB`.
- **New optional peer dependencies** appear in lockfiles: `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node` and `@smithy/signature-v4`. They are needed only for ElastiCache IAM authentication and are not installed unless you add them. `ioredis` stays an optional dependency.
- **A `RedisCacheHandler` subclass with no `redis` option** reads `REDIS_URL`, `VALKEY_URL` or the `ELASTICACHE_*` variables, and runs in memory when none is set. 16.4.2 connected to `localhost:6379`.
- **Page entry lifetimes.** The page handler keeps an entry for `1.5 × revalidate`, capped at `expire`, and for 365 days without a revalidate period (16.4.2: no TTL). No entry is kept or served past 365 days. `RedisCacheHandler.get` no longer returns `age`; Next computes staleness from `lastModified` and `cacheControl`.
- **`createCacheHandler` serves stale.** It returns an entry until its `expire`, not its `revalidate`, so Next serves it while regenerating in the background (16.4.2 deleted it at `revalidate`). The Redis TTL is the time left to `expire`, capped at 366 days, and tag records get a TTL too.
- **Environment variables** that 16.4.2 ignored now take effect if your app happens to set them: `CACHE_REDIS`, `CACHE_KEY_PREFIX`, `CACHE_DEBUG`, `CACHE_COMPRESSION`, `CACHE_MEMORY_HEAP_PERCENT`, `CACHE_MEMORY_MAX_MIB`, `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION` and `ELASTICACHE_SERVERLESS`. `ELASTICACHE_AUTH_TOKEN` is ignored when `ELASTICACHE_IAM_USER` is set.

### Deprecated, removed in 16.5.0

Each of these still works in 16.4.x and logs one deprecation warning per process on first use (types and `IMPLICIT_TAG_PREFIX` are marked `@deprecated` in JSDoc only). A deprecated factory does not add a second line for the class it builds.

- `createCacheHandler` → `withCache(nextConfig)`, or `createRemoteCacheHandler` / `createLocalCacheHandler` in a custom handler file.
- `createRedisDataCacheHandler` and `createIoredisAdapter` → `withCache`, or `createRemoteCacheHandler({ client })` with the ioredis client.
- `createMemoryDataCacheHandler` → `withCache`, or `createLocalCacheHandler`.
- `createCacheConfig` → `withCache(nextConfig)`; `createCacheConfigWithProfiles` → `withCache(nextConfig, { handlers })`. Called the 16.4.2 way they return the same config and type: `cacheHandler` is a `string` when `isrHandlerPath` is passed, and `string | undefined` otherwise.
- `MemoryCacheHandler`, `createMemoryCacheHandler` → `withCache` without `REDIS_URL`.
- `CompositeHandler`, `createCompositeHandler` → `withCache`; every handler has a built-in memory fallback.
- `RedisCacheHandler` options: `redis` → `client` (an ioredis client) or `url`; `tagPrefix` is ignored → remove it; `defaultTTL` given as a falsy value (`0`, `NaN`, `null`, `""`, `false`, 16.4.2's "no expiry") is dropped, so entries get the 365-day default → omit it; `defaultTTL` as a numeric string is converted → pass a number. Any other `defaultTTL` that is not a finite number greater than 0 (negative, `Infinity`, `"0"`, a non-numeric string) throws when the handler is created; 16.4.2 cached nothing with those.
- `RedisCacheHandler#close()` → `closeCache()`, which it calls.
- `bufferToString`, `stringToBuffer`, `isImplicitTag`, `jsonReplacer`, `jsonReviver`, `calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX` → no replacement (internal to the Next 14 handlers).
- Types: `CacheValue` → `PageCacheValue`, `CacheHandlerValue` → `PageCacheHandlerValue`, `CacheHandlerContext` → `PageCacheHandlerContext`, `CacheHandlerGetMeta` → `PageCacheGetContext`, `RedisCacheHandlerOptions` → `PageCacheHandlerOptions`. `CacheHandler`, `CacheHandlerOptions`, `LifespanParameters`, `CompositeHandlerOptions`, `MemoryCacheHandlerOptions`, `CacheHandlerConfig`, `DataCacheHandlerOptions`, `CacheHandlerType`, `MemoryDataCacheHandlerOptions`, `RedisDataCacheHandlerOptions`, `RedisClient` and `IoredisLike` go with the APIs above. `DataCacheEntry`, `DataCacheHandler` and `Timestamp` (Next's own contract) are not deprecated.

`RedisCacheHandler` itself is not deprecated: it is the 16.4.3 page handler.

### Added

- **`withCache(nextConfig)` configures the whole cache.** It points `cacheHandler` at the page handler, `cacheHandlers.remote` at Redis and `cacheHandlers.default` at per-instance memory with shared tag invalidation, and sets `cacheMaxMemorySize: 0`. Each directive keeps Next's meaning: `"use cache"` values stay in each instance's memory, `"use cache: remote"` entries go to Redis, and `"use cache: private"` never reaches a handler. With `REDIS_URL` set, pages, route handlers, cached `fetch` and `"use cache: remote"` are shared across instances, and every revalidation reaches every instance, `"use cache"` memory included. Without it everything stays in memory. Options: `pages: false` (keep your own `cacheHandler`), `handlers` (your own handler files) and `memory`; an unknown option throws. It works with `cacheComponents: true` and with Next's deprecated `experimental.useCache`, accepts a function-form `next.config`, and keeps a `cacheMaxMemorySize` you set (with a warning if it is not 0). Runtime settings come from the environment (`REDIS_URL`, `CACHE_KEY_PREFIX`, `CACHE_REDIS=off`, `CACHE_DEBUG=1`), so they work the same under `next start`, standalone and Docker.
- **A Next 16 page handler.** `RedisCacheHandler` is rewritten to Next 16's `cacheHandler` contract, keeping its name and constructor. It honours `x-next-cache-tags` (implicit path tags included, Pages Router values too), soft tags, `fetch` tags and `cacheControl`, so `revalidateTag` and `revalidatePath` invalidate pages and route handlers on every instance. Revalidation is timestamp-based (16.4.2 deleted the tagged keys): each read fetches the entry's tag records in the same round trip as the entry, so the next read on any instance sees a revalidation. `revalidateTag(tag, "max")` serves the page once more and regenerates it in the background. `createPageCacheHandler(options)` builds one for a custom handler file.
- **Distributed tag coordination for `"use cache"`**, following Next's [documented pattern](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination). Values stay in each instance's memory. `updateTags` writes the revalidation to Redis, `refreshTags` syncs it into local state once per request, and `getExpiration` reads local state only. A failed or skipped tag check is a miss, never a stale hit. A revalidation made while Redis is unreachable is sent when it is back, and `revalidateTag` resolves only after Redis has acknowledged it. Instances compare times on wall clock, allowing 5 s of skew between machines.
- **Entries scoped by build.** A deploy never serves an earlier build's pages or RSC payloads. Keys are scoped by the deployment ID when one is set (so skew protection works), else by `BUILD_ID`; an explicit `buildId` option wins. Tag records are shared across builds.
- **Shared connection and outage handling** for every handler: one connection per process; commands time out after `commandTimeout` (1000 ms); a connection that times out `maxConsecutiveTimeouts` (3) times in a row is dropped and redialled, and timed-out commands are not resent; startup waits at most 500 ms for the first connection. A `client` you pass in is never disconnected or reconfigured: the package's own commands on it are bounded by `commandTimeout`, and 3 timeouts in a row send the handlers to memory for 2 s at a time. `connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts` are options of every factory and of `flushCache`. Handlers given different settings for the same server open separate connections, with a warning.
- **A binary entry format.** Page and `"use cache: remote"` entries store bytes raw instead of base64 JSON, the duplicated `/_full` RSC payload once, and entries of 16 KB and more compressed with Brotli (quality 4, off the event loop). Entries over 64 MB are stored uncompressed, and a compressed entry claiming more than 64 MB is a miss. A corrupt or unknown entry is a miss. `CACHE_COMPRESSION=off` stores entries uncompressed.
- **A bounded memory budget.** The in-process stores (`"use cache"` values, page and `"use cache: remote"` entries without Redis, their outage copies, entry tag lists) share one budget per runtime, 10% of V8's heap limit by default (98 MiB where `node:v8` is unavailable), split by fixed ratios. Keys count toward a store's size, and an entry larger than its store's cap is not kept in memory. Invalid values and unknown `memory` keys throw; a budget over half the heap limit logs a warning. See "Memory" in `docs/operations.md`, including pod sizing.
- **Tag records are bounded.** Redis 7.4+ and Valkey 9+ expire them with hash-field TTLs, and standalone servers also prune them in the background. A record is kept until 365 days plus 10 s after its later deadline; flush records are kept. A Cluster without hash-field TTLs keeps every record until flushed and logs a rate-limited warning. Records held in process memory follow the same horizon.
- **`flushCache({ scope })`** deletes the current build's keys (`"build"`, the default) or every key under the prefix (`"all"`) with SCAN + UNLINK, on every Cluster master and on ElastiCache Serverless, and empties the calling process's memory stores. It records the flush as a revalidation, so older build output is not served again. On a Cluster, keys that still fail after a slot-migration redirect are reported as `{ deleted, partial: true, failed }`; a node that stops answering makes it throw. It refuses `scope: "all"` with an empty key prefix. Called before any handler has connected (a script, a test), it opens its own connection and closes it before returning. Put it behind your own authenticated route; the package ships no endpoint.
- **`closeCache()`** lets a test run, script or CLI exit: it closes every connection the package opened, empties its memory stores and drops its tag state, after sending unacknowledged revalidations one last time. It never fails because Redis is down and never closes a `client` you passed in. Handlers created before it reconnect on their next call, except the deprecated `createCacheHandler`. For a test suite: `afterAll(() => closeCache())`.
- **`setCacheLogger(logger)`** (in `instrumentation.ts`) sends every warning, error and `CACHE_DEBUG` line to your logger (`error` and `warn`, optionally `info` and `debug`); `docs/operations.md` has a one-line adapter for pino and bunyan. Custom handler files can pass `logger` instead. A logger that throws never fails a cache call.
- `createRemoteCacheHandler` and `createLocalCacheHandler` for custom handler files. `createRemoteCacheHandler` takes `defaultTTL`, the seconds to keep an entry whose `expire` is infinite (default 24 hours, at most 365 days); a value that is not a finite number greater than 0 throws.
- **ElastiCache IAM authentication.** Set `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME` and `ELASTICACHE_REGION` (else `AWS_REGION` or `AWS_DEFAULT_REGION`) with `ELASTICACHE_ENDPOINT` or a `rediss://` `REDIS_URL`; serverless caches are detected from a `.serverless.` endpoint, or set `ELASTICACHE_SERVERLESS=true`. In a custom handler file use the `iam` option; for your own `Redis` or `Cluster` client (needed for cluster-mode-enabled ElastiCache) call `attachElastiCacheIamAuth(client, options)`. Tokens are signed with the AWS SDK's default credential chain and refreshed every 10 minutes, and sent as `AUTH` on the live connection, so the 12-hour connection limit never closes it. The token is never logged. It needs TLS, Valkey 7.2+ or Redis OSS 7.0+, and the three optional peer dependencies; misconfiguration throws at startup. 16.4.2 could only take a token as a password, which stopped working on the first reconnect after 15 minutes. See "IAM authentication" in `docs/redis.md`.
- `createCacheHandler` gains the shared connection, the outage fallback and the options `client`, `memoryFallback`, `fallbackTTL`, `commandTimeout`, `defaultTTL`, `tagTTL` (366 days), `errorLogIntervalMs` and `suppressIsrWarning`. A `get` waits for an in-flight `set` of the same key in the process, and an entry that has already expired is not stored.
- `CACHE_DEBUG=1` (or `debug: true`) logs hits, misses and state changes, and each value's size on `get` and `set`.

### Changed

- Importing the package no longer loads `ioredis`; 16.4.2 loaded it at import through `RedisCacheHandler`.
- The page handler's `tagPrefix` option is ignored: tag records live in the `<keyPrefix>tags` hash. Its `defaultTTL` defaults to 365 days, applies only to entries with neither `revalidate` nor `expire`, and is rounded up to whole seconds.
- No cached value is kept or served past 365 days (`cacheLife("max")`'s `expire`), in Redis or any memory store.
- `createCacheHandler`'s tag `expired` deadline no longer deletes an entry written after it, as in Next, and an entry's tags are checked concurrently.
- `jsonReplacer` / `jsonReviver` store a Buffer as base64 at every nesting level, not only at the top.
- Connection options must be serializable: options that refer to themselves throw when the handler is created.
- Logged errors are scrubbed. ioredis attaches the failed command, arguments included, to a Redis error, so an `AUTH` failure could log the password. Every warning and error now logs errors with only their name, message, stack and network fields, objects without password-like keys, and URLs without their user information. Other free text in a message is not scrubbed.
- `createCacheConfig` / `createCacheConfigWithProfiles` accept `isrHandlerPath` as optional and emit `cacheHandler` only when it is passed.

### Fixed

- **Prerendered routes are served from the build output.** A custom `cacheHandler` replaces Next's file system cache, so with 16.4.2 prerendered pages and route handlers (sitemaps, robots, manifests) were rendered again on their first request. On a miss the page handler now reads the build output through Next's own `FileSystemCache`, with the usual tag check, and writes it to Redis. A dynamic route's prerendered fallback shell is served too. A route with a revalidate period is served from the build output only within `1.5 × revalidate` (capped at `expire`) of the build. The build time comes from `cache-handler-build.json`, which the page handler writes into `.next/server` during `next build`; ship it with `.next`.
- **Route handlers with sequential `"use cache"` calls are prerendered.** With `cacheComponents`, Next aborts a prerender that reads the clock through `Date`, and the handlers did, so such a route was silently built as dynamic. The handlers no longer read `Date` during a prerender.
- **Edge middleware no longer crashes.** Next bundles the page handler into the edge middleware, where importing the package called `createRequire` and failed every request with a 500. The handler entries import no Node built-in at load time, and on the edge runtime the handlers are no-ops (every read a miss).
- **An older revalidation arriving late no longer undoes a newer one.** Tag records are merged in Redis by a single-key Lua script in the order the revalidations were made, and the tag index uses `ZADD GT`.

### Docs

- The README is a short landing page around `withCache`. Reference material is in `docs/`: `how-it-works.md`, `operations.md` (flushing, closing, logging, memory), `custom-handlers.md`, `migrating.md` (from 16.4.2, from `RedisCacheHandler` subclasses, and from `@fortedigital/nextjs-cache-handler` / `@neshca/cache-handler`), `redis.md` (key layout and sizing) and `api-reference.md` (exports and deprecations).
- `cacheMaxMemorySize` is documented as having no effect with `withCache`: it sizes Next's own caches, which Next does not use once the handlers are set.
- `createCacheHandler`'s documented `keyPrefix` default is the real one, `nextjs:data-cache:`.

### Changes between release candidates

For anyone who tested `16.4.3-rc.3` or earlier. What to change for `16.4.3-rc.4` and the final release:

- `withCache`'s `useCache: "memory" | "redis"` option is removed. Plain `"use cache"` always stays in each instance's memory; write `"use cache: remote"` for entries that belong in Redis. Passing `useCache` throws, saying so.
- `withCache` throws on any option other than `pages`, `handlers` and `memory`.
- `MEMORY_ONLY_TAG` (`"cache:memory-only"`) is removed and is an ordinary tag now: with Redis configured, every page and `"use cache: remote"` entry goes to Redis. Use `"use cache"` for per-instance data.
- `createRedisCacheHandler` is renamed `createPageCacheHandler`, with no alias. Its options type is `PageCacheHandlerOptions`.
- `RedisCacheHandler` accepts the `defaultTTL` values 16.4.2 accepted (falsy and numeric strings) with a warning, instead of throwing.
- The 16.4.2 APIs log a one-time deprecation warning and are removed in 16.5.0 (earlier candidates said "on the Next 17 line").

## [16.0.0] - 2025-11-18

### Added

- `CHANGELOG.md` to track releases.
- Test coverage for the zero-config data cache factory, ensuring Redis/Valkey env handling works across backends.

### Changed

- Promoted the package from `16.0.0-alpha.6` to the first stable release aligned with Next.js 16.
- Updated the zero-config factory to load `ioredis` safely in pure ESM projects and to honor TLS/password options (including AWS ElastiCache env vars).
- Removed the unused CommonJS export entry; the package is now explicitly ESM-only.
- Reworked documentation (README, installation guide, Redis guide, package README) to reflect the modern APIs, supported backends, CI guarantees, and the motivation for this new repo.

### Fixed

- Redis/Valkey/ElastiCache handlers now apply `REDIS_PASSWORD`, `ELASTICACHE_*` env vars, and custom TLS options so production deployments connect successfully.
