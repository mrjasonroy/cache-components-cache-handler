# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [16.6.0] - 2026-10-19

### Added

- **`withCache(nextConfig)`: one call configures the whole cache.** It points `cacheHandler` at the page handler, `cacheHandlers.remote` at Redis, `cacheHandlers.default` at per-instance memory with shared tag invalidation, and sets `cacheMaxMemorySize: 0`. Set `REDIS_URL` in production and pages, route handlers, cached `fetch`, `"use cache"` and `"use cache: remote"` are all shared across instances. Without it everything stays in memory. Options: `useCache: "memory" | "redis"`, `pages: false`, and `handlers` for your own handler files. It also accepts a function-form `next.config`, and keeps a `cacheMaxMemorySize` you set yourself (with a warning if it is not 0). Runtime settings come from the environment (`REDIS_URL`, `CACHE_KEY_PREFIX`, `CACHE_REDIS=off`, `CACHE_DEBUG=1`), so they work the same under `next start`, standalone and Docker.
- **A working Next 16 page handler.** `RedisCacheHandler` is rewritten in place to the Next 16 `cacheHandler` contract, which finishes the DEC-2 "fix rather than remove". It honours `x-next-cache-tags` (implicit path tags included), soft tags, `fetch` tags and `cacheControl`, so `revalidateTag` and `revalidatePath` now invalidate pages and route handlers on every instance. Each read checks the tag records in Redis in the same round trip as the entry, so the next read on any instance sees a revalidation, with no added latency. `revalidateTag(tag, "max")` serves the page once more and regenerates it in the background. Entries are kept for `1.5 × revalidate`, capped at `expire`. The class name and constructor are unchanged, so 16.5.1 subclasses keep working. `createRedisCacheHandler(options)` builds one for a custom handler file.
- **Redis outages are absorbed.** Every handler shares one connection per process and fails fast: a command times out after 1 s, a connection that times out 3 times in a row is dropped and redialled, and startup waits at most 500 ms. A `client` you pass in is never disconnected or reconfigured: the package's own commands on it go through a proxy bounded by `commandTimeout`, and 3 timeouts in a row send the handlers to memory for 2 s at a time. While Redis is down, handlers serve from per-instance memory, each entry for at most 60 s, and log errors at most once a minute. When Redis comes back that memory is dropped. A request never fails because of the cache. The build phase never connects to Redis.
- **Distributed tag coordination for `"use cache"`**, following Next's [documented pattern](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination). Values stay in each instance's memory. `updateTags` writes the invalidation to Redis, `refreshTags` syncs it into local state once per request, and `getExpiration` reads local state only, so `revalidateTag` on one instance clears every instance's copy without a Redis call per lookup.
- **Entries scoped by build ID.** A deploy never serves the previous build's pages or RSC payloads. Tag records are shared across builds, so a revalidation during a rolling deploy reaches both.
- **A binary entry format (v2).** Bytes are stored raw instead of base64 JSON: about 25% less Redis memory and network, and a page shell `get` about 40% faster.
- **`flushCache({ scope })`** deletes the current build's keys (`"build"`, the default) or everything under the prefix (`"all"`) with SCAN + UNLINK, Cluster included, and empties the calling process's in-memory stores. It refuses `scope: "all"` with an empty key prefix. Put it behind your own authenticated route; the package ships no endpoint.
- `createRemoteCacheHandler`, `createLocalCacheHandler` and `MEMORY_ONLY_TAG` (keeps an entry out of Redis) for custom handler files.
- `createCacheHandler` gains the shared connection, the outage fallback and three options: `client`, `memoryFallback` and `fallbackTTL`. It keeps its 16.5 key layout and format.
- CI runs Next.js's own caching suites through its deploy-test harness, with two instances behind a proxy, and fails on any suite that passes on plain `next start` but not with the package (`tests/next-deploy/README.md`). A real-Redis outage suite runs on Redis 7 and Valkey 8, and the e2e app now runs two instances against one Redis and stops Redis mid-run.

### Changed

- **The cache starts cold on upgrade.** The new layout is `<prefix><buildId>:page:` / `:data:`, plus two tag keys, `<prefix>tags` and `<prefix>tag-index`. The 16.5 page handler's keys (`nextjs:cache:*`, `nextjs:tags:*`) are no longer read and expire on their own. `createCacheHandler` keys are unaffected.
- `createCacheHandler`'s `commandTimeout` default drops from 2000 to 1000 ms.
- The page handler's `get` no longer returns `age`. Next computes staleness from `lastModified` and `cacheControl`.
- A `RedisCacheHandler` created without a `redis` option reads `REDIS_URL` and runs in memory when it is unset. In 16.5 it connected to `localhost:6379`. Its `tagPrefix` option is ignored, and `defaultTTL` defaults to 366 days and applies only to entries with neither `revalidate` nor `expire`.
- `createCacheHandler`'s production warning now points at `withCache` for pages, and is skipped when the package's page handler (`RedisCacheHandler`) exists in the same process (checked on first use).
- **Sizing:** a page read now sends one `HMGET` of its tag records alongside the entry's `GET`, in the same round trip (2 commands instead of 1; 3 in 2 round trips the first time a process reads an entry it did not write). A revalidation is 1 `HSET` + 1 `ZADD` + 2 `EXPIRE`, and the `"use cache"` tag sync reads only the tags changed since the last one; nothing runs `HGETALL`. Every tag record lives in one hash per prefix (100,000 tags take about 23 MB), so tag reads all go to one key: about 2% of a core at 2,000 page reads/s, mattering around 50,000/s. See the README's Sizing section.

### Deprecated

Still exported and still working, removed on the Next 17 line. Each has JSDoc pointing at its replacement:

