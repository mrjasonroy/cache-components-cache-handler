# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

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
