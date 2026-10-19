# Decisions

## DEC-2: Restore the ISR `cacheHandler` exports; fix them rather than remove them (16.5.1)

**Status:** Accepted · **Date:** 2026-10-19 · Supersedes DEC-1's removal

DEC-1 removed the ISR handlers in 16.5.0, a minor version. The package version tracks Next.js, so
consumers use `^16.x` ranges, and public projects (e.g. templates importing `RedisCacheHandler`)
started failing to build on a fresh install. Next.js is also not dropping `cacheHandler`: it is the
current option for ISR, route handlers and (since 16.2) optimized images.

16.5.1 restores the ISR exports unchanged, and `isrHandlerPath` in the next.config helpers. They are
not deprecated. The Next 16 contract gaps DEC-1 lists remain and are tracked as a follow-up fix
(closed PR #74 has a starting point). Breaking removals only happen in a major version.


## DEC-1: Drop the legacy ISR `cacheHandler`; the package is "use cache"-only (16.5.0)

**Status:** Superseded by DEC-2 · **Date:** 2026-10-18 · **Breaking:** yes

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
