# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [16.4.3] - 2026-10-26

This is a large release under a patch number. The package version follows Next.js, so the work that went into the 16.4.3 release candidates ships as 16.4.3, and every install on `^16.4.2` or `~16.4.2` gets it on its next update. A 16.4.2 setup keeps working on Node 22.3+ (and, for the page handler, Redis 6.2+ with Lua scripting): deprecated APIs still run, log a one-time warning, and are removed in 16.5.

To upgrade, replace your cache config with `withCache` and set `REDIS_URL` in production (or keep your `ELASTICACHE_*` variables):

```js
// next.config.mjs
import { withCache } from "@mrjasonroy/cache-components-cache-handler";
export default withCache({ cacheComponents: true });
```

To wait, pin the exact version `16.4.2` (not `^16.4.2`). [docs/migrating.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md) has the step-by-step guide.

### Upgrading from 16.4.2

> **Before you upgrade**
>
> - **Node.js 22.3 or later.** `engines.node` moves from `>=22.0.0` to `>=22.3.0`. On Node 22.0–22.2 the first cache call throws `Cannot load node:…: this package needs Node.js 22.3 or later`, and Yarn 1 refuses to install.
> - **Redis 6.2 or later (or Valkey), with Lua scripting allowed,** for `withCache` and the page handler. A revalidation runs one `EVALSHA` and one `ZADD GT`; the deprecated `createCacheHandler` keeps its 16.4.2 commands.
> - **Choose a deploy strategy.** Revalidations do not cross between 16.4.2 and 16.4.3 instances while both serve during a rolling deploy. Deploy with recreate, or revalidate once from 16.4.3 (for example `revalidatePath("/", "layout")`) after the last 16.4.2 instance is gone. Between 16.4.3 builds, revalidations reach every instance.

#### Behaviour you'll notice

