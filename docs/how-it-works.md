# How it works

What `withCache` sets up, how invalidation reaches every instance, how pages and route handlers
are cached, and what happens when Redis goes down. Setup is in the
[README](../README.md#quick-start) and the [installation guide](./installation.md).

## What goes where

`withCache` merges these settings into the config you pass:

| Next.js setting | Points at | What it does |
|---|---|---|
| `cacheHandler` (singular) | the page handler (`RedisCacheHandler`) | Page shells (`APP_PAGE`), route handler responses (`APP_ROUTE`) and cached `fetch` (`FETCH`) are stored in Redis. It honours `x-next-cache-tags`, soft tags, `cacheControl` and `revalidateTag(tag, { expire })`. |
| `cacheHandlers.remote` | the remote handler (`createRemoteCacheHandler`) | `"use cache: remote"` entries are stored in Redis, shared by every instance. |
| `cacheHandlers.default` | the local handler (`createLocalCacheHandler`) | `"use cache"` values are kept in each instance's memory. Tag invalidation still reaches every instance ([how](#distributed-tag-coordination-for-use-cache)). |
| `cacheMaxMemorySize: 0` | — | Has no effect on caching here. It sizes the memory LRU inside Next's own file-system page cache, which Next does not use once `cacheHandler` is set, and Next's built-in `"use cache"` handler, which `cacheHandlers` replaces. Without `withCache`, `0` in production turns Next's built-in `"use cache"` handler into a no-op. |

What you get without configuring anything:

- **One Redis connection per process**, shared by every handler. It is registered on
  `globalThis`, so Next loading the handler modules more than once never opens a second one.
- **Entries scoped by build.** Entries live under the build ID that wrote them, or the deployment
  ID when one is set ([skew protection](#skew-protection-and-the-deployment-id)), so a deploy
  never serves the previous build's pages or RSC payloads. Tag records sit above the build ID, so
  a `revalidateTag` during a rolling deploy reaches the old build and the new one.
- **No Redis during `next build`.** The build uses memory and never connects to or waits on Redis.
- **Outages absorbed.** The app keeps serving from per-instance memory, each entry kept there for
  at most 60 s. Errors are logged at most once a minute, not once per request. When Redis comes
  back, that memory is dropped and Redis is authoritative again ([table](#when-redis-goes-down)).
- **Fast failure.** A command times out after 1 s. A connection that times out 3 times in a row
  is dropped and redialled. At startup a handler waits at most 500 ms for the first connection.
- **A compact binary format.** Entries are stored as raw bytes rather than base64 JSON: about 25%
  less Redis memory and network, and a page shell `get` about 40% faster. Entries of 16 KB and
  more are also Brotli-compressed, usually 5 to 15 times smaller (`CACHE_COMPRESSION`; the format
  is described in [Redis Configuration](./redis.md#entry-format-and-compression)).
- **Prerendered pages survive a restart.** On a miss, prerendered pages and route handlers are
  served from the build output in `.next` until their revalidate window runs out
  ([details](#pages-and-route-handlers)).

### Skew protection and the deployment ID

When an app sets a deployment ID for skew protection (`deploymentId` in `next.config`, or the
`NEXT_DEPLOYMENT_ID` environment variable) and no `generateBuildId`, Next 16 gives every build the
same constant `BUILD_ID`. Scoping by `BUILD_ID` would then put every deploy in one namespace, and
a new deploy could serve a page shell from an earlier build that links CSS and JS the new build no
longer has.

So when a deployment ID is set, entries are scoped by it instead. It is read from the same build
output as the `BUILD_ID`: `deploymentId` in a standalone server's config or in
`.next/required-server-files.json`, then `NEXT_DEPLOYMENT_ID` (which is where Next keeps it with
`experimental.runtimeServerDeploymentId`). An empty value counts as unset. The ID is
percent-encoded in keys, so `dpl_abc` stays `dpl_abc` and a `:` becomes `%3A`. Nothing needs
configuring; give each deploy its own deployment ID, as skew protection already requires. An
explicit `buildId` option on a handler or `flushCache` still replaces it.

A `flushCache()` run from a separate script (not inside the running app) resolves the scope the
same way, from its own working directory and environment. With
`experimental.runtimeServerDeploymentId` the build output holds no ID, so give that script the
same `NEXT_DEPLOYMENT_ID` as the servers, or pass `buildId`: otherwise it flushes the `BUILD_ID`
scope, finds nothing, and still succeeds.

## Distributed tag coordination for `"use cache"`

Plain `"use cache"` keeps its values in each instance's memory, which is what Next intends for
it. Invalidation is still shared, following Next's
[Distributed Tag Coordination](https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers#distributed-tag-coordination)
pattern:

- **Values live in per-instance memory**: an LRU of up to 10,000 entries and 32/98 of the
  memory budget, a share of the heap ([Memory](./operations.md#memory)). Like Next's built-in
  handler, a value is dropped once its `revalidate` period has passed, and the next request
  renders it again.
- **`updateTags` writes the invalidation to Redis**: one script call (`EVALSHA`) that merges it
  into the tag hash (a `stale,expired` timestamp record per tag) and one `ZADD GT` into the tag
  index, however many tags it carries. Both only move a record forward, so a write delayed in
  transit never undoes a newer revalidation from another instance.
- **`refreshTags` syncs once per request**, at most every 100 ms. Next calls it before the first
  `"use cache"` read. It reads the index for tags updated since the last sync (minus 5 s for clock
  skew), then fetches only those records with one `HMGET` and copies them into local state. While
  nothing changes, that is a single `ZRANGEBYSCORE`. Concurrent requests share one sync.
- **`getExpiration` reads only local state**, so there is no Redis call per cache lookup. It
  returns the most recent time any of the tags was invalidated.

So `revalidateTag` on instance A also invalidates B's memory copy.

The page handler and the remote handler use the same per-process tag store. Both are stricter
than `"use cache"`: Next reads the page handler before it calls any `refreshTags`, so the page
and remote handlers check the tag records in Redis on every read, and a failed tag read is a miss
([Pages and route handlers](#pages-and-route-handlers)). Next calls `updateTags` on every handler
and then the page handler's `revalidateTag` for one `revalidateTag()` call. Identical updates in
the same synchronous run are written to Redis once; a later identical update is written again.

Limits worth knowing:

- During a Redis outage only local tags apply. An invalidation made then reaches its own instance
  first, and a warning is logged; it is sent to Redis when the connection is back, as a fresh
  revalidation. Until a `"use cache"` instance has synced since it (re)connected, its memory
  values are misses rather than possibly stale hits.
- A process's first sync reads every tag in the index, 1,000 per round trip, paging by score so
  a tag revalidated mid-sync can never push another out of reach. After that it reads only what
  changed. Background maintenance removes only records too old to affect a live entry.
- **Tag retention:** no entry is kept or served past 365 days. A tag record is eligible for
  removal 365 days plus 10 seconds after the later of its last update and its hard expiration
  deadline. A custom delayed revalidation extends retention by its full duration; `"max"`
  therefore needs about two years. Flush barriers are kept permanently.
- **Redis 7.4+ and Valkey 9+** expire tag hash fields themselves. Support is probed once per
  connection in the background, by command capability rather than server version. Subsequent
  writes set the merged record's field deadline atomically in the existing write script.
  Startup writes use the same guarded script before the prompt background probe completes, so
  they cannot strip a supported server's field TTL. A failed probe selects the fallback; a
  transient failure is retried once on the next connection-ready event.
- **Standalone Redis / Valkey** also checks up to 1,000 old index members once per minute,
  atomically deleting eligible hash records and index members. It checks the record's deadline
  too, so a concurrent revalidation is preserved. Maintenance adds no request-path command and
  stops with `closeCache()`. With `CACHE_DEBUG=1`, its `tag retention` line reports `pruned`,
  `tagFields` and `tagIndexMembers` without an extra command.
- **Cluster limitation:** the existing hash and index may occupy different slots. Automatic
  fallback pruning is skipped on Cluster or after `CROSSSLOT`. Without hash-field TTL support,
  tag records grow until `flushCache({ scope: "all" })`, with a warning at most hourly by
  default. On a supported Cluster the hash fields expire, but index members remain until a flush; syncing
  an expired field returns no record, which is safe after its full retention window. `tag-index`
  grows by one small member per distinct revalidated tag until a flush. Standalone gets the
  full prune; existing fields written by an older package gain a TTL only on a later update.
- **Unstamped build output:** build output with no surviving stamp can come back after its
  tag record is pruned. This only happens to a deployment serving the same build for over
  365 days after the tag's last invalidation. Redeploy or flush within a year. Missing-stamp
  behavior is unchanged; Next's standalone packaging may omit the stamp.
- Instances' clocks may differ by up to 5 s. A larger skew can delay an invalidation on other
  instances until the tag is invalidated again.
- Times are wall time, read without touching `Date` inside a prerender. If another library has
  replaced `Date` (fake timers, `timekeeper`, some APM agents) and Next's prerender state cannot
  be seen, the package does not read `Date` at all and keeps the process's performance clock, as
  Next's own handlers do. That is safe, but that instance's times can drift from the others'
  over a long uptime.

## Pages and route handlers

The page handler implements Next 16's singular `cacheHandler` contract:

- **Lifetime.** An entry is kept for `1.5 × revalidate`, capped at the profile's `expire`. That
  keeps a stale-while-revalidate window without keeping dead pages forever. An entry with `expire`
  but no `revalidate` is kept for `expire`. With neither, it is kept for `defaultTTL` (365 days).
  Nothing is kept or served longer than 365 days.
- **Tags, checked in Redis on every read.** A `get` sends the entry `GET` together with one
  `HMGET` of every tag record that applies: the soft tags (`revalidatePath`'s implicit path tags),
  the `fetch` tags, and the entry's own tags (the `x-next-cache-tags` header) as this process last
  saw them. They go out in one round trip, so a revalidation on any instance is seen by the very
  next read at no extra latency. The first time a process reads an entry it did not write, it
  learns the entry's tags from the entry itself, so that read takes a second round trip (one more
  `HMGET`). While Redis is down, pages are checked against local tag state: every record a `get`
  has read, kept current by the `"use cache"` handlers' `refreshTags` sync.
- **`revalidateTag(tag, "max")`** (or any `{ expire }`) leaves the page servable until `expire`:
  it is served once more and regenerated in the background. `revalidateTag(tag)`, `updateTag` and
  `revalidatePath` make it a miss. A page without a `revalidate` period cannot be served stale, so
  it is a miss either way.
- **Schedule.** A page's `cacheControl` is stored with it, so an instance that did not render the
  page revalidates it on the page's own schedule.
- **Prerendered routes are served from the build output.** `next build` writes prerendered pages
  and route handlers (sitemaps, robots, manifests) to disk only. On a miss the handler reads them
  through Next's own `FileSystemCache`, checks their tags with `lastModified` = the build time (a
  tag or path revalidated since the build wins, and so does a `flushCache`), then writes them to
  Redis unless an entry is already there. A route with a revalidate period is served from the
  build output only within `1.5 × revalidate` (capped at `expire`) of the build, as long as a
  render of it would be kept; after that a miss renders it. A dynamic route's prerendered fallback
  shell (partial prerendering) is served the same way, with the route's `fallbackRevalidate` and
  `fallbackExpire`. The build output is read from disk, so this holds after a restart or on a
  fresh instance too. While Redis is down it is not served, because its tags cannot be checked.
  The build time is not the files' mtime: the page handler writes `cache-handler-build.json` into
  `.next/server` when static generation starts, so ship that file with the build. Without it the
  build output is served only for `revalidate: false` routes none of whose tags was ever
  revalidated.
- **Edge middleware.** Next bundles this handler into the middleware too. On the edge runtime it
  imports without touching Node built-ins and does nothing: every read is a miss.
- Cached `fetch` entries share the `page:` key namespace.

## When Redis goes down

| Situation | Reads | Writes | `revalidateTag` |
|---|---|---|---|
| `next build` | memory | memory | memory |
| Redis down at boot | memory (each entry at most 60 s) | memory | applied locally, with a warning: other instances keep their copy until it ages out |
| Redis lost mid-run | the same; switches within one command timeout | the same | the same |
| Redis stalled (accepts, never answers) | 1 s timeout per command → miss; after 3 timeouts in a row, drop and redial → memory (a [client you pass in](./custom-handlers.md) is never dropped: memory for 2 s at a time instead) | the same | the same |
| Redis back | Redis; the outage memory is dropped | Redis | Redis and local |

A request never fails because of the cache. A cache error is always a miss plus a rate-limited log
line. With `memoryFallback: false` in a [custom handler](./custom-handlers.md), reads and writes
made during an outage are misses instead.
