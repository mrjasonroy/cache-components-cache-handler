# Decisions

> **Version numbers.** 16.5.0 and 16.5.1 were published by mistake, ahead of Next.js, and
> withdrawn; their changes and the release these records call 16.6.0 ship together as 16.4.3. Where
> a record below names "16.5" as the version users upgrade from, read 16.4.2: its key layout,
> `createCacheHandler` storage and `RedisCacheHandler` constructor are the same. "The 16.5 stack"
> or "the 16.5 path" is the legacy `createCacheHandler` data stack and the `redis: RedisOptions`
> form. The headings of DEC-1 and DEC-2 keep the numbers those releases had.

## DEC-9: A fixed in-process memory budget (16.4.3)

**Problem.** A consumer's pods (605 MB container limit) ran out of memory. The in-process stores
added up to about 336 MiB per runtime: `local` 10,000 entries / 50 MiB, `page` and `pageFallback`
64 MiB each, `data` and `dataFallback` 50 MiB each, `entryTags` "8 MiB" counted in tags. Local tag
records were never pruned, and the deprecated handlers' tag maps were unbounded.

**What fills when.** With Redis healthy only `local` (every `"use cache"` value) and `entryTags`
fill; `page` and `data` hold only `MEMORY_ONLY_TAG` entries. Without Redis, `page` and `data`
hold everything and `entryTags` is unused. `pageFallback` and `dataFallback` fill only while
Redis is down, at most 60 s per entry, and are emptied on reconnect.

**Decision.** Smaller fixed caps, no new option or environment variable (the maintainer's rule):
`local` 32 MiB / 10,000 entries, `page`, `data` and both fallbacks 16 MiB each, `entryTags` 2 MiB.
That is 34 MiB with Redis healthy, 64 MiB without Redis and 98 MiB at most during an outage. The
caps live in one table, `MEMORY_STORE_CAPS` in `shared/runtime.ts`, and a test fails if their
sum reaches 100 MiB. Sizes are bytes: `entryTags` now counts each tag's characters, and every
store counts keys, since a `"use cache"` key carries the function's encoded arguments. The page
store no longer has to fit the codec's 64 MiB entry cap: a page larger than 16 MiB is not kept in
memory, which only matters without Redis, where it is rendered again. We kept the six stores
rather than merging them: merging `page` with `pageFallback` would need per-entry outage marks to
empty only the outage copies on reconnect, for no saving in the worst case.

**Tag records.** A local record follows the Redis horizon of DEC-8: it is dropped once
`max(stale, expired) + TAG_RETENTION_MS` has passed, flush barriers never, and a record with an
update Redis has not taken is kept. Dropping it is safe: any entry it could affect is past the
365-day age bound every handler enforces on read. A sync or read skips such records, so the first
sync over a Cluster that cannot prune does not load years of records. The walk over all records
runs at most once a minute, on an update or a sync, with no timer, so it covers memory-only mode
too. This is a time bound, not a count bound: an app that revalidates many distinct tags holds
about 150 bytes per tag revalidated in the last year (measured), in step with the Redis hash. A
count cap is not safe here, since a dropped record that is still in effect would let the local
handler serve an invalidated value.

**Legacy maps.** `createMemoryDataCacheHandler`'s module-level manifest and
`MemoryCacheHandler.revalidatedTags` keep at most 10,000 tags. Past that the least recently
updated half is dropped. `MemoryCacheHandler` keeps one floor, the latest dropped revalidation
time (always in the past); entries last modified before it miss.

The data handler keeps three floors, because a record's `expired` can lie in the future (a
`revalidateTag(tag, "max")` sets it a year ahead). One floor collapsing `stale` and `expired`
would move into the future and make every entry, new ones included, miss until then. So: the
latest dropped `stale` (older entries are served stale, `revalidate: -1`); the latest dropped
`expired` that had already passed (older entries miss); and the latest dropped `expired` still
ahead, which misses older entries only once it has passed, as a kept record would. New entries are
never affected by a pending floor. `getExpiration` reports, for a tag it has no record of, the
latest dropped `expired` that has passed (0 if none): a lower bound, so a soft or implicit tag
checked outside this handler still sees a dropped revalidation, never a future time.

Approximation: pending expiries collapse to their maximum, so an earlier dropped one takes effect
only when the latest passes. Until then the entries it covers are still served stale (their
`stale` time is in the stale floor) unless they were created between its `stale` and `expired`
times. Records whose `expired` has already passed are dropped first to keep this rare. This is
the deprecated stack; an exact list of pending deadlines would itself be unbounded.

**`cacheMaxMemorySize`.** It sizes the memory LRU of Next's `FileSystemCache` (unused when
`cacheHandler` is set) and Next's built-in `"use cache"` handler (replaced by `cacheHandlers`; in
production `0` makes it a no-op). With `withCache` it therefore has no effect. `withCache` still
sets 0, which is harmless, and its warning for another value now says it has no effect.

## DEC-8: Bound tag retention; use server field expiry and a standalone fallback (16.4.3-rc.1)

