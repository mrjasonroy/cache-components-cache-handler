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

- `updateTags` is 1 HSET + 1 ZADD, however many tags it carries. Neither key has a TTL.
- An update Redis did not take (an error, or Redis down) stays queued in the process and is sent
  with the next update or on reconnect. Concurrent sends share the queue: whichever runs first
  takes all of it, and one that finds it empty sends nothing (`HSET` with no field is an error). It is re-applied at send time, here and in Redis, so the
  replayed record is the newest one and can only invalidate more, never bring back an entry a
  later revalidation on another instance invalidated. Before this a revalidation made during an
  outage reached that process only, for good.
- `refreshTags` reads the index from the last sync point (minus 5 s for clock skew), then HMGETs
  only the tags that changed. Both reads are paged at 1,000. The sync point advances to the sync's
  own start, and only once the whole range has been read, so an idle sync is one empty
  ZRANGEBYSCORE and a failed one is retried whole. A process's first sync reads every tag, paged.
- Pages are walked by score, not by `LIMIT` offset. Offsets broke when a tag on an already-read
  page was revalidated mid-sync: it moved to the end, every later tag shifted down one rank, and
  the next offset skipped one tag for good (its score was behind the next sync point). With a
  score cursor a revalidated tag only moves up, so it is read again, and nothing else moves. Each
  page restarts at the previous page's last score, inclusive, and fetches only the tags below it,
  so a run of equal scores split across pages is read whole. A full page of one score (an update
  of over 1,000 tags) is read with one unbounded `ZRANGEBYSCORE s s`, then stepped past with an
  exclusive `(s`. This is a keyset cursor on the score alone, not on (score, member): a member
  bound inside one score is not expressible in a single `ZRANGEBYSCORE` without Lua or rank
  offsets, and the only ties are tags written by one update, which are read whole.
- The sync point is the reader's own start time, never the highest score read: a writer whose
  clock runs ahead would otherwise move it past a lagging writer's updates.

