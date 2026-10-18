# Decisions

## DEC-1: Drop the legacy ISR `cacheHandler`; the package is "use cache"-only (16.5.0)

**Status:** Accepted · **Date:** 2026-10-18 · **Breaking:** yes

### Context

Until 16.4.x the package shipped two families of handlers:

- **Data cache handlers** (`createCacheHandler`, `createMemoryDataCacheHandler`,
  `createRedisDataCacheHandler`) for Next's `cacheHandlers` (plural) config, which backs
  `"use cache"` / `"use cache: remote"`.
- **ISR handlers** (`MemoryCacheHandler`, `RedisCacheHandler`, `CompositeHandler`) for the
  singular `cacheHandler` config, plus ISR-only helpers (`calculateLifespan`, `isExpired`,
  `isImplicitTag`, buffer/JSON serialization helpers) and types (`CacheHandler`, `CacheValue`, ...).

A review showed the ISR handlers implemented a Next 14-era contract and were broken on Next 16:

- `revalidateTag` receives `string[]` but was handled as a single string, so it did nothing.
- `context.revalidate` is never passed, so keys were stored with no TTL.
- `implicitTags` is never passed, so path-based invalidation could not work.

Next 16's own docs (`next/dist/docs/.../next-config-js/incrementalCacheHandlerPath.md`) state the
singular `cacheHandler` is only for ISR, route handler responses and optimized images, and is
**not** used by `'use cache'`.

### Decision

Remove the ISR handlers, their helpers and types, and the `apps/legacy-cache-test` app rather than
rewrite them for the Next 16 contract. The package now exports only the data cache API and the
`createCacheConfig` / `createCacheConfigWithProfiles` next.config helpers (which no longer accept
`isrHandlerPath` or emit `cacheHandler`).

### Consequences

- Users must remove `cacheHandler` from `next.config`. ISR pages, route handler responses and
  optimized images then use Next's default per-instance cache, not Redis.
- A root import no longer pulls in `ioredis` statically; `ioredis` is only loaded (lazily, by the
  factory) for the Redis-family backends.
- If shared ISR caching is needed later, it should be a new handler written against the Next 16
  `cacheHandler` contract with its own e2e coverage, not a revival of the old code.
