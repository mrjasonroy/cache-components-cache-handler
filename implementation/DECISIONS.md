# Decisions

## DEC-3: One cache through `withCache`; the Next 16 page handler; shared tag coordination

**Status:** Accepted · **Date:** 2026-10-19

`withCache(nextConfig)` sets `cacheHandler` (pages, route handlers, cached `fetch`),
`cacheHandlers.default` (memory values) and `cacheHandlers.remote` (Redis), plus
`cacheMaxMemorySize: 0`. All three share one Redis connection and one tag store per process.

Next 16 facts this rests on (read in next@16.4.2 `dist/`):

- The singular handler is constructed per request (`server/base-server.js`,
  `server/route-modules/route-module.js`), so all state lives in process-wide runtimes.
- Next computes staleness itself from `lastModified` and the `cacheControl` the handler returns
  (`server/lib/incremental-cache/index.js`). A tag that is stale but not expired is served by
  moving `lastModified` back past `revalidate`; an expired tag is a miss.
- Page tags, including the implicit `_N_T_` ones, arrive in the `x-next-cache-tags` header
  (`lib/constants.js`, `server/app-render/app-render.js`).
- `refreshTags` runs lazily before a `"use cache"` read only (`server/async-storage/work-store.js`,
  `server/use-cache/use-cache-wrapper.js`), after the page handler's `get`. So the page handler
  checks tags in Redis itself (below).
- Every handler gets `updateTags` and then `revalidateTag` for the same call, synchronously in one
  loop (`server/revalidation-utils.js`). Identical updates in the same synchronous run are written
  once. A later identical update is applied again, because an entry may have been cached between
  the two.
- Next ages entries on `performance.timeOrigin + performance.now()`, not `Date.now()`. A stale
  entry's `lastModified` is moved back on that clock, by `revalidate` plus a 1 s margin. For a
  `fetch`, `revalidate` is the larger of `ctx.revalidate` and the entry's own.
- `NEXT_PHASE=phase-production-build` is set before the build workers start (`build/index.js`),
  so the build phase never connects to Redis.
- `BUILD_ID` sits next to `serverDistDir`; a standalone `server.js` sets
  `__NEXT_PRIVATE_STANDALONE_CONFIG` (`build/utils.js`).

Tags follow Next's Distributed Tag Coordination. Every tag record for a prefix lives in one hash,
`<prefix>tags`: the field is the tag, the value is `"<stale>,<expired>"` in ms. Beside it,
`<prefix>tag-index` is a sorted set holding each tag once, scored by its last update. Neither
key starts with `<prefix>tags:`, the namespace where 16.5's `RedisCacheHandler` and
`createCacheHandler` keep `nextjs:tags:<tag>` keys of other types; a tag named `index` would
otherwise collide.

- `updateTags` is 1 HSET + 1 ZADD (+ the two 366-day EXPIREs), however many tags it carries.
- `refreshTags` reads the index from the last sync point (minus 5 s for clock skew), then HMGETs
  only the tags that changed. Both reads are paged at 1,000. The sync point advances to the sync's
  start, so an idle sync is one empty ZRANGEBYSCORE. A process's first sync reads every tag, paged.
- The index is trimmed only by age, so a sync can never fall off the end of it and there is no
  full-resync path. Each process prunes at most hourly, on write: up to 500 tags untouched for
  366 days, HDEL from the hash and ZREM from the index.
- Nothing ever runs HGETALL on the hash. At 100k tags HGETALL blocks Redis for about 54 ms, while
  each 1,000-tag page of the first sync takes under 1 ms.
- `getExpiration` reads only local state.

An earlier version used one hash per tag (`<prefix>tag:<tag>`) and a log trimmed to 10,000
entries. A page get then cost 1 GET + 1 HGETALL per tag (10 commands for 5 soft + 4 explicit
tags); the single hash makes it 2.

**Page reads check tags in Redis on every `get`, in the same round trip as the entry.** An
earlier design synced tags at most once a second, which let another instance serve a revalidated
page for up to 1 s. Now `get` sends the entry GET and one HMGET of the tags that apply:

- the soft tags (`revalidatePath`'s implicit `_N_T_` tags);
- the fetch tags;
- the entry's own tags, as this process last saw them.

Both are single-key commands sent together, not MGET, a pipeline or Lua, so they are safe on a
Cluster. A process reading an entry for the first time learns its tags only from the entry, so
that first read costs a second round trip (one more HMGET) for the rest.

Measured against a local Docker Redis 7 (loopback RTT ≈ 0.1 ms), with 5 soft and 4 explicit tags
and 3,000 gets per phase, 2 runs each:

| | 1 s sync | hash per tag | one hash |
|---|---|---|---|
| hit, p50 / p99 | 0.37–0.40 / 1.8 ms | 0.33 / 1.4–3.4 ms | 0.28 / 1.5–4.8 ms |
| miss, p50 / p99 | 0.29–0.30 / 1.7 ms | 0.26–0.33 / 2.0–21.8 ms | 0.25–0.28 / 1.4–2.0 ms |
| first read by another instance, p50 / p99 | 0.36–0.42 / 1.4–3.5 ms | 0.40–0.66 / 1.5–2.7 ms | 0.41–0.43 / 2.1–3.7 ms |

| Commands per get | 1 s sync | hash per tag | one hash |
|---|---|---|---|
| hit | 1 GET | 1 GET + 9 HGETALL | 1 GET + 1 HMGET |
| miss | 1 GET | 1 GET + 5 HGETALL | 1 GET + 1 HMGET |
| first read by another instance | 1 GET | 1 GET + 9 HGETALL | 1 GET + 2 HMGET |

The p99 spread is laptop noise. `scripts/bench-page-get.mjs` reproduces the numbers.

Size and cost of the tag structures, measured with `_N_T_/…`-style tags:

| tags | hash + index | HMGET of 9 fields | sync of 50 changed tags | first sync, paged | HGETALL (not used) |
|---|---|---|---|---|---|
| 10k | 2.5 MB | 0.16 ms | 0.29 ms | 7.5 ms | 5.8 ms |
| 100k | 23 MB | 0.10 ms | 0.22 ms | 76 ms in 100 pages | 54 ms, one blocking command |

**Hot key.** One shard serves every tag read. HMGET's server time is linear in the fields read
(redis-benchmark plus INFO commandstats: 0.16 µs for 1 field, 0.81 µs for 9, 4.4 µs for 50) and
does not depend on the hash's size. At 2,000 page gets/s that is 2,000 commands/s on one key:
about 2% of one core including network overhead. A Redis node handles 100k+ simple commands/s, so
this starts to matter around 50k page gets/s, or with hundreds of tags per page. Read replicas are
the remedy if it ever does.

While Redis is down, local tag state applies. It holds every tag record a `get` has read, and the
`"use cache"` handlers' `refreshTags` keeps it synced from the index. The page handler does no log
sync of its own. An immediate revalidation (`expired === stale`) counts as expired whatever the
reader's clock says, so a reader whose clock lags never serves it as stale.

A client the application passes in is never reconfigured, patched, quit or disconnected. The
package reaches it through a proxy that bounds its own commands by `commandTimeout`. After 3
timeouts in a row, the connection reports not ready for 2 s, so the handlers use the memory
fallback. A successful command after that marks it ready again.

Entries are scoped by build (`<prefix><buildId>:page:` / `:data:`). Tag records are not, so a
revalidation reaches every build that is still running. `createCacheHandler` keeps its own key
layout.

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