**No pruning: tag records live until a flush.** A record matters while an entry created before
its `stale` or `expired` time can still be stored: `check` expires an entry created before
`expired`, including one cached after the revalidation (16.5.1 semantics, Next's own). With
`revalidateTag(tag, "max")` (`expire` = 365 days) a record is still needed 365 days after the
revalidation plus the longest entry age, and with a larger custom `expire` longer still. An
earlier round pruned at 366 and then 731 days, which needed a clamp on `expired`, a margin for
clock skew and per-key Lua compare-and-delete scripts so a prune could not delete a tag another
instance was revalidating at that moment. Each was a correctness hazard on its own (a pruned
record reads as never-invalidated and brings stale entries back). Not pruning removes all of it.

What it costs: a record exists only for a tag that was revalidated at least once (soft `_N_T_`
tags included, via `revalidatePath`), so growth is the number of distinct tags ever revalidated,
bounded by the number of entities and paths, not by traffic. At about 230 B per tag (hash field
plus index member):

| distinct new tags revalidated per day | after 1 year | after 3 years |
|---|---|---|
| 100 | 8 MB | 25 MB |
| 1,000 | 84 MB | 250 MB |
| 10,000 | 840 MB | 2.5 GB |

A site revalidating by entity id (`product:<id>`) tops out at its catalogue size: 100k products
is 23 MB. The other cost is a process's first sync, which reads the whole index: about 76 ms per
100k tags, in 1,000-tag pages, never blocking Redis. Incremental syncs and page reads do not
depend on the hash's size.

The operational answer to a large hash is `flushCache({ scope: "all" })`, which drops the tags
with the entries they invalidate, so nothing stale can come back. There is no automatic or
manual prune. One could be added later as an explicit `pruneTags({ olderThan })`, documented as
unsafe below the longest `expire` any revalidation used plus the longest entry age.

Because the tag keys have no TTL, Redis must not evict them: run it with `noeviction` or a
`volatile-*` policy (every entry key has a TTL). Under `allkeys-*` an evicted `<prefix>tags`
brings every invalidated entry back.

**Entry age.** `MAX_ENTRY_AGE_SECONDS` (365 days, `cacheLife("max")`'s `expire`, in
`shared/keys.ts`) bounds memory, not tag retention. Every store caps an entry's age at it on write
(Redis TTLs, the page and data memory stores, the `"use cache"` LRU, the outage fallback, the page
handler's `defaultTTL`) and checks `timestamp`/`lastModified` against it on read, so an entry
written by an older version or with a longer TTL is not served either. Before this the
`"use cache"` handler kept values until `timestamp + revalidate` with no cap.

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

**An unchecked tag is a miss, never a hit.** A tag read or sync that fails or is skipped must
not let an invalidated entry through:

- The page handler and `"use cache: remote"` read the tag records in the same round trip as the
  entry (the entry's own tags as last seen, plus the soft tags), and any error on that read is a
  miss. Before this the remote handler checked only local tag state, so a revalidation on another
  instance was invisible until this process happened to sync.
- `"use cache"` (local) values are checked against local tag state, which is only as good as the
  last sync. `TagStore.isSynced()` is false with Redis configured until a sync completes, and
  again after every reconnect and every failed sync; while it is false, `get` misses. A sync
  skipped because Redis was not ready does not count against the 1 s interval. Without Redis
  (memory-only mode) local state is authoritative and always synced.
- While Redis is down the page and remote handlers serve from the memory fallback, whose entries
  are dropped on reconnect. An immediate revalidation (`expired === stale`) counts as expired
  whatever the reader's clock says, so a reader whose clock lags never serves it as stale.

**Prerendered build output is served through Next's own `FileSystemCache`.** `next build` writes
prerendered pages and route handler responses (`APP_PAGE`, `APP_ROUTE`, `PAGES`) to
`<distDir>/server` only, and a custom `cacheHandler` replaces `FileSystemCache` with no disk
fallback. So every prerendered route missed on its first request and rendered again at runtime:
sitemaps and robots came back "runtime", not "buildtime", and Next's cache-components deploy suite
failed on it. On a miss for those kinds the page handler now reads the build output through
`FileSystemCache`, constructed from the `fs` and `serverDistDir` Next passes to the handler with
`flushToDisk: false` and no memory cache, so the file layout is always the running Next's own and
nothing is written to disk. The entry keeps `lastModified` = the build time and goes through the
same tag check as any other, so a tag or path revalidated since the build wins. With Redis it is
served only after its tag records were read from Redis (while Redis is down, a process that just
started knows no revalidation, so the build output is a miss), and once it passes the check it is
written to Redis with `SET NX` so an entry another instance or a render wrote first wins. Without
Redis it is kept in process memory. The Redis key is build-scoped like every other entry. The build
writes no `cacheControl` to `.meta`, so a build-output entry revalidated with `{ expire }` is a miss
rather than served stale; Next takes its schedule from the prerender manifest as it does for its own
`FileSystemCache`.

**The handlers load on the edge runtime and do nothing there.** Next bundles the page
`cacheHandler` into the edge middleware too (`OPTIONAL_IMPORT:incrementalCacheHandler`,
next/dist/build/templates/middleware.js). On the edge runtime `node:module`, `node:fs` and
`node:path` are stubs whose exports throw when called (`__import_unsupported`,
next/dist/server/web/globals.js), and `connection.ts` called `createRequire(import.meta.url)` while
it was evaluated, so the middleware threw and every request was a 500. Now nothing touches a Node
built-in at import: `require` is created on first use (`shared/node-require.ts`), and `build-id.ts`
loads `node:fs`/`node:path` when it first reads `BUILD_ID` (`process.getBuiltinModule` where Node
has it). Under `NEXT_RUNTIME=edge` the page handler's `get` returns `null` and `set`,
`revalidateTag` and `delete` do nothing; the data handlers are the miss handler; Redis is never
used.

A client the application passes in is never reconfigured, patched, quit or disconnected. The
package reaches it through a proxy that bounds its own commands by `commandTimeout`. After 3
timeouts in a row, the connection reports not ready for 2 s, so the handlers use the memory
fallback. A successful command after that marks it ready again. A reply that arrives after its own
timeout fired is ignored: it neither resets the count nor marks the connection ready, so a server
answering every command in 1.5 s against a 1 s timeout is still dropped.

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