- **The page cache starts cold on every deploy.** Page and `"use cache: remote"` keys are new and scoped by build: the deployment ID when `deploymentId` or `NEXT_DEPLOYMENT_ID` is set (so skew protection works), else `BUILD_ID`; an explicit `buildId` option wins. A deploy never serves an earlier build's pages, while tag records are shared across builds. 16.4.2's page keys are never read; `createCacheHandler` keeps the 16.4.2 layout and reads its entries ("What's in Redis" in [docs/redis.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md#whats-in-redis) has the key layout).
- **`"use cache"` stays in each instance; pages go to Redis.** With `withCache`, plain `"use cache"` values stay in each instance's memory and only `"use cache: remote"` goes to Redis. If you relied on `"use cache"` being shared (a `createCacheHandler` setup pointed `cacheHandlers.default` at Redis), switch those functions to `"use cache: remote"`. Pages and route handlers now go to Redis; `withCache(config, { pages: false })` keeps them out. `withCache` throws if the config still sets `cacheHandlers`, or `cacheHandler` unless `pages: false`.
- **Revalidations now reach pages in Redis.** 16.4.2's page handler never read `x-next-cache-tags`, so pages carried no tags and `revalidateTag` / `revalidatePath` never removed them; it wrote a timestamp and deleted keys only for single-tag `fetch` entries, and treated a tag array as one tag (`["t1","t2"]` wrote `nextjs:tags:t1,t2` and invalidated nothing). 16.4.3 applies every tag of every entry, on every instance.
- **Pages 16.4.2 never cached are cached now.** 16.4.2's `RedisCacheHandler` subtracted milliseconds from seconds when computing a TTL, so it stored nothing with a numeric `revalidate` or any numeric `defaultTTL` (its documented `3600` included). Expect more Redis memory and more hits.
- **Page entry lifetimes.** An entry is kept for `1.5 × revalidate`, capped at `expire`; without a revalidate period, until `expire`, else for `defaultTTL` (default 365 days); never more than 365 days, rounded up to whole seconds (16.4.2: no TTL). `RedisCacheHandler.get` no longer returns `age`; Next computes staleness from `lastModified` and `cacheControl`.
- **A `RedisCacheHandler` subclass with no `redis` option** reads `REDIS_URL`, `VALKEY_URL` or the `ELASTICACHE_*` variables, and runs in memory when none is set. 16.4.2 connected to `localhost:6379`.
- **`createCacheHandler` serves stale.** It returns an entry until its `expire`, not its `revalidate`, so Next serves it while regenerating in the background (16.4.2 deleted it at `revalidate`). Entry TTLs are capped at 366 days, and it adds an `EXPIRE` (`tagTTL`, 366 days) on its tag hashes.
- **`next build` no longer connects to Redis.** Entries written during the build stay in the build process; 16.4.2 wrote them to Redis. The same holds with `CACHE_REDIS=off`; on the edge runtime the handlers store nothing (see Fixed).
- **Types.** `CacheHandlerConfig.cacheHandler` is now optional, so code that annotates a variable as `CacheHandlerConfig` and uses `cacheHandler` as a `string` no longer type-checks. `createCacheConfig` / `createCacheConfigWithProfiles` still return `cacheHandler: string` when given an `isrHandlerPath`, and emit `cacheHandler` only when it is non-empty.

#### Logs & ops

- **Redis commands time out after 1 s** (`commandTimeout`, default 1000 ms). All handlers in a process share one connection with no offline queue, which reconnects forever with a backoff capped at 5 s.
- **A Redis outage falls back to memory.** Handlers serve from a bounded per-instance store, each entry for at most 60 s, and requests do not fail; that memory is dropped when Redis is back. In 16.4.2 commands queued with no timeout (a `get` hung for seconds), and the ElastiCache client stopped retrying after 3 attempts and stayed off until a process restart.
- **Not for your own client.** The timeout, shared connection, outage fallback and build-time behaviour above do not apply to the deprecated `createRedisDataCacheHandler` given your own client: that client keeps its own settings.
- **New warnings.** Each deprecated API the app calls logs one line per process, naming its replacement and linking the migration guide. `createCacheHandler` with a Redis backend logs once in production that it does not cover pages, unless a `RedisCacheHandler` is also in use (`suppressIsrWarning: true` turns it off), and a `RedisCacheHandler` subclass with no connection setting logs once in production that it runs in memory.
- **Errors are logged.** Redis errors that 16.4.2's `createCacheHandler` swallowed (it logged them only with `debug: true`) are now logged, rate-limited (once a minute by default), through `setCacheLogger`'s logger or the console.
- **Old keys stay in Redis.** Every page entry 16.4.2 stored (it stored only entries without a TTL), its `nextjs:tags:<tag>` strings and its `nextjs:tags:<tag>:keys` sets never expire. `flushCache({ scope: "all" })` deletes everything under the prefix, 16.4.2's keys and the current cache included. [docs/migrating.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md) covers the old keys and [docs/operations.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/operations.md) the flush scopes.
- **In-process memory is capped at 10% of the V8 heap limit** by default, shared by every in-process store. Change it with `withCache`'s `memory` option or `CACHE_MEMORY_HEAP_PERCENT` / `CACHE_MEMORY_MAX_MIB`.
- **New optional peer dependencies** appear in lockfiles: `@aws-crypto/sha256-js`, `@aws-sdk/credential-provider-node` and `@smithy/signature-v4`. They are needed only for ElastiCache IAM authentication and are not installed unless you add them.
- **Environment variables** that 16.4.2 ignored now take effect: `CACHE_REDIS`, `CACHE_KEY_PREFIX`, `CACHE_DEBUG`, `CACHE_COMPRESSION`, `CACHE_MEMORY_HEAP_PERCENT`, `CACHE_MEMORY_MAX_MIB`, `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME`, `ELASTICACHE_REGION`, `ELASTICACHE_SERVERLESS`, `AWS_REGION` / `AWS_DEFAULT_REGION` (the IAM region when `ELASTICACHE_REGION` is unset) and `NEXT_DEPLOYMENT_ID` (scopes the keys, see above). `ELASTICACHE_AUTH_TOKEN` is ignored when `ELASTICACHE_IAM_USER` is set.

### Deprecated, removed in 16.5

The removal ships with the package's first 16.5 release, which follows Next.js 16.5. That release is 16.5.2, because 16.5.0 and 16.5.1 were published by mistake in October 2026 and cannot be reused.

Each of these still works in 16.4.x and logs one deprecation warning per process on first use (types and `IMPLICIT_TAG_PREFIX` are marked `@deprecated` in JSDoc only). A deprecated factory does not add a second line for the class it builds.

- `createCacheHandler` → `withCache(nextConfig)`, or `createRemoteCacheHandler` / `createLocalCacheHandler` in a custom handler file.
- `createRedisDataCacheHandler` and `createIoredisAdapter` → `withCache`, or `createRemoteCacheHandler({ client })` with the ioredis client.
- `createMemoryDataCacheHandler` → `withCache`, or `createLocalCacheHandler`.
- `createCacheConfig` → `withCache(nextConfig)`; `createCacheConfigWithProfiles` → `withCache(nextConfig, { handlers })`. Called the 16.4.2 way they return the same config; for the type, see "Types" above.
- `MemoryCacheHandler`, `createMemoryCacheHandler` → `withCache` without `REDIS_URL`.
- `CompositeHandler`, `createCompositeHandler` → `withCache`; every handler has a built-in memory fallback.
- `RedisCacheHandler`'s `redis` option → `client` (an ioredis client) or `url`. Its `tagPrefix` option is ignored → remove it.
- `RedisCacheHandler`'s `defaultTTL` as anything but a number → a number of seconds. A numeric string (`"60"`) is converted; a falsy value, a string that isn't a positive number, or any other non-number (`0`, `NaN`, `null`, `""`, `false`, `true`, `"0"`, `"-5"`, `"1h"`, an object) is dropped, so entries get the 365-day default. Each logs a warning once per distinct value. A negative or infinite number throws when the handler is created (16.4.2 cached nothing with those).
- `RedisCacheHandler#close()` → `closeCache()`, which it calls.
- `bufferToString`, `stringToBuffer`, `isImplicitTag`, `jsonReplacer`, `jsonReviver`, `calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX` → no replacement (internal to the Next 14 handlers).
- Types: `CacheValue` → `PageCacheValue`, `CacheHandlerValue` → `PageCacheHandlerValue`, `CacheHandlerContext` → `PageCacheHandlerContext`, `CacheHandlerGetMeta` → `PageCacheGetContext`, `RedisCacheHandlerOptions` → `PageCacheHandlerOptions` (it is an alias). `CacheHandler`, `CacheHandlerOptions`, `LifespanParameters`, `CompositeHandlerOptions`, `MemoryCacheHandlerOptions`, `CacheHandlerConfig`, `DataCacheHandlerOptions`, `CacheHandlerType`, `MemoryDataCacheHandlerOptions`, `RedisDataCacheHandlerOptions`, `RedisClient` and `IoredisLike` go with the APIs above. `DataCacheEntry`, `DataCacheHandler` and `Timestamp` (Next's own contract) are not deprecated.

`RedisCacheHandler` itself is not deprecated: it is the 16.4.3 page handler.

### Added

- **`withCache(nextConfig)` configures the whole cache.** It points `cacheHandler` at the page handler, `cacheHandlers.remote` at Redis and `cacheHandlers.default` at per-instance memory with shared tag invalidation. Each directive keeps Next's meaning: `"use cache"` values stay in each instance's memory, `"use cache: remote"` entries go to Redis, and `"use cache: private"` never reaches a handler. With `REDIS_URL` set, pages, route handlers, cached `fetch` and `"use cache: remote"` are shared across instances, and every revalidation reaches every instance, `"use cache"` memory included. Without it everything stays in memory. Options: `pages: false` (keep your own `cacheHandler`), `handlers` (your own handler files) and `memory`; an unknown option throws. It works with `cacheComponents: true` and with Next's deprecated `experimental.useCache`, and accepts a function-form `next.config`. Unless `pages: false`, it also sets `cacheMaxMemorySize: 0`, keeping a value you set (with a warning if it is not 0). Runtime settings come from the environment (`REDIS_URL`, `CACHE_KEY_PREFIX`, `CACHE_REDIS=off`, `CACHE_DEBUG=1`), so they work the same under `next start`, standalone and Docker. The `memory` option does not reach a standalone `server.js`, which does not load `next.config`; set `CACHE_MEMORY_*` there.
- **A Next 16 page handler.** `RedisCacheHandler` is rewritten to Next 16's `cacheHandler` contract, keeping its name and constructor. It honours `x-next-cache-tags` (implicit path tags included, Pages Router values too), soft tags, `fetch` tags and `cacheControl`, so `revalidateTag` and `revalidatePath` invalidate pages and route handlers on every instance. Revalidation is timestamp-based: each read fetches the entry's tag records in the same round trip as the entry (a second one the first time a process reads that entry), so the next read on any instance sees a revalidation. `revalidateTag(tag, "max")` serves the page once more and regenerates it in the background. `createPageCacheHandler(options)` builds one for a custom handler file.
- **Distributed tag coordination for `"use cache"`**, following Next's [documented pattern](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination). Values stay in each instance's memory. `updateTags` writes the revalidation to Redis, `refreshTags` syncs it into local state at most every 100 ms, with concurrent requests sharing one sync, and `getExpiration` reads local state only. A failed or skipped tag check is a miss, never a stale hit. While Redis is reachable, `revalidateTag` resolves only after Redis has answered the write. When Redis is not ready, it returns after waiting at most 500 ms for the connection; the revalidation applies in this process and is sent when Redis is back, and a failed write is queued again. Instances compare times on wall clock, allowing 5 s of skew between machines.
- **Connection tuning and outage handling** for every handler, beyond the shared connection and timeout above: a connection that times out `maxConsecutiveTimeouts` (3) times in a row is dropped and redialled, and timed-out commands are not resent; startup waits at most 500 ms for the first connection. A `client` you pass in is never disconnected or reconfigured: the package's own commands on it are bounded by `commandTimeout`, and 3 timeouts in a row send the handlers to memory for 2 s at a time. `connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts` are options of every factory and of `flushCache`. Handlers given different settings for the same server open separate connections, with a warning.
- **A binary entry format.** Page and `"use cache: remote"` entries store bytes raw instead of base64 JSON, the duplicated `/_full` RSC payload once, and entries of 16 KB and more compressed with Brotli (quality 4, off the event loop). Entries over 64 MB are stored uncompressed, and a compressed entry claiming more than 64 MB is a miss. A corrupt or unknown entry is a miss. `CACHE_COMPRESSION=off` stores entries uncompressed.
- **A bounded memory budget.** The in-process stores (`"use cache"` values, page and `"use cache: remote"` entries without Redis, their outage copies, entry tag lists) share one budget per runtime, sized from V8's heap limit (the default is under Logs & ops; 98 MiB where `node:v8` is unavailable), split by fixed ratios. Keys count toward a store's size, and an entry larger than its store's cap is not kept in memory. Invalid values and unknown `memory` keys throw; a budget over half the heap limit logs a warning. See "Memory" in [docs/operations.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/operations.md#memory), including pod sizing.
- **Tag records are bounded.** Redis 7.4+ and Valkey 9+ expire them with hash-field TTLs, and standalone servers also prune them in the background. A record is kept until 365 days plus 10 s after its later deadline; flush records are kept. A Cluster without hash-field TTLs keeps every record until flushed and logs a rate-limited warning. Records held in process memory follow the same horizon.
- **`flushCache({ scope })`** deletes the current build's keys (`"build"`, the default) or every key under the prefix (`"all"`) with SCAN + UNLINK, on every Cluster master and on ElastiCache Serverless (tested against a real Serverless Valkey 8.1 cache), and empties the calling process's memory stores. It records the flush as a revalidation, so older build output is not served again. On a Cluster, keys that still fail after a slot-migration redirect are reported as `{ deleted, partial: true, failed }`; a node that stops answering makes it throw. It refuses `scope: "all"` with an empty key prefix. Called before any handler has connected (a script, a test), it opens its own connection and closes it before returning. Put it behind your own authenticated route; the package ships no endpoint.
- **`closeCache()`** lets a test run, script or CLI exit: it closes every connection the package opened, empties its memory stores and drops its tag state, after sending unacknowledged revalidations one last time. It never fails because Redis is down and never closes a `client` you passed in. Handlers created before it reconnect on their next call, except the deprecated `createCacheHandler`. For a test suite: `afterAll(() => closeCache())`.
- **`setCacheLogger(logger)`** (in `instrumentation.ts`) sends every warning, error and `CACHE_DEBUG` line to your logger (`error` and `warn`, optionally `info` and `debug`); [docs/operations.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/operations.md) has a one-line adapter for pino and bunyan. Custom handler files can pass `logger` instead. A logger that throws never fails a cache call.
- `createRemoteCacheHandler` and `createLocalCacheHandler` for custom handler files. `createRemoteCacheHandler` takes `defaultTTL`, the seconds to keep an entry whose `expire` is infinite (default 24 hours, at most 365 days); a value that is not a finite number greater than 0 throws.
- **ElastiCache IAM authentication.** Set `ELASTICACHE_IAM_USER`, `ELASTICACHE_CACHE_NAME` and `ELASTICACHE_REGION` (else `AWS_REGION` or `AWS_DEFAULT_REGION`) with `ELASTICACHE_ENDPOINT` or a `rediss://` `REDIS_URL`; serverless caches are detected from a `.serverless.` endpoint, or set `ELASTICACHE_SERVERLESS=true`. In a custom handler file use the `iam` option; for your own `Redis` or `Cluster` client (needed for cluster-mode-enabled ElastiCache) call `attachElastiCacheIamAuth(client, options)`. Tokens are signed with the AWS SDK's default credential chain and refreshed every 10 minutes, and sent as `AUTH` on the live connection, so the 12-hour connection limit never closes it. The token is never logged. It needs TLS, Valkey 7.2+ or Redis OSS 7.0+, and the three optional peer dependencies; misconfiguration throws at startup. 16.4.2 had no IAM support: a token passed as a password expired after 15 minutes, so reconnects failed. See "IAM authentication" in [docs/redis.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md).
- `createCacheHandler` gains the shared connection, the outage fallback and the options `client`, `memoryFallback`, `fallbackTTL`, `commandTimeout`, `defaultTTL`, `tagTTL` (366 days), `errorLogIntervalMs` and `suppressIsrWarning`. A `get` waits for an in-flight `set` of the same key in the process, and an entry that has already expired is not stored.
- `CACHE_DEBUG=1` (or `debug: true`) logs hits, misses and state changes, and each value's size on `get` and `set`.

### Changed

- Importing the package no longer loads `ioredis`; 16.4.2 loaded it at import through `RedisCacheHandler`.
- `withCache`'s handlers never keep or serve a value past 365 days (`cacheLife("max")`'s `expire`), in Redis or any memory store. `createCacheHandler` keeps its 366-day cap.
- `createCacheHandler`'s tag `expired` deadline no longer deletes an entry written after it, as in Next, and an entry's tags are checked concurrently.
- `jsonReplacer` / `jsonReviver` store a Buffer as base64 at every nesting level, not only at the top.
- Connection options must be serializable: options that refer to themselves throw when the handler is created.
- Logged errors are scrubbed. ioredis attaches the failed command, arguments included, to a Redis error, so an `AUTH` failure could log the password. Every warning and error now logs errors with only their name, message, stack and network fields, objects without password-like keys, and URLs without their user information. Other free text in a message is not scrubbed.

### Fixed

- **Prerendered routes are served from the build output.** A custom `cacheHandler` replaces Next's file system cache, so with 16.4.2 prerendered pages and route handlers (sitemaps, robots, manifests) were rendered again on their first request. On a miss the page handler now reads the build output through Next's own `FileSystemCache`, with the usual tag check, and writes it to Redis. A dynamic route's prerendered fallback shell is served too. A route with a revalidate period is served from the build output only within `1.5 × revalidate` (capped at `expire`) of the build. The build time comes from `cache-handler-build.json`, which the page handler writes into `.next/server` during `next build`; ship it with `.next`.
- **Route handlers with sequential `"use cache"` calls are prerendered.** With `cacheComponents`, Next aborts a prerender that reads the clock through `Date`, and the handlers did, so such a route was silently built as dynamic. The handlers no longer read `Date` during a prerender.
- **Edge middleware no longer crashes.** Next bundles the page handler into the edge middleware, where importing the package called `createRequire` and failed every request with a 500. The handler entries import no Node built-in at load time, and on the edge runtime the handlers are no-ops (every read a miss).
- **An older revalidation arriving late no longer undoes a newer one.** Tag records are merged in Redis by a single-key Lua script in the order the revalidations were made, and the tag index uses `ZADD GT`.

### Docs

- The README is a short landing page around `withCache`. Reference material is in `docs/`: [how-it-works.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/how-it-works.md), [operations.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/operations.md) (flushing, closing, logging, memory), [custom-handlers.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/custom-handlers.md), [migrating.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/migrating.md) (from 16.4.2, from `RedisCacheHandler` subclasses, and from `@fortedigital/nextjs-cache-handler` / `@neshca/cache-handler`), [redis.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/redis.md) (key layout and sizing) and [api-reference.md](https://github.com/mrjasonroy/cache-components-cache-handler/blob/main/docs/api-reference.md) (exports and deprecations).
- `cacheMaxMemorySize` is documented as having no effect with `withCache`: it sizes Next's own caches, which Next does not use once the handlers are set.
- `createCacheHandler`'s documented `keyPrefix` default is the real one, `nextjs:data-cache:`.

### Changes between release candidates

For anyone who tested `16.4.3-rc.3` or earlier. What to change for `16.4.3-rc.4` and the final release:

- `withCache`'s `useCache: "memory" | "redis"` option is removed. Plain `"use cache"` always stays in each instance's memory; write `"use cache: remote"` for entries that belong in Redis. Passing `useCache` throws, saying so.
- `withCache` throws on any option other than `pages`, `handlers` and `memory`.
- `MEMORY_ONLY_TAG` (`"cache:memory-only"`) is removed and is an ordinary tag now: with Redis configured, every page and `"use cache: remote"` entry goes to Redis. Use `"use cache"` for per-instance data.
- With Redis connected, the in-memory page and `"use cache: remote"` stores no longer fill; only the outage fallbacks hold entries.
- `createRedisCacheHandler` is renamed `createPageCacheHandler`, with no alias. Its options type is `PageCacheHandlerOptions`; `RedisCacheHandlerOptions` is a deprecated alias of it, removed in 16.5.
- `RedisCacheHandler` accepts any non-number `defaultTTL` with a warning instead of throwing; negative and infinite numbers still throw. The details are under "Deprecated" above.
- The 16.4.2 APIs log a one-time deprecation warning and are removed in 16.5 (earlier candidates said "on the Next 17 line", and rc.4 said "16.5.0", a version npm can no longer publish).

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