**Entry lifetime.** The page, remote and local handlers share `MAX_ENTRY_AGE_SECONDS` = 365
days. Page `lifetimeOf` caps `1.5 × revalidate`, `expire`, and the default (including
`revalidate: false`). Page reads also reject `lastModified` older than that bound. The remote
handler caps finite `cacheLife.expire`, substitutes its bounded `defaultTTL` for infinite
expire, caps Redis EX on write, and checks age on read. Memory-only remote entries and the
local handler's `timestamp + revalidate` are capped too. Outage memory lasts at most 60 seconds.
Thus stale-while-revalidate never extends a stored value beyond 365 days. Legacy
`createCacheHandler` uses separate per-tag keys with its own `tagTTL`; it does not read this hash.

**Record horizon.** An immediate invalidation matters until `stale + 365 days`. A delayed
invalidation can expire an entry created *after* the update but before its future `expired`
deadline (Next's semantics, DEC-3). Its horizon is therefore `max(stale, expired) + 365 days`,
not just its index score plus the entry age. Add 10 seconds, two instances' 5-second clock-skew
windows. Custom revalidation durations are preserved, including durations longer than a year;
no new public duration cap is needed. A `"max"` revalidation retains its record about two years.

**Native field expiry.** Background maintenance probes `COMMAND INFO HPEXPIREAT` once per
connection, promptly on startup/ready and shared on `globalThis` across handler module graphs.
It does not parse server versions: Redis 7.4+ and Valkey 9+ support it. A failed probe selects the fallback. While support is
unknown, the guarded one-key monotonic writer already merges the record and attempts `HPEXPIREAT` in
that same script. An older writer cannot shorten the merged horizon. Every HSET clears a field
TTL, so even a losing older update reinstates it. A server or ACL change that rejects expiry
leaves the merged record intact and disables native expiry; standalone maintenance still
covers it. A transient probe failure can be retried once on the next connection-ready event. Records written by an older package need the fallback or a subsequent
write to gain a field TTL. No request issues an extra command.

**Fallback.** Once per minute an unreferenced timer examines at most 1,000 old index members.
One atomic two-key Lua script selects by score, checks the actual hash record's horizon, and
HDELs and ZREMs eligible records. It retains malformed records conservatively and removes
orphan index members whose fields expired. An offset walks past permanent barriers and long
future deadlines; deletions by another process may postpone a candidate until the next pass,
which affects cleanup speed only. A tag updated before the script is protected by either its
new index score or its new hash timestamps (the writer sends those commands separately).
An update after the script recreates its record and index. There is no stale read followed by
an unconditional deletion outside the script. Many instances may safely run it concurrently.
`closeCache` clears the timers. Scripts use EVALSHA, falling back to EVAL on NOSCRIPT. Debug
logging reports removed records and both structure sizes from the script's existing return value, with no extra command.

**Cluster limitation.** Existing hash and index names need not share a slot. No key migration
or split-script deletion is introduced. Known Clusters skip fallback pruning; CROSSSLOT also
disables it. Without native field TTLs, records grow until a full flush and a warning is
rate-limited (hourly by default). With native TTLs, expired fields leave harmless index members: their HMGET is
empty only after every entry they could invalidate has aged out. The index and any fields
written by older packages remain until a full flush or a later update. This trades
bounded hash fields for retaining the existing Cluster layout and correctness.

**Build output and barriers.** Global and build-scoped flush barriers stay permanently: live
processes and disk output may depend on them. The build stamp is one file for the entire build,
written before static generation, so routes need not individually visit the handler to be
stamped. Existing missing-stamp behavior stays: an unstamped non-time-based page may use the
read time, since its actual age cannot be known. Build output with no surviving stamp can come
back after its tag record is pruned. This only happens to a deployment serving the same build
for over 365 days after the tag's last invalidation. Mitigation: redeploy or flush within a year.
The normal 365-day bound therefore applies to stored values and stamped disk output, with this
explicit exception for unstamped disk output. Standalone packaging may omit the root stamp;
we do not patch Next's trace manifests or write into its app directory to preserve it.

The previous DEC-3 no-pruning choice below is superseded by this retention policy.

## DEC-7: A logger hook: `setCacheLogger` and a `logger` option (architecture review L4)

Approved by Jason on 2026-10-20. His app logs through its own logger, and the package wrote 23
lines straight to the console.

- **Shape.** `CacheLogger { error; warn; info?; debug? }`, each `(message, meta?)`: winston and
  `console` fit as they are; pino and bunyan take the fields first, so they need a one-line
  adapter (README, Logging). `message` is the line the console printed before; `meta`
  holds the details (`error`, `operation`, a debug line's `args`). A logger without `info` or
  `debug` drops those lines rather than sending them to the console.
- **Two ways to set it, because `withCache` cannot carry one.** `withCache` points Next at handler
  files by path, and the built-in files configure themselves from the environment, so a function
  cannot reach them. `setCacheLogger(logger)` sets it for the process, on `globalThis` (DEC-5) so
  every module graph sees it, from `instrumentation.ts` or a handler file. `logger` on
  `CacheOptions` serves custom handler files, where options are passed in process
  (`createRemoteCacheHandler`, `createLocalCacheHandler`, `RedisCacheHandler` /
  `createRedisCacheHandler`; `flushCache` takes it too). Precedence: the option, then the process
  logger, then the console, decided for each line, so a logger set after the handlers were
  created still applies. The connection and tag state are shared by every handler of a
  connection and key prefix (DEC-3, DEC-6); they log through the logger of the handler that opened them,
  then the process logger. Keying them by logger as well would split the shared client, which is
  what DEC-3 and DEC-6 avoid.
- **The default is unchanged.** Without a logger, every line reaches `console.<level>` with the
  same arguments as before (`shared/logger.ts` `writeLog`'s `consoleArgs`). The three rate-limited
  reporters (connection, runtime, tag store) and their `[RedisCache]:`-style prefixes are kept;
  they only change where a line goes. The deprecated 16.5 stack has no `logger` option and uses
  the process logger.
- **A logger that throws never fails a cache call.** The line goes to the console, and the console
  says once per process that the logger threw.
- **No secrets.** Lines never carried the URL or the options (the split-connection warning names
  neither); the logger gets the same lines and `meta` holds only errors, operations and debug
  arguments (keys, tags, sizes). `src/shared/logger.test.ts` asserts that a URL password and a
  `redisOptions.password` appear in no line or meta.

## DEC-6: Public API from the architecture review: `closeCache`, tuning on `CacheOptions`, the 16.5 data stack deprecated, remote `defaultTTL`

**Status:** approved by Jason on 2026-10-20 (architecture review H1, M1, M3, M4).

- **H1, `closeCache(): Promise<void>`**, exported from the package root next to `flushCache`. It
  closes every Redis connection the package opened, empties the memory stores and drops the
  runtimes (tag stores). Idempotent. The first call starts at once; a call made while one runs
  starts its own close after it (Opus merge-gate L1), so a connection a cache call opened during
  the first close is closed too, and a later call finds nothing open. A close detaches the pooled
  connections before it awaits anything, so a cache call during it gets a new connection rather
  than one about to be quit. A `client` the application passed in is never closed. Handlers reconnect lazily:
  the remote, local and page handlers resolve their runtime on every call
  (`liveCacheRuntime`), and a runtime that `closeCache` marked `closed` is looked up again in the
  registry, which opens one new connection and one tag store shared by every handler with the same
  settings. The registry key stays `<connection id>|<keyPrefix>`: the ids are global (DEC-5), and
  `closeCache` empties the registry, so a stale id is never reused. `RedisCacheHandler#close()`
  is deprecated and calls `closeCache()`.
  **Pending invalidations survive a close** (Codex merge-gate M1). An invalidation or flush
  barrier Redis refused (READONLY during a failover, an outage) lives only in local tag state
  (the records and the `unsent` queue), so dropping that state lost it: a handler reused after the
  close served the invalidated entries again. `closeCache` waits for the batches in flight and,
  if Redis is ready, sends the queue once more (`TagStore.drain`), and only then closes the
  connections. What Redis still has not taken stays in this process for the next runtime of the
  same connection and key prefix, which keeps applying it locally, with the times it was made,
  and sends it on creation, syncs and reconnects, like any unsent update. A replayed update is
  stamped when it is sent, as every replay after an outage is (see `TagStore.send`), so it can only
  invalidate more. `closeCache` never rejects for Redis: a test or script can always close and
  exit, and what Redis did not take survives only for reuse in the same process.
  **One tag state per key, and closed stores forward** (Codex merge-gates M2 to M4,
  `shared/tag-states.ts`). The first designs handed a closed store's maps over through a global
  slot, to be adopted, released and republished; each review found another ordering of close,
  late update, failed send and new runtime that lost an invalidation (a closed store's late
  update landing in maps no runtime would read, a newer store's close overwriting them) or kept
  acknowledged history forever. The design now leaves no such ordering:
  - A process-wide registry on `globalThis` (DEC-5) holds at most one tag state (`KeyTagState`:
    records and `unsent`) per key: the pool key plus key prefix for a connection of the package's
    own, and for an application client the client object, in a `WeakMap`, then the prefix. The
    key is the same for the connection that replaces a closed one. A new runtime's tag store uses
    the state of its key, creating it if there is none, and becomes its owner.
  - A closed tag store never writes to its own state. `update()` (revalidations and flush barriers
    alike) goes to the live tag store of its key, `getCacheRuntime` for the same options, created
    if need be. A send that was in flight at the close and fails is requeued, with its records,
    into whatever state the key has at that moment, looked up again, never a captured map.
    (`closeCache` waits for every send in flight before it releases a state, so through it that
    lookup finds the store's own state; the rule makes it hold whatever the timing.)
  - After the drain, `closeCache` drops each runtime's state if that runtime still owns it and
    nothing in it is unsent, and keeps it otherwise. A kept state keeps its records, so the
    invalidations go on applying locally; the next runtime of the key takes it over. A dropped
    state drops its records: nothing Redis acknowledged outlives a close. A runtime created
    mid-close owns the state, so it is not dropped.
  What can remain after a close is states holding invalidations Redis has not taken: bounded by
  distinct option sets times prefixes for the package's connections, and gone with the client for
  an application client. Pending invalidations are never dropped to impose a limit. A forwarded
  late update opens the key's runtime, and its connection, again; the next `closeCache` closes it.
  A state kept with no runtime of its key is sent once a runtime of that key exists.
  A seeded random test (`close-cache-random.test.ts`) runs 1,000 sequences of 30 steps: runtimes,
  updates (immediate or with durations) on live and closed runtimes, flushes, closes awaited and
  overlapping, syncs, Redis going down and coming back, entry writes and reads, and Redis refusing
  or holding the tag record write (`EVALSHA`) and the tag index write (`ZADD`) separately. A
  controlled clock moves before every revalidation, so one revalidation's acknowledgement never
  stands for another's. After every step each invalidation is in Redis (hash and index) or visible
  to its key's live runtime (or kept state), and no read serves an entry a later invalidation made
  stale as fresh; at the end all are in Redis, no state remains and no connection of the package's
  own is open. A failed send requeueing into the store's own state instead of the key's current
  one is caught only by `tag-store.test.ts`: through `closeCache` the two are the same object
  whenever a send is in flight, because a state is released only after the drain has awaited its
  sends, and a closed store forwards updates and never starts a send.
  A connection fans its `ready` event out to its subscribers from one client listener, so an
  application client shared by many prefixes, or closed and reopened, keeps one listener.
  Not covered: the deprecated `createCacheHandler` captures its connection when it is created, so
  after `closeCache` it serves from its memory fallback until it is created again. Reworking the
  16.5 stack to re-resolve was judged not worth it for a deprecated API.
- **M1:** `connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts` move from the internal
  `RuntimeOptions` to `CacheOptions`, so every factory and `flushCache` take them. Supersedes the
  "16.5 path only" scope in DEC-4. The split-connection warning from the review's first batch
  stays: different tuning for one server still opens a second connection.
- **M3:** `createCacheHandler`, `createRedisDataCacheHandler`, `createMemoryDataCacheHandler` and
  `createIoredisAdapter` are `@deprecated`, each pointing at its replacement. No behaviour change.
  They keep working in 16.x and are removed, or become a shim, on the Next 17 line.
- **M4:** `RemoteCacheHandlerOptions.defaultTTL` (seconds) sets how long an entry with an infinite
  `expire` is kept. The default stays 24 hours, and the 365-day cap applies.

## DEC-5: State on `globalThis` or in the module (architecture review L5, M2)

Next can load the package into more than one module graph in one process (the server bundle,
the `cacheHandlers` entries, an instrumentation file). The rule:

- **On `globalThis`** (under a `Symbol.for("@mrjasonroy/cache-components-cache-handler/…")` key)
  when every graph must see the same object: the Redis connections and application-client
  connections (`shared/connection.ts`), the runtimes and the ids that key them
  (`shared/runtime.ts`), the tag state of each connection and key prefix (`shared/tag-states.ts`), the memory store registry (`shared/memory-store.ts`), the build-id state
  (`shared/build-id.ts`), the page-handler flag (`data-cache/isr-warning.ts`) and the cache
  logger (`shared/logger.ts`, DEC-7).
- **In the module** when a copy per graph is harmless: the clock offset and its module storage
  lookup (`shared/clock.ts`; a second graph measures the same offset), the build info and build
  output readers (`handlers/build-info.ts`, `handlers/build-output.ts`; re-reading a manifest is
  cheap), `require` caches (`shared/node-require.ts`), and once-per-graph warnings (the ISR
  warning's `warned`, the split-tuning warning in `connection.ts`), which may then print once per
  graph.
- **Anything that names, counts or keys global state is global too.** M2 broke this: the runtime
  registry was global, but the ids in its keys came from a module-level counter and `WeakMap`. A
  second graph numbered the shared connections from 1 again, so with two connections it could get
  the runtime of the other connection, and its tag store, with nothing logged. The ids now live on
  `globalThis` beside the registry (`shared/runtime-graphs.test.ts` loads `runtime.ts` twice).

## DEC-4: Compression on by default; connection tuning on the 16.5 path

**Status:** Compression approved by Jason on 2026-10-20 (on by default, 16 KB threshold, Brotli
quality 4); connection tuning superseded by DEC-6 · **Date:** 2026-10-19

### Compression

Entries of 16 KB and more (encoded v2 size) are stored Brotli-compressed, on by default. This
started as a PM default; Jason decided on 2026-10-20 to ship it on by default with this threshold
and quality (Opus final review L2: the 16.4.3 CHANGELOG entry, then numbered 16.6.0, no longer calls it provisional).
`CACHE_COMPRESSION=off` (also `0`, `false`, `no`) turns it off, resolved in `shared/env.ts` like
`CACHE_DEBUG`. There is no `withCache` option and no new public API.

- **Format v3 = a compressed v2 entry** (`shared/codec.ts`): `NCH` · version `3` · codec byte
  (`1` = Brotli; `2` reserved for zstd) · the v2 length (uint32 BE) · the compressed v2 bytes. The
  v2 layout, including the `/_full` dedup, is unchanged and compressed whole.
- `encodeStored`/`decodeStored` are async and use zlib's async `brotliCompress`/`brotliDecompress`
  (libuv threadpool), loaded through `process.getBuiltinModule`, so the handler entries stay
  edge-safe. The synchronous `encodeEntry`/`decodeEntry` are unchanged; `decodeEntry` reads a v3
  entry as a miss.
- Decoding reads v2 and v3. A truncated or corrupt payload, an unknown codec byte, a length that
  does not match the stated one (`maxOutputLength` caps the inflation), or a payload that is not a
  v2 entry is a miss, never a throw.
- An entry is written as v2 when compressing would not shrink it (already-compressed bytes).
- 16.4.2 does not read these keys at all (its layout is different). A v2-only build of this
  release (never published) sees version 3 and misses; entries are build-scoped, so mixed fleets
  rarely share keys.

Numbers (drafts/gn16-18-large-values.md; generated listing pages, Node 26, Redis 7 in Docker):

| Entry | v2 | Brotli-4 | Compress / decompress |
|---|---|---|---|
| DS-shaped APP_PAGE (~190 KB of parts) | 140 KB | 14 KB (study), 10.5 KB (unit test shape) | 0.37 / 0.10 ms |
| "5 MB" search page (5 MB RSC, HTML ~2x) | 16 MB | 1.0 MB | ~28 / ~6 ms |
| 5 MB remote listing (integration test) | 5.0 MB | 93 KB | set 15 ms, get 6 ms end to end |
| 12 real e2e pages (13-25 KB) | | 5.9x smaller | |

Brotli-4 was chosen over gzip (slower and larger), brotli-11 (10 s per 5 MB) and zstd (2x cheaper
at the same ratio, but needs Node 22.15+ and is experimental there; the codec byte leaves room for
it). On real output expect 5 to 12x. It is a memory and bandwidth decision at DS sizes, and removes
the 1 s `commandTimeout` risk for multi-MB pages on slow links (16 MB takes ~1.6 s at 100 Mbps,
1 MB ~100 ms).

Wired into `"use cache: remote"` (`data-cache/remote.ts`) and the page handler
(`handlers/redis.ts`). `CACHE_DEBUG` logs `bytes` and `encodedBytes` (the stored, compressed size).

### Connection tuning (ISSUE-3)

`connectTimeout`, `socketTimeout` and `maxConsecutiveTimeouts` are honoured on the 16.5 path
only: `createCacheHandler` options, and `RedisCacheHandler` / `createRedisCacheHandler` options
including the `redis: RedisOptions` form, through `RuntimeOptions` → `resolveConnection` →
`shared/connection.ts`. With a `client`, only `maxConsecutiveTimeouts` applies (the client's own
options are never changed). `withCache` stays environment-only: there is no environment variable for them.
Superseded in part by DEC-6: the options are now on `CacheOptions`, so every factory takes them.

Connections are shared per distinct option set, tuning included. A page handler given
`connectTimeout: 5000` next to a data handler left on the defaults therefore opens two clients to
the same server, each with its own tag store. Both stay correct, because each reads the Redis tag
records with its entries, but the process makes twice the connections and syncs. Give every
handler the same tuning to keep one connection.

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
- **The handlers never read the time through `Date`; they use `nowMs()` (`shared/clock.ts`).**
  With cacheComponents, Next extends `Date` (`server/node-environment-extensions/date.js`) so that
  `Date.now()`, `new Date()` and `Date()` during a prerender count as IO and abort it. Next calls
  the handlers inside the prerender's async context (`use-cache/use-cache-wrapper.js`
  `saveToCacheHandler`), so a handler reading `Date.now()` aborted it, silently: a route handler
  with two sequential `"use cache"` calls was built as dynamic (ISSUE-4). Next's own handlers read
  `performance.timeOrigin + performance.now()` (`lib/cache-handlers/default.js`), but only ever
  compare times within one process. Ours are compared across instances through Redis (tag
  records, flush barriers, stored entries), and the performance clock is monotonic: it drifts
  from wall time (NTP slewing, a suspended VM, days of uptime), so two pods could disagree by
  seconds about whether a revalidation came after an entry. So `nowMs()` stays wall time without
  reading `Date` in a prerender: it is the performance clock plus `offset = Date.now() −
  performance clock`, re-measured on every call where reading `Date` is safe and reused where it
  is not. Safe means no work unit, or one for which Next's `io()` does nothing, read from Next's
  work unit storage: the one Next registers on `globalThis` under
  `Symbol.for("@next/work-unit-async-storage@<version>")` (16.4+), else the `.external` module
  as resolved from this package, but only if the process has already loaded it (earlier 16.x).
  It is never loaded from here: before Next's baseline has put `AsyncLocalStorage` on
  `globalThis` (a custom server calling `flushCache()` before `app.prepare()`), loading it makes
  Next create the storage as a stand-in whose `run` throws, for the life of the process, and a
  copy of `next` other than the running one would hold a storage Next never uses (Fable review
  5). Nothing is imported, so the edge-safe import graph is unchanged; on the edge runtime `Date`
  is never read. If neither finds it, `Date` counts as safe only while it is not extended (the
  native constructor, `Date.now` not Next's bound wrapper), so a lookup failure fails closed
  (Codex review 5). Any other library that replaces `Date` (fake timers, APM agents) makes it fail
  closed the same way: the process stays on the performance clock (ISSUE-4, README). The global symbols are scanned on every call (under a microsecond), not
  cached, so a Next version that registers later in the process is still consulted; and every
  storage found must be safe, since with several Next versions in one process any of them can be
  prerendering (Codex review 6). Only the module lookup's find is cached; a failed one is retried
  after 1 s, so a call before Next has loaded decides nothing for good. Design (b), re-anchoring, was chosen over (a), the performance clock only where a prerender can reach,
  because every handler call can be reached from a prerender, so (a) would leave every stored
  time on the drifting clock. A pod that never gets a safe call keeps its last offset (0 before
  any: the performance clock, as before). Rounded to whole ms, stored in Redis as integers.
- **Next's own timestamps are converted at the boundary.** Next stamps a `"use cache"` entry's
  `timestamp` with its performance clock, compares `getExpiration`'s result with it, and ages
  page entries by comparing `lastModified` with that clock. The handlers convert with
  `fromNextClock` on the way in (`stored-entry.ts` `readPendingEntry`, the Redis data cache's
  serialize and TTL) and `toNextClock` on the way out (returned entries, `getExpiration`, the
  page and ISR memory handlers' `lastModified`), so every stored time is wall time and each pod
  converts with its own offset. The two conversions use a whole-ms offset that moves only when
  the measured offset has drifted by more than 1 ms, so a time converted to Next's clock and back
  is the same millisecond: `Date.now()` is whole ms, so the measured offset's fraction changes
  from call to call, and a fractional offset rounded twice, or re-measured between the two
  conversions, brought a time back 1 ms off (`clock.test.ts` failed on and off). It costs up to
  1.5 ms between the conversions and `nowMs()`, well inside the 5 s skew allowance. Without the conversion a comparison between a writer's
  `entry.timestamp` and another pod's tag record was off by the writer's drift; with it only
  wall-clock skew between pods remains, which the clock-skew limit in ISSUE-2 covers.
  `createMemoryDataCacheHandler` is in-process only and stays on Next's clock (`nextClockMs()`).
- A static test (`shared/clock.test.ts`) fails on any `Date` read outside `clock.ts`, tests and
  `testing/`. `data-cache/cross-pod-clock.test.ts` runs two instances (separate module graphs,
  shared Redis) whose performance clocks are 5 s off wall time in opposite directions. Tests fake
  the time with `vi.setSystemTime`: the Vitest setup points every clock at `Date.now()`
  (`testing/clock-setup.ts`).
- `NEXT_PHASE=phase-production-build` is set before the build workers start (`build/index.js`),
  so the build phase never connects to Redis.
- `BUILD_ID` sits next to `serverDistDir`; a standalone `server.js` sets
  `__NEXT_PRIVATE_STANDALONE_CONFIG` (`build/utils.js`).

Tags follow Next's Distributed Tag Coordination. Every tag record for a prefix lives in one hash,
`<prefix>tags`: the field is the tag, the value is `"<stale>,<expired>"` in ms. Beside it,
`<prefix>tag-index` is a sorted set holding each tag once, scored by its last update. Neither
key starts with `<prefix>tags:`, the namespace where 16.4.2's `RedisCacheHandler` and
`createCacheHandler` keep `nextjs:tags:<tag>` keys of other types; a tag named `index` would
otherwise collide.

The old (16.4.2, and withdrawn 16.5.x) page and data handlers' tag keys are neither read nor
written, so during a rolling deploy from 16.4.2 a revalidation handled by a 16.4.2 instance does
not reach 16.4.3 instances (and the reverse), and an entry they cached can stay stale for up to its
`expire` (Opus final review M1). This is documented as an upgrade step (recreate deploy, or one
`revalidatePath("/", "layout")` from 16.4.3 once the last 16.4.2 instance is gone; `flushCache` empties only the caller's memory)
rather than handled with a compatibility shim: reading the old per-tag keys would cost a `GET` per
tag on every read forever after, to cover a window of minutes that happens once.

- `updateTags` is 1 EVALSHA + 1 `ZADD GT`, however many tags it carries (EVAL instead when the
  server answers NOSCRIPT). Neither key has a TTL.
- **Writes are monotonic.** A plain HSET of the whole record let an older write that reached
  Redis late (delayed on its connection, not failed) replace a newer acknowledged one: A
  revalidates at T, an entry is cached at T+1, B revalidates at T+2 and is acknowledged, A's HSET
  lands and restores `T,T`, and an instance started afterwards serves the T+1 entry. Local merges
  and the replay queue cannot repair Redis. So the record is merged by a script
  (`shared/tag-update.ts`), ordered by `stale` (the update time): a newer update applies as before;
  an older one leaves the record, filling only a missing `expired`; in the same millisecond
  `stale` stays and the earlier `expired` wins. A plain maximum of `expired` was rejected:
  `revalidateTag(tag, "max")` then an immediate `revalidateTag(tag)` must expire at once, not in a
  year. The index uses `ZADD GT`, so its score never moves back either. The script exists for
  monotonic writes, not pruning, and touches only `<prefix>tags`, so it runs on a Cluster; it is
  not a two-key script over the separately slotted index. This sets the floor at Redis 6.2
  (`ZADD GT`) with scripting allowed; Valkey has both. The batch send and the outage replay
  queue use the same path. There is no Cluster CI lane, so Cluster safety rests on a unit
  assertion that every EVAL/EVALSHA the tag store sends has `numkeys` 1 and names the hash
  (a CROSSSLOT error is impossible by construction). The two keys stay separate; any future
  command spanning both would need a shared hash tag, which this design avoids. The script is sent
  with EVALSHA and falls back to EVAL on NOSCRIPT, since a restart, failover or `SCRIPT FLUSH`
  empties the server's script cache; both suites flush it and check the write lands and the next
  one is EVALSHA again.
- An update Redis did not take (an error, or Redis down) stays queued in the process and is sent
  with the next update or on reconnect. Concurrent sends share the queue: whichever runs first
  takes all of it, and one that finds it empty sends nothing (`ZADD` with no member is an
  error). It is re-applied at send time, here and in Redis, so the replayed update is the newest
  one and reaches every instance as a new invalidation; the script keeps any record newer still. Before this a revalidation made during an
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
  bound inside one score is not expressible in a single `ZRANGEBYSCORE` without a read script or
  rank offsets, and the only ties are tags written by one update, which are read whole.
- The sync point is the reader's own start time, never the highest score read: a writer whose
  clock runs ahead would otherwise move it past a lagging writer's updates.

**Previous no-pruning policy (superseded by DEC-8).** A record matters while an entry created before
its `stale` or `expired` time can still be stored: `check` expires an entry created before
`expired`, including one cached after the revalidation (the semantics `createCacheHandler` has had since the withdrawn 16.5.1, and Next's own). With
`revalidateTag(tag, "max")` (`expire` = 365 days) a record is still needed 365 days after the
revalidation plus the longest entry age, and with a larger custom `expire` longer still. An
earlier round pruned at 366 and then 731 days, which needed a clamp on `expired`, a margin for
clock skew and per-key Lua compare-and-delete scripts so a prune could not delete a tag another
instance was revalidating at that moment. (The one script left, the monotonic write above,
deletes nothing.) Each was a correctness hazard on its own (a pruned
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
with the entries they invalidate. The prerendered build output on disk outlives the flush, and
with its tag records gone it would read as never invalidated: a restarted instance would serve
day-0 content again and write it to Redis. So the flush then writes one record, `__cch_flush__`
(`__cch_flush__:<buildId>` for `scope: "build"`), through the normal tag update (script, index,
sync), and the page handler adds both fields to the HMGET it already sends for build output's
tags and to the tags of the copy it writes to Redis. Build output from before the flush is a miss
on every instance; a build made after it is not affected. There is no automatic or
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
- A revalidation with durations expires every entry older than its `expired` deadline once that
  deadline passes, including entries rendered after the revalidation. That is Next 16.4.2's own
  `areTagsExpired` (`expired > timestamp && expired <= now`), used by its default `"use cache"`
  handler and by `FileSystemCache`. We match it on purpose, so a deploy behaves the same with or
  without this package. The legacy `createCacheHandler` data cache's event-time rule (ISSUE-1) is not carried over.

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
Redis it is kept in process memory. Header tags count for `PAGES` as for `APP_PAGE` and `APP_ROUTE`, in Redis
and from disk, matching `FileSystemCache`'s own check (next@16.4.2's reader returns no `PAGES`
headers from disk, but the value type and the check allow them). The Redis key is build-scoped like every other entry. The build
writes no `cacheControl` to `.meta`, so a build-output entry revalidated with `{ expire }` is a miss
rather than served stale; Next takes its schedule from the prerender manifest as it does for its own
`FileSystemCache`.

The build output's `lastModified` is not the files' mtime, which Next's own reader uses: a copy
without `-p` moves it forward past revalidations made before the deploy, and reproducible builds
set it to 1970. During `next build` (`NEXT_PHASE=phase-production-build`) the page handler writes
`<distDir>/server/cache-handler-build.json` = `{ buildTime, buildId }` the first time it is
constructed once `BUILD_ID` exists; Next cleans `distDir` before compiling and writes `BUILD_ID`
before static generation, so the stamp predates every prerender of that build. The earlier
construction, while collecting page data, writes `{ buildTime }` without the ID; that time is
replaced, not kept, when the ID is added, because a compile-to-prerender gap longer than
`1.5 × revalidate` would otherwise ship output already past its window. A stamp naming
another build is replaced at build time and ignored at runtime. Without a valid stamp the age is
unknown, so build output is served only for a `revalidate: false` route none of whose tags (or
flush barriers) has any record, with `lastModified` the read time. Next writes nothing with a
reliable render time: `next build` puts no timestamp in `.meta`, and `routeCacheLastModified` is
set only when `FileSystemCache` promotes a seed at runtime (next@16.4.2
file-system-cache.js), so its reader falls back to the mtime.

A time-based route's build output is served only while `buildTime + min(1.5 × revalidate,
expire)` has not passed, read once from `prerender-manifest.json` (`initialRevalidateSeconds`,
`initialExpireSeconds`), and written to Redis for what is left of that window. Without this, once
a regenerated entry's TTL ran out (or it was evicted, or flushed with `scope: "build"`) the
build-time copy came back, possibly months old, where Next's own cache would serve the latest
regeneration it had flushed to disk. A route the manifest does not list is a miss.

**The handlers load on the edge runtime and do nothing there.** Next bundles the page
`cacheHandler` into the edge middleware too (`OPTIONAL_IMPORT:incrementalCacheHandler`,
next/dist/build/templates/middleware.js). On the edge runtime `node:module`, `node:fs` and
`node:path` are stubs whose exports throw when called (`__import_unsupported`,
next/dist/server/web/globals.js), and `connection.ts` called `createRequire(import.meta.url)` while
it was evaluated, so the middleware threw and every request was a 500. Deferring the call was not
enough: Turbopack's edge chunks fail when a `node:` module is LOADED (`Failed to load external
module node:module: TypeError: Native module not found`, at module evaluation), so a static
`import { createRequire } from "node:module"` alone still took every request down. Now no module
in the graph of `entries/page`, `remote` or `default` imports a `node:` specifier or a package:
built-ins come from `process.getBuiltinModule` on first use (`shared/node-require.ts`, which
creates `require` from it to load ioredis and Next's `FileSystemCache`). That needs Node 22.3, so
`engines` is `>=22.3.0` (Next 16 itself needs 20.9; a dynamic `import("node:module")` fallback
would be async and is the same load Turbopack rejects). `entries/node-imports.test.ts` walks the
entries' graph as `tsc` emits it and fails on any external import, and `entries/edge.test.ts`
mocks every `node:` module to throw on import, as Turbopack does. Under `NEXT_RUNTIME=edge` the page handler's `get` returns `null` and `set`,
`revalidateTag` and `delete` do nothing; the data handlers are the miss handler; Redis is never
used.

A client the application passes in is never reconfigured, patched, quit or disconnected. The
package reaches it through a proxy that bounds its own commands by `commandTimeout`. After 3
timeouts in a row, the connection reports not ready for 2 s, so the handlers use the memory
fallback. A successful command after that marks it ready again. A reply that arrives after its own
timeout fired is ignored: it neither resets the count nor marks the connection ready, so a server
answering every command in 1.5 s against a 1 s timeout is still dropped.

A connection the package opened is dropped (`disconnect(true)`) after `maxConsecutiveTimeouts`
command timeouts in a row, counted by wrapping `sendCommand`. ioredis kept the timed-out commands
and resent them through `sendCommand` on the next `ready` (`autoResendUnfulfilledCommands`,
ioredis/built/redis/event_handler.js). Their promises had already been rejected, so each resend
counted at once as another timeout: with 3 or more stalled together, every reconnect was dropped
again, every ~200 ms, and Redis never came back (reproduced with `docker pause` during concurrent
5 MB GETs). Now the client never resends (its callers have long since had their timeout and
moved on, and a resent 5 MB GET only adds load to a recovering server), and the wrapper counts
each command object once. Either alone fixes the flap; both are kept, the second for redirections
and for applications that turn resending back on through `redisOptions`. `connection.stats()`
(internal) counts timeouts and drops for tests.

That one connection is also why large values need bandwidth: at the 1000 ms default a 5 MB value
needs about 40 Mbit/s, and the commands queued behind a slower transfer time out with it. On such
links `commandTimeout` must be raised (documented next to the option). Compressing entries of
16 KB and more (DEC-4) cuts the bytes on the wire by 6-13x on page entries.

A tag write Redis refuses while the connection stays up (`OOM` under `noeviction`, `READONLY` or
`LOADING` during a failover, one timeout) stays queued and is sent again by the next sync, at most
100 ms later under traffic, not only by the next revalidation or reconnect. An `update` whose tags
another concurrent send already took resolves only once that batch is answered.

Entries are scoped by build (`<prefix><buildId>:page:` / `:data:`). Tag records are not, so a
revalidation reaches every build that is still running. `createCacheHandler` keeps its own key
layout.

## DEC-2: Restore the ISR `cacheHandler` exports; fix them rather than remove them (16.5.1)

16.5.1 was later withdrawn from npm; this content ships in 16.4.3.

**Status:** Accepted · **Date:** 2026-10-19 · Supersedes DEC-1's removal

DEC-1 removed the ISR handlers in 16.5.0, a minor version. The package version tracks Next.js, so
consumers use `^16.x` ranges, and public projects (e.g. templates importing `RedisCacheHandler`)
started failing to build on a fresh install. Next.js is also not dropping `cacheHandler`: it is the
current option for ISR, route handlers and (since 16.2) optimized images.

16.5.1 restores the ISR exports unchanged, and `isrHandlerPath` in the next.config helpers. They are
not deprecated. The Next 16 contract gaps DEC-1 lists remain and are tracked as a follow-up fix
(closed PR #74 has a starting point). Breaking removals only happen in a major version.


## DEC-1: Drop the legacy ISR `cacheHandler`; the package is "use cache"-only (16.5.0)

16.5.0 was later withdrawn from npm; 16.4.3 ships DEC-2's restored exports instead.

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