- `createCacheConfig`, `createCacheConfigWithProfiles` → `withCache`.
- `CompositeHandler`, `createCompositeHandler` → built in; every handler has the memory fallback.
- `MemoryCacheHandler`, `createMemoryCacheHandler` → `withCache` without `REDIS_URL`.
- The Next 14 helpers and types (`bufferToString`, `stringToBuffer`, `jsonReplacer`, `jsonReviver`, `isImplicitTag`, `calculateLifespan`, `isExpired`, `IMPLICIT_TAG_PREFIX`, `CacheHandler*`, `CacheValue`, `LifespanParameters`) → no replacement.

### Docs

- The README is rewritten around `withCache`, with migration notes from 16.5.x, from 16.5.1 `RedisCacheHandler` subclasses, and from `@fortedigital/nextjs-cache-handler` / `@neshca/cache-handler`. It also documents the outage behaviour and the key layout for operators.

## [16.5.1] - 2026-10-19

### Fixed
- **Restored the ISR `cacheHandler` exports removed in 16.5.0** (`MemoryCacheHandler`, `createMemoryCacheHandler`, `RedisCacheHandler`, `CompositeHandler`, `createCompositeHandler`, the ISR helpers and types). Removing them in a minor release broke builds that import them under a `^16.x` range. They are back unchanged, plus the fixes from #52 (Redis `SET` TTL) and #53 (nested buffers stored as base64). Next.js still supports `cacheHandler`, so they are not deprecated; their Next 16 contract gaps (`revalidateTag` doesn't invalidate ISR entries, no TTL) are being fixed separately.
- `createCacheConfig` / `createCacheConfigWithProfiles` accept `isrHandlerPath` again and emit `cacheHandler` when it is passed. In 16.5.0 a JS config that still passed it lost its ISR handler silently.
- Importing the package still doesn't require `ioredis`: the ISR `RedisCacheHandler` now loads it lazily, like the data cache factory.
- CI: the daily canary test now fails (and opens an issue) when a canary breaks; before, only `latest` could fail. The stale `rc` channel (npm still tags 15.0.0-rc.1) is dropped.
- CI: the Next.js bump workflow no longer calls the missing `redis-cli`, which marked every bump PR "Tests need review".
- CI: an open bump PR with failing checks, or a leftover bump branch with no PR, now fails the nightly run instead of being skipped silently.

### Docs
- README lists every `createCacheHandler` option, including `commandTimeout`, `defaultTTL`, `tagTTL`, `errorLogIntervalMs` and `suppressIsrWarning`.

## [16.5.0] - 2026-10-18

### Removed (BREAKING)

- **The legacy ISR `cacheHandler` (singular) implementation is gone; the package is now `"use cache"`-only.** Removed exports: `MemoryCacheHandler`, `createMemoryCacheHandler`, `RedisCacheHandler`, `CompositeHandler`, `createCompositeHandler` and their option types; the ISR helpers `calculateLifespan`, `isExpired`, `isImplicitTag`, `IMPLICIT_TAG_PREFIX`, `bufferToString`, `stringToBuffer`, `jsonReplacer`, `jsonReviver`; and the ISR types `CacheHandler`, `CacheHandlerContext`, `CacheHandlerGetMeta`, `CacheHandlerOptions`, `CacheHandlerValue`, `CacheValue`, `LifespanParameters`. These implemented a Next 14-era contract and did not work on Next 16 (`revalidateTag` got a `string[]` and was a no-op; no TTL because `context.revalidate` is never passed; `implicitTags` never arrives). See `implementation/DECISIONS.md`.
- `createCacheConfig` / `createCacheConfigWithProfiles` no longer accept `isrHandlerPath` and no longer return a `cacheHandler` key.
- **Migration:** delete `cacheHandler` from `next.config` (if it pointed at this package); keep `cacheHandlers`.
- **Warning: removing `cacheHandler` means ISR pages, route handler responses and optimized images fall back to Next's default per-instance cache. On any multi-instance deploy that is a silent regression: each instance renders and stores its own copy, and `revalidateTag`/`revalidatePath` on one instance does not clear the other instances' page caches. Users running more than one instance must bring their own shared ISR `cacheHandler` (it can coexist with this package's `cacheHandlers`; see the README).**

### Added

- One-time production warning (once per process, only when `NODE_ENV === "production"`) when `createCacheHandler` creates a Redis/Valkey/ElastiCache handler, reminding multi-instance users to configure a shared ISR `cacheHandler`. The handler cannot see `next.config`, so it warns regardless; opt out with `suppressIsrWarning: true`.
- Unit coverage for the factory's `elasticache` branch — asserts `ELASTICACHE_*` env vars (and explicit options) map to the ioredis config (host/port, TLS-on-by-default, auth-token password, connect timeout, retry) and that a missing endpoint throws.

### Changed

- Importing the package no longer loads `ioredis` at module load; it is only required (lazily) by the Redis/Valkey/ElastiCache factory paths, so memory-only users don't need it installed.
- Removed the `apps/legacy-cache-test` app; the Next.js version-bump workflows now bump `apps/redis-example` alongside `apps/e2e-test-app`.
- Docs: fixed JSDoc import paths that referenced non-exported subpaths, and the factory's documented `keyPrefix` default (`nextjs:data-cache:`).
- The `e2e-elasticache` CI job now runs against a Redis container with **in-transit TLS and an auth token** (self-signed CA trusted via `NODE_EXTRA_CA_CERTS`), instead of a plaintext container with TLS off and no auth. This validates the TLS handshake + AUTH path that real ElastiCache requires.
- The e2e test app builds its ElastiCache handler through the package's `createCacheHandler({ type: "elasticache" })` factory rather than hand-wiring ioredis, so the e2e exercises the shipped code path.

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
