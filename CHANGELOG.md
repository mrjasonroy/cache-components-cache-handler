# Changelog

All notable changes to this project will be documented in this file. This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- The ISR handlers (`RedisCacheHandler`, `MemoryCacheHandler`) now follow the
  Next.js 16 `cacheHandler` contract:
  - Page and route handler entries take their tags from the `x-next-cache-tags`
    header and their lifetime from `ctx.cacheControl`. Before, pages were stored
    without tags, so `revalidateTag` and `revalidatePath` never invalidated them,
    and their lifetime came from `defaultTTL`.
  - `get` checks the request's `ctx.softTags` and the fetch's `ctx.tags`, so
    `revalidatePath` invalidates fetch data. `meta.implicitTags` still works.
  - `revalidateTag` accepts the array of tags Next.js passes. Before, it was
    treated as one tag.
- `RedisCacheHandler` reports failed operations, and the client's reconnect
  errors, through a rate-limited logger instead of a `console.error` per call.

### Changed

- Entries are kept `expireFactor` (default 2) times their revalidate period,
  capped by Next.js's `expire`, instead of exactly their revalidate period, so
  Next.js can serve them stale while it regenerates them. `get` returns the
  stored `cacheControl`.
- `revalidateTag(tags, durations)` honors durations: tagged entries are served
  stale until `durations.expire` passes. Without durations they expire at once,
  as before.
- `RedisCacheHandler` no longer keeps a set of entry keys per tag (`SADD` on
  every write, never pruned; `SMEMBERS` and `DEL` on revalidate). `get` already
  checked each tag's revalidation time, which is all invalidation needs.
  `revalidateTag` unlinks the set an older version left for that tag; see
  docs/redis.md to remove the rest.
- A revalidation in the same millisecond as a write now invalidates it.

### Added

- `expireFactor` and `logger` options on the ISR handlers; `CacheControl`,
  `RevalidateTagDurations`, `CacheHandlerGetResult` and `CacheHandlerLogger`
  types.
- The e2e app uses `RedisCacheHandler` for ISR when `CACHE_HANDLER=redis`, and
  `isr-redis-handler.spec.ts` checks it under `next start`: revalidation from
  another process, stale-while-revalidate, and one key per entry and tag.

- Unit coverage for the factory's `elasticache` branch — asserts `ELASTICACHE_*` env vars (and explicit options) map to the ioredis config (host/port, TLS-on-by-default, auth-token password, connect timeout, retry) and that a missing endpoint throws.

### Changed

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
